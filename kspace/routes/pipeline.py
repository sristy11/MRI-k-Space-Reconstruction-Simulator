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
from kspace_core.noise import add_kspace_noise, approx_snr_db
from kspace_core.auto_mask import search_target_mask


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
    # Noise simulation: complex Gaussian noise added to k-space, as a % of the
    # k-space signal RMS. 0 = noise off (default, so existing clients are unaffected).
    noise_level: float = Field(default=0.0, ge=0.0, le=100.0)
    # Fixed seed so /mask and /reconstruct see the *same* noise realization.
    # Change it to draw a fresh realization.
    noise_seed: int = 42


class DatasetPreviewRequest(BaseModel):
    dataset: str
    slice_index: Optional[int] = None


class AutoMaskRequest(SourceFields):
    """
    Instead of choosing a sampling pattern directly, the user states the
    reconstruction error they're willing to accept and we search for the
    undersampling mask that gets closest to it. See kspace_core/auto_mask.py
    for how the search works.
    """
    metric: Literal["psnr", "nrmse", "mse"]
    target_value: float
    family: Literal["variable_density", "random_lines", "cartesian", "radial"] = "variable_density"
    center_fraction: float = Field(default=0.04, ge=0.0, le=0.5)
    noise_level: float = Field(default=0.0, ge=0.0, le=100.0)
    noise_seed: int = 42
    tolerance: Optional[float] = Field(default=None, gt=0.0)
    max_iterations: int = Field(default=24, ge=1, le=60)
    seed: int = 7


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
        if arr.ndim != 2 or arr.size == 0:
            raise HTTPException(
                status_code=400,
                detail="custom_mask must be a non-empty 2D array of 0/1 values",
            )
        target = tuple(int(v) for v in shape)
        if arr.shape != target:
            # The painted grid normally already matches k-space (the frontend
            # sizes its canvas from the loaded k-space shape), but a dataset
            # slice can change shape between painting and submitting. Rather
            # than rejecting the request, resample the painting onto the
            # k-space grid with nearest-neighbour so the mask stays usable.
            rows = np.minimum(
                (np.arange(target[0]) * arr.shape[0]) // target[0], arr.shape[0] - 1
            )
            cols = np.minimum(
                (np.arange(target[1]) * arr.shape[1]) // target[1], arr.shape[1] - 1
            )
            arr = arr[np.ix_(rows, cols)]
        return (arr > 0).astype(float)
    elif pattern == "full":
        # No undersampling at all — every k-space point is kept, so this is
        # the baseline reconstruction to compare all the other patterns against.
        return np.ones(shape, dtype=float)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown sampling pattern '{pattern}'")


def _acquire(kspace, mask, payload: MaskRequest):
    """
    Simulate the scan: add receiver noise to k-space, then keep only the
    sampled points.

    Noise goes on BEFORE the mask because a scanner only measures the
    points it samples — the skipped points are zero, not noisy zero.
    (kspace + noise) * mask therefore matches real acquisition, and the
    noise level stays independent of the acceleration factor.
    """
    noisy = add_kspace_noise(kspace, payload.noise_level, payload.noise_seed)
    return noisy * mask


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

    undersampled_kspace = _acquire(kspace, mask, payload)
    display_kspace = undersampled_kspace[0] if undersampled_kspace.ndim == 3 else undersampled_kspace
    kspace_under = log_magnitude_spectrum(display_kspace)

    return {
        "mask": mask.tolist(),
        "kspace_under": kspace_under.tolist(),
        "density": float(mask.mean()),
        "points_kept": int(mask.sum()),
        "noise_level": payload.noise_level,
        "snr_db": approx_snr_db(payload.noise_level),
    }


@router.post("/reconstruct")
async def run_reconstruct(payload: MaskRequest):
    """Step D -> E/F: inverse FFT the undersampled k-space and score it against the source image."""
    kspace, reference_image = _resolve_source(payload)
    mask = _build_mask(kspace.shape[-2:], payload.pattern, payload.acceleration, payload.acs, payload.custom_mask)
    undersampled_kspace = _acquire(kspace, mask, payload)

    recon = _reconstruct_from(undersampled_kspace, payload.source)

    err_mse = float(mse(reference_image, recon))
    err_psnr = psnr(reference_image, recon)
    err_nrmse = float(nrmse(reference_image, recon))

    # Noise review: when noise is on, also score the SAME mask without noise,
    # so the readout can show exactly how much quality the noise cost.
    metrics_clean = None
    if payload.noise_level > 0:
        clean_recon = _reconstruct_from(kspace * mask, payload.source)
        clean_psnr = psnr(reference_image, clean_recon)
        clean_nrmse = float(nrmse(reference_image, clean_recon))
        # Full sampling without noise reproduces the reference exactly; float
        # rounding would otherwise report a meaningless ~300 dB. Call it ∞.
        clean_is_exact = np.isinf(clean_psnr) or clean_nrmse < 1e-9
        metrics_clean = {
            "mse": float(mse(reference_image, clean_recon)),
            "psnr": None if clean_is_exact else float(clean_psnr),
            "nrmse": clean_nrmse,
        }

    error_map = np.abs(reference_image - recon)
    err_max = float(error_map.max())
    error_display = (error_map / err_max) if err_max > 0 else error_map

    recon_display = _normalize_for_display(recon)

    return {
        "reference": _normalize_for_display(reference_image).tolist(),
        "recon": recon_display.tolist(),
        "error": error_display.tolist(),
        "metrics": {
            "mse": err_mse,
            "psnr": None if np.isinf(err_psnr) else float(err_psnr),
            "nrmse": err_nrmse,
        },
        "metrics_clean": metrics_clean,
        "noise_level": payload.noise_level,
        "snr_db": approx_snr_db(payload.noise_level),
    }


