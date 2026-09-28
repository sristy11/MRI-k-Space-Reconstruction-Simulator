from fastapi import APIRouter, UploadFile, File, HTTPException
from pathlib import Path
import hashlib
import shutil
import uuid

import h5py
import numpy as np

from io_utils.dataset_library import DATASET_DIR


router = APIRouter(
    prefix="/upload",
    tags=["Upload"]
)


UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DATASET_DIR.mkdir(parents=True, exist_ok=True)


@router.post("/")
async def upload_image(file: UploadFile = File(...)):

    # Check that the uploaded file is an image
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(
            status_code=400,
            detail="Please upload an image file."
        )

    filename = Path(file.filename).name
    file_path = UPLOAD_DIR / filename

    with file_path.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {
        "message": "Image uploaded successfully",
        "filename": filename,
        "path": str(file_path)
    }


def _sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """Return a stable content fingerprint without loading the whole H5 into RAM."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _final_dataset_path(original_name: str, temp_path: Path, digest: str) -> tuple[Path, bool]:
    """
    Choose the persistent dataset path without producing duplicate copies.

    - Re-uploading the same file reuses the existing file.
    - A genuinely different file with the same filename receives a short,
      deterministic hash suffix rather than dataset-2/dataset-3/... copies.
    """
    original = Path(original_name).name
    stem = Path(original).stem or "dataset"
    suffix = Path(original).suffix.lower() or ".h5"
    preferred = DATASET_DIR / f"{stem}{suffix}"

    if preferred.exists():
        try:
            if preferred.stat().st_size == temp_path.stat().st_size and _sha256(preferred) == digest:
                return preferred, True
        except OSError:
            pass

        # Same name but different content: use a deterministic content suffix.
        candidate = DATASET_DIR / f"{stem}-{digest[:10]}{suffix}"
        if candidate.exists():
            try:
                if candidate.stat().st_size == temp_path.stat().st_size and _sha256(candidate) == digest:
                    return candidate, True
            except OSError:
                pass
        return candidate, False

    return preferred, False


def _validate_h5_kspace(path: Path):
    """
    Validate the subset of HDF5 that the reconstruction pipeline supports.

    Supported k-space layouts are:
      (slices, rows, cols)              single-coil
      (slices, coils, rows, cols)       multi-coil / fastMRI style
    """
    try:
        with h5py.File(path, "r") as h5:
            if "kspace" not in h5:
                raise HTTPException(
                    status_code=400,
                    detail="H5 file must contain a 'kspace' dataset.",
                )

            dataset = h5["kspace"]
            if dataset.ndim not in (3, 4):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Unsupported k-space shape. Expected "
                        "(slices, rows, cols) or (slices, coils, rows, cols)."
                    ),
                )

            if any(int(dim) <= 0 for dim in dataset.shape):
                raise HTTPException(status_code=400, detail="The 'kspace' dataset is empty.")

            if not np.issubdtype(dataset.dtype, np.complexfloating):
                raise HTTPException(
                    status_code=400,
                    detail="The 'kspace' dataset must contain complex-valued MRI k-space samples.",
                )

            return int(dataset.shape[0]), [int(v) for v in dataset.shape]
    except HTTPException:
        raise
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid H5/HDF5 file: {exc}")


@router.post("/h5")
async def upload_h5_dataset(file: UploadFile = File(...)):
    """
    Upload and validate a fastMRI-style H5 dataset for use in Studio.

    The upload is written once to a temporary file, validated, and then moved
    atomically into the dataset folder. Identical re-uploads reuse the existing
    dataset instead of creating filename-2.h5 / filename-3.h5 duplicates.
    """
    original_name = Path(file.filename or "dataset.h5").name
    suffix = Path(original_name).suffix.lower()
    if suffix not in {".h5", ".hdf5"}:
        raise HTTPException(
            status_code=400,
            detail="Please upload an .h5 or .hdf5 dataset file.",
        )

    temp_path = DATASET_DIR / f".upload-{uuid.uuid4().hex}{suffix}"
    digest = hashlib.sha256()
    total_bytes = 0

    try:
        # Stream in chunks. This avoids one long blocking copy and behaves much
        # more reliably for large MRI H5 files.
        with temp_path.open("wb") as buffer:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                buffer.write(chunk)
                digest.update(chunk)
                total_bytes += len(chunk)

        if total_bytes == 0:
            raise HTTPException(status_code=400, detail="The selected H5 file is empty.")

        num_slices, shape = _validate_h5_kspace(temp_path)
        fingerprint = digest.hexdigest()
        final_path, reused = _final_dataset_path(original_name, temp_path, fingerprint)

        if reused:
            temp_path.unlink(missing_ok=True)
        else:
            # os.replace semantics through Path.replace give us an atomic move
            # on the same filesystem.
            temp_path.replace(final_path)

        return {
            "message": "H5 dataset ready" if reused else "H5 dataset uploaded successfully",
            "filename": final_path.name,
            "num_slices": num_slices,
            "kspace_shape": shape,
            "reused": reused,
            "size_bytes": total_bytes,
        }
    finally:
        # Validation/network failures should never leave a hidden partial file.
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)
        await file.close()
