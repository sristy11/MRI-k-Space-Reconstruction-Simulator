from typing import Literal, Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from io_utils.image_loader import load_uploaded_image
from io_utils.h5_loader import load_h5_slice, get_num_slices
from io_utils.dataset_library import resolve_dataset_path
from kspace_core.fft import image_to_kspace, log_magnitude_spectrum
from kspace_core.sampling.cartesian import cartesian_mask
from kspace_core.sampling.radial import radial_mask
from kspace_core.sampling.random import random_mask
from kspace_core.reconstruct import reconstruct
from kspace_core.metrics import mse, psnr, nrmse


router = APIRouter(prefix="/pipeline", tags=["Pipeline"])


# ---------------------------------------------------------------------------
# Request models
#
# Two possible sources for the k-space data:
#   source="upload"  -> a PNG/JPG the user uploaded via /upload/; we build
#                       k-space ourselves from the image (forward FFT).
#   source="dataset" -> a real .h5 scan from data/datasets; k-space is already
#                       the measured data — there's nothing to "forward FFT",
#                       we just read it (see DatasetPreviewRequest below).
# ---------------------------------------------------------------------------

class SourceFields(BaseModel):
    source: Literal["upload", "dataset"] = "upload"
    filename: Optional[str] = None       # required when source == "upload"
    dataset: Optional[str] = None        # required when source == "dataset"
    slice_index: Optional[int] = None    # optional when source == "dataset"


class FFTRequest(SourceFields):
    pass


class MaskRequest(SourceFields):
    pattern: Literal["cartesian", "radial", "random", "custom", "full"]
    acceleration: int = Field(ge=1)
    acs: int = Field(default=12, ge=0)  # autocalibration lines (cartesian & random only)
    custom_mask: Optional[list] = None  # required when pattern == "custom": 2D array of 0/1


class DatasetPreviewRequest(BaseModel):
    dataset: str
    slice_index: Optional[int] = None


# ---------------------------------------------------------------------------
# Source resolution
# ---------------------------------------------------------------------------

def _normalize_for_display(array):
    """
    Scale a real-valued image to [0, 1] for rendering, using the image's own
    99.5th percentile rather than a fixed range. Uploaded photos are already
    pre-normalized to [0, 1] (harmless to renormalize), but raw .h5 k-space
    reconstructions can be on a completely different scale — clipping those
    to a fixed [0, 1] range crushes them to solid black or solid white
    regardless of actual content, the same dynamic-range issue we fixed for
    the k-space spectrum display.
    """
    vmax = np.percentile(array, 99.5)
    if vmax > 0:
        return np.clip(array / vmax, 0.0, 1.0)
    return np.clip(array, 0.0, 1.0)


def _load_uploaded(filename: Optional[str]):
    if not filename:
        raise HTTPException(status_code=400, detail="filename is required when source='upload'")
    try:
        return load_uploaded_image(filename)
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"No uploaded image named '{filename}'. Upload it via /upload/ first.",
        )


def _load_dataset_kspace(dataset: Optional[str], slice_index: Optional[int]):
    if not dataset:
        raise HTTPException(status_code=400, detail="dataset is required when source='dataset'")
    try:
        path = resolve_dataset_path(dataset)
        return load_h5_slice(str(path), slice_index)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


def _resolve_source(payload: SourceFields):
    """
    Returns (kspace, reference_image).

    kspace: complex ndarray — (rows, cols) for an uploaded PNG, or
            (coils, rows, cols) raw multi-coil k-space for a dataset slice.
    reference_image: the fully-sampled ground-truth magnitude image to
            compare reconstructions against.
    """
    if payload.source == "dataset":
        kspace = _load_dataset_kspace(payload.dataset, payload.slice_index)
        # fastMRI-style raw k-space is stored unshifted (DC at the corner).
        # reconstruct(shifted=True) does ifftshift -> ifft2; the standard
        # centered-recon convention then needs one more fftshift on the
        # output to spatially center the image (see kspace_core/reconstruct.py).
        reference_image = np.fft.fftshift(reconstruct(kspace, shifted=True))
        return kspace, reference_image
    else:
        image = _load_uploaded(payload.filename)
        kspace = image_to_kspace(image)  # already centered (fftshift applied inside)
        return kspace, image


def _reconstruct_from(kspace, source: str):
    """Inverse-FFT k-space back to an image, applying the extra centering
    fftshift that raw dataset k-space needs but synthesized PNG k-space doesn't
    (see _resolve_source's reference_image comment)."""
    recon = reconstruct(kspace, shifted=True)
    if source == "dataset":
        recon = np.fft.fftshift(recon)
    return recon


# Fixed seed for the random pattern: /mask and /reconstruct are separate
# requests that each rebuild the mask from scratch, so without a fixed seed
# the mask shown in the preview could differ from the one actually used to
# reconstruct. A constant seed keeps the two calls consistent.
RANDOM_MASK_SEED = 42