@router.post("/auto-mask")
async def auto_mask(payload: AutoMaskRequest):
    """
    Given a target reconstruction error (PSNR / NRMSE / MSE), search for the
    undersampling mask that gets closest to it and return everything /mask
    and /reconstruct would (mask, undersampled k-space, reconstruction,
    error map, metrics) in one call, plus how the search went.
    """
    kspace, reference_image = _resolve_source(payload)
    shape = kspace.shape[-2:]

    result = search_target_mask(
        kspace=kspace,
        reference_image=reference_image,
        reconstruct_fn=lambda ks: _reconstruct_from(ks, payload.source),
        shape=shape,
        metric=payload.metric,
        target_value=payload.target_value,
        family=payload.family,
        center_fraction=payload.center_fraction,
        noise_level=payload.noise_level,
        noise_seed=payload.noise_seed,
        seed=payload.seed,
        max_iterations=payload.max_iterations,
        tolerance=payload.tolerance,
    )

    mask = result["mask"]
    recon = result["recon"]

    err_mse = float(mse(reference_image, recon))
    err_psnr = psnr(reference_image, recon)
    err_nrmse = float(nrmse(reference_image, recon))

    error_map = np.abs(reference_image - recon)
    err_max = float(error_map.max())
    error_display = (error_map / err_max) if err_max > 0 else error_map
    recon_display = _normalize_for_display(recon)

    noisy = add_kspace_noise(kspace, payload.noise_level, payload.noise_seed)
    acquired = noisy * (mask[None, :, :] if kspace.ndim == 3 else mask)
    display_kspace = acquired[0] if acquired.ndim == 3 else acquired
    kspace_under = log_magnitude_spectrum(display_kspace)

    return {
        # Same shape as /mask + /reconstruct combined, so the frontend can
        # render it straight into the existing viewport canvases.
        "mask": mask.tolist(),
        "kspace_under": kspace_under.tolist(),
        "reference": _normalize_for_display(reference_image).tolist(),
        "recon": recon_display.tolist(),
        "error": error_display.tolist(),
        "density": float(mask.mean()),
        "points_kept": int(mask.sum()),
        "metrics": {
            "mse": err_mse,
            "psnr": None if np.isinf(err_psnr) else float(err_psnr),
            "nrmse": err_nrmse,
        },
        "target": {"metric": payload.metric, "value": payload.target_value},
        "achieved_value": result["value"],
        "achievable": result["achievable"],
        "iterations": result["iterations"],
        "family": payload.family,
        "noise_level": payload.noise_level,
        "snr_db": approx_snr_db(payload.noise_level),
    }

class FrequencyRequest(SourceFields):
    cutoff: float = Field(default=0.25, ge=0.0, le=1.0)


def frequency_masks(shape, cutoff):
    """Complementary radial masks on centered k-space; 1 reaches corners.

    fftfreq + fftshift puts DC exactly at rows//2, cols//2, including
    odd and rectangular arrays. Zero explicitly keeps no frequencies.
    """
    fy = np.fft.fftshift(np.fft.fftfreq(shape[0]))
    fx = np.fft.fftshift(np.fft.fftfreq(shape[1]))
    radius = np.hypot(fy[:, None], fx[None, :])
    maximum = float(radius.max())
    low = (radius <= cutoff * maximum).astype(float)
    if cutoff == 0:
        low[:] = 0
    return low, 1.0 - low


@router.post("/frequency-experiment")
async def frequency_experiment(payload: FrequencyRequest):
    """Isolate low/high frequencies of the full source, without sampling/noise."""
    kspace, reference = _resolve_source(payload)
    low, high = frequency_masks(kspace.shape[-2:], payload.cutoff)
    # One common intensity scale preserves brightness differences.
    scale = float(np.percentile(reference, 99.5)) or 1.0
    results = {}
    for name, mask in (("low", low), ("high", high)):
        acquired = kspace * mask
        image = _reconstruct_from(acquired, payload.source)
        results[name] = {
            "recon": np.clip(image / scale, 0, 1).tolist(),
            "mask": mask.tolist(),
            "density": float(mask.mean()),
        }
    return {"reference": np.clip(reference / scale, 0, 1).tolist(), **results}
