
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


# Create the /pipeline router
router = APIRouter(prefix="/pipeline", tags=["Pipeline"])


# Request data for uploaded images or datasets
class SourceFields(BaseModel):
    source: Literal["upload", "dataset"] = "upload"
    filename: Optional[str] = None
    dataset: Optional[str] = None
    slice_index: Optional[int] = None


# Request for the FFT step
class FFTRequest(SourceFields):
    pass


# Request for sampling/mask and reconstruction
class MaskRequest(SourceFields):
    pattern: Literal["cartesian", "radial", "random"]
    acceleration: int = Field(ge=1)
    acs: int = Field(default=12, ge=0)


# Request for previewing a dataset slice
class DatasetPreviewRequest(BaseModel):
    dataset: str
    slice_index: Optional[int] = None


# Normalize an image to [0, 1] for display
def _normalize_for_display(array):
    vmax = np.percentile(array, 99.5)

    if vmax > 0:
        return np.clip(array / vmax, 0.0, 1.0)

    return np.clip(array, 0.0, 1.0)


# Load an uploaded image
def _load_uploaded(filename: Optional[str]):
    if not filename:
        raise HTTPException(
            status_code=400,
            detail="filename is required when source='upload'"
        )

    try:
        return load_uploaded_image(filename)

    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"No uploaded image named '{filename}'. Upload it via /upload/ first.",
        )


# Load k-space from an H5 dataset
def _load_dataset_kspace(dataset: Optional[str], slice_index: Optional[int]):
    if not dataset:
        raise HTTPException(
            status_code=400,
            detail="dataset is required when source='dataset'"
        )

    try:
        path = resolve_dataset_path(dataset)
        return load_h5_slice(str(path), slice_index)

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# Get k-space and the reference image
def _resolve_source(payload: SourceFields):
    if payload.source == "dataset":

        # Load raw multi-coil k-space from the H5 file
        kspace = _load_dataset_kspace(
            payload.dataset,
            payload.slice_index
        )

        # Create the fully-sampled reference image
        reference_image = np.fft.fftshift(
            reconstruct(kspace, shifted=True)
        )

        return kspace, reference_image

    else:

        # Load the uploaded image
        image = _load_uploaded(payload.filename)

        # Convert image to k-space
        kspace = image_to_kspace(image)

        return kspace, image


# Reconstruct an image from k-space
def _reconstruct_from(kspace, source: str):

    # Apply inverse FFT
    recon = reconstruct(kspace, shifted=True)

    # Dataset k-space needs additional shifting
    if source == "dataset":
        recon = np.fft.fftshift(recon)

    return recon


# Fixed seed so random masks stay the same between requests
RANDOM_MASK_SEED = 42


# Create the selected sampling mask
def _build_mask(shape, pattern: str, acceleration: int, acs: int):

    if pattern == "cartesian":

        rows = shape[0]
        center_fraction = (acs / rows) if rows else 0.0

        return cartesian_mask(
            shape,
            acceleration=acceleration,
            center_fraction=center_fraction
        )

    elif pattern == "radial":

        # Radial sampling already passes through the center
        return radial_mask(
            shape,
            acceleration=acceleration
        )

    elif pattern == "random":

        rows = shape[0]
        center_fraction = (acs / rows) if rows else 0.0

        return random_mask(
            shape,
            acceleration=acceleration,
            center_fraction=center_fraction,
            seed=RANDOM_MASK_SEED,
        )

    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown sampling pattern '{pattern}'"
        )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/dataset-preview")
async def preview_dataset_slice(payload: DatasetPreviewRequest):

    # Find the dataset file
    path = resolve_dataset_path(payload.dataset) if payload.dataset else None

    if path is None:
        raise HTTPException(
            status_code=400,
            detail="dataset is required"
        )

    try:
        # Get number of slices
        num_slices = get_num_slices(path)

    except Exception:
        raise HTTPException(
            status_code=404,
            detail=f"Could not read dataset '{payload.dataset}'"
        )

    # Use requested slice or the middle slice
    slice_index = (
        payload.slice_index
        if payload.slice_index is not None
        else num_slices // 2
    )

    # Load the selected slice
    kspace = load_h5_slice(str(path), slice_index)

    # Reconstruct the fully-sampled image
    reference_image = np.fft.fftshift(
        reconstruct(kspace, shifted=True)
    )

    return {
        "reference": _normalize_for_display(reference_image).tolist(),
        "num_slices": num_slices,
        "slice_index": slice_index,
    }


@router.post("/fft")
async def forward_fft(payload: FFTRequest):

    # Get the full k-space
    kspace, _ = _resolve_source(payload)

    # For multi-coil data, display the first coil
    display_kspace = (
        kspace[0]
        if kspace.ndim == 3
        else kspace
    )

    # Convert k-space to a displayable image
    kspace_full = log_magnitude_spectrum(display_kspace)

    return {
        "kspace_full": kspace_full.tolist(),
    }


@router.post("/mask")
async def apply_mask(payload: MaskRequest):

    # Get the full k-space
    kspace, _ = _resolve_source(payload)

    # Create the selected sampling mask
    mask = _build_mask(
        kspace.shape[-2:],
        payload.pattern,
        payload.acceleration,
        payload.acs
    )

    # Remove the unsampled k-space points
    undersampled_kspace = kspace * mask

    # Display the first coil for multi-coil data
    display_kspace = (
        undersampled_kspace[0]
        if undersampled_kspace.ndim == 3
        else undersampled_kspace
    )

    # Create display version of undersampled k-space
    kspace_under = log_magnitude_spectrum(display_kspace)

    return {
        "mask": mask.tolist(),
        "kspace_under": kspace_under.tolist(),

        # Percentage of k-space points that were kept
        "density": float(mask.mean()),

        # Total number of points kept
        "points_kept": int(mask.sum()),
    }


@router.post("/reconstruct")
async def run_reconstruct(payload: MaskRequest):

    # Get full k-space and the original/reference image
    kspace, reference_image = _resolve_source(payload)

    # Create the same sampling mask
    mask = _build_mask(
        kspace.shape[-2:],
        payload.pattern,
        payload.acceleration,
        payload.acs
    )

    # Apply the mask
    undersampled_kspace = kspace * mask

    # Reconstruct image from undersampled k-space
    recon = _reconstruct_from(
        undersampled_kspace,
        payload.source
    )

    # Calculate reconstruction quality
    err_mse = float(mse(reference_image, recon))
    err_psnr = psnr(reference_image, recon)
    err_nrmse = float(nrmse(reference_image, recon))

    # Calculate pixel-by-pixel error
    error_map = np.abs(reference_image - recon)

    # Find the largest error
    err_max = float(error_map.max())

    # Normalize error map for display
    error_display = (
        error_map / err_max
        if err_max > 0
        else error_map
    )

    # Normalize reconstructed image for display
    recon_display = _normalize_for_display(recon)

    return {
        "recon": recon_display.tolist(),

        "error": error_display.tolist(),

        # Return numerical evaluation metrics
        "metrics": {
            "mse": err_mse,
            "psnr": None if np.isinf(err_psnr) else float(err_psnr),
            "nrmse": err_nrmse,
        },
    }

