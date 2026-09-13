from typing import Literal, Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from io_utils.image_loader import load_uploaded_image
from kspace_core.fft import image_to_kspace, log_magnitude_spectrum
from kspace_core.sampling.cartesian import cartesian_mask
from kspace_core.sampling.radial import radial_mask
from kspace_core.sampling.random import random_mask
from kspace_core.reconstruct import reconstruct
from kspace_core.metrics import mse, psnr, nrmse


router = APIRouter(prefix="/pipeline", tags=["Pipeline"])


class FFTRequest(BaseModel):
    filename: str


class MaskRequest(BaseModel):
    filename: str
    pattern: Literal["cartesian", "radial", "random"]
    acceleration: int = Field(ge=1)
    acs: int = Field(default=12, ge=0)  # autocalibration lines (cartesian & random only)


def _load_image(filename: str):
    try:
        return load_uploaded_image(filename)
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"No uploaded image named '{filename}'. Upload it via /upload/ first.",
        )


# Fixed seed for the random pattern: /mask and /reconstruct are separate
# requests that each rebuild the mask from scratch, so without a fixed seed
# the mask shown in the preview could differ from the one actually used to
# reconstruct. A constant seed keeps the two calls consistent.
RANDOM_MASK_SEED = 42


def _build_mask(shape, pattern: str, acceleration: int, acs: int):
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
    else:
        raise HTTPException(status_code=400, detail=f"Unknown sampling pattern '{pattern}'")


@router.post("/fft")
async def forward_fft(payload: FFTRequest):
    """Step A -> B: load the uploaded image and run the forward FFT to full k-space."""
    image = _load_image(payload.filename)
    kspace = image_to_kspace(image)
    kspace_full = log_magnitude_spectrum(kspace)  # normalized to [0, 1] for display

    return {
        "kspace_full": kspace_full.tolist(),
    }


@router.post("/mask")
async def apply_mask(payload: MaskRequest):
    """Step B -> C/D: build the sampling mask and apply it to k-space."""
    image = _load_image(payload.filename)
    kspace = image_to_kspace(image)
    mask = _build_mask(kspace.shape, payload.pattern, payload.acceleration, payload.acs)

    undersampled_kspace = kspace * mask
    kspace_under = log_magnitude_spectrum(undersampled_kspace)

    return {
        "mask": mask.tolist(),
        "kspace_under": kspace_under.tolist(),
        "density": float(mask.mean()),
        "points_kept": int(mask.sum()),
    }


@router.post("/reconstruct")
async def run_reconstruct(payload: MaskRequest):
    """Step D -> E/F: inverse FFT the undersampled k-space and score it against the source image."""
    image = _load_image(payload.filename)
    kspace = image_to_kspace(image)
    mask = _build_mask(kspace.shape, payload.pattern, payload.acceleration, payload.acs)
    undersampled_kspace = kspace * mask

    recon = reconstruct(undersampled_kspace, shifted=True)

    err_mse = float(mse(image, recon))
    err_psnr = psnr(image, recon)
    err_nrmse = float(nrmse(image, recon))

    error_map = np.abs(image - recon)
    err_max = float(error_map.max())
    error_display = (error_map / err_max) if err_max > 0 else error_map

    recon_display = np.clip(recon, 0.0, 1.0)

    return {
        "recon": recon_display.tolist(),
        "error": error_display.tolist(),
        "metrics": {
            "mse": err_mse,
            "psnr": None if np.isinf(err_psnr) else float(err_psnr),
            "nrmse": err_nrmse,
        },
    }