def _build_mask(shape, pattern: str, acceleration: int, acs: int, custom_mask=None):
    if pattern == "cartesian":
        rows = shape[0]
        center_fraction = (acs / rows) if rows else 0.0
        return cartesian_mask(shape, acceleration=acceleration, center_fraction=center_fraction)
    elif pattern == "radial":
        # radial_mask has no center_fraction knob — spokes already pass through
        # (and densely oversample) the center by construction, so `acs` doesn't
        # apply here. We accept it in the request for a uniform frontend, but ignore it.
        return radial_mask(shape, acceleration=acceleration)
    elif pattern == "random":
        rows = shape[0]
        center_fraction = (acs / rows) if rows else 0.0
        return random_mask(
            shape,
            acceleration=acceleration,
            center_fraction=center_fraction,
            seed=RANDOM_MASK_SEED,
        )
    elif pattern == "custom":
        if custom_mask is None:
            raise HTTPException(status_code=400, detail="custom_mask is required when pattern='custom'")
        arr = np.array(custom_mask, dtype=float)
        if arr.shape != tuple(shape):
            raise HTTPException(
                status_code=400,
                detail=f"custom_mask shape {arr.shape} doesn't match k-space shape {tuple(shape)}",
            )
        return arr
    elif pattern == "full":
        # No undersampling at all — every k-space point is kept, so this is
        # the baseline reconstruction to compare all the other patterns against.
        return np.ones(shape, dtype=float)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown sampling pattern '{pattern}'")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/dataset-preview")
async def preview_dataset_slice(payload: DatasetPreviewRequest):
    """Load a dataset slice's ground-truth reconstruction, for Canvas A —
    the equivalent of the instant client-side preview an uploaded photo gets."""
    path = resolve_dataset_path(payload.dataset) if payload.dataset else None
    if path is None:
        raise HTTPException(status_code=400, detail="dataset is required")

    try:
        num_slices = get_num_slices(path)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Could not read dataset '{payload.dataset}'")

    slice_index = payload.slice_index if payload.slice_index is not None else num_slices // 2
    kspace = load_h5_slice(str(path), slice_index)
    reference_image = np.fft.fftshift(reconstruct(kspace, shifted=True))

    return {
        "reference": _normalize_for_display(reference_image).tolist(),
        "num_slices": num_slices,
        "slice_index": slice_index,
    }


@router.post("/fft")
async def forward_fft(payload: FFTRequest):
    """Step A -> B: run (or fetch) the forward FFT to get full k-space."""
    kspace, _ = _resolve_source(payload)

    # For multi-coil dataset k-space, show one representative coil.
    display_kspace = kspace[0] if kspace.ndim == 3 else kspace
    kspace_full = log_magnitude_spectrum(display_kspace)  # normalized to [0, 1]

    return {
        "kspace_full": kspace_full.tolist(),
    }


@router.post("/mask")
async def apply_mask(payload: MaskRequest):
    """Step B -> C/D: build the sampling mask and apply it to k-space."""
    kspace, _ = _resolve_source(payload)
    mask = _build_mask(kspace.shape[-2:], payload.pattern, payload.acceleration, payload.acs, payload.custom_mask)

    undersampled_kspace = kspace * mask
    display_kspace = undersampled_kspace[0] if undersampled_kspace.ndim == 3 else undersampled_kspace
    kspace_under = log_magnitude_spectrum(display_kspace)

    return {
        "mask": mask.tolist(),
        "kspace_under": kspace_under.tolist(),
        "density": float(mask.mean()),
        "points_kept": int(mask.sum()),
    }


@router.post("/reconstruct")
async def run_reconstruct(payload: MaskRequest):
    """Step D -> E/F: inverse FFT the undersampled k-space and score it against the source image."""
    kspace, reference_image = _resolve_source(payload)
    mask = _build_mask(kspace.shape[-2:], payload.pattern, payload.acceleration, payload.acs, payload.custom_mask)
    undersampled_kspace = kspace * mask

    recon = _reconstruct_from(undersampled_kspace, payload.source)

    err_mse = float(mse(reference_image, recon))
    err_psnr = psnr(reference_image, recon)
    err_nrmse = float(nrmse(reference_image, recon))

    error_map = np.abs(reference_image - recon)
    err_max = float(error_map.max())
    error_display = (error_map / err_max) if err_max > 0 else error_map

    recon_display = _normalize_for_display(recon)

    return {
        "recon": recon_display.tolist(),
        "error": error_display.tolist(),
        "metrics": {
            "mse": err_mse,
            "psnr": None if np.isinf(err_psnr) else float(err_psnr),
            "nrmse": err_nrmse,
        },
    }