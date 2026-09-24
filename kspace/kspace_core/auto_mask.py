import numpy as np

from .metrics import mse, nrmse, psnr
from .noise import add_kspace_noise
from .sampling.cartesian import cartesian_mask
from .sampling.radial import radial_mask
from .sampling.optimized import (
    mask_from_row_score,
    mask_from_score,
    random_lines_score,
    variable_density_score,
)

# Metrics where a *smaller* value means a better (less-degraded)
# reconstruction. PSNR is the odd one out: bigger is better.
_LOWER_IS_BETTER = {"mse": True, "nrmse": True, "psnr": False}

# psnr() returns float("inf") for a pixel-perfect reconstruction, which
# can't be compared arithmetically against a finite target. Standing in a
# large-but-finite value keeps every comparison below well-defined.
_PSNR_CEILING = 300.0

FAMILIES = ("variable_density", "random_lines", "cartesian", "radial")


def _compute_metric(name, reference, recon):
    if name == "mse":
        return float(mse(reference, recon))
    if name == "nrmse":
        return float(nrmse(reference, recon))
    if name == "psnr":
        value = psnr(reference, recon)
        return _PSNR_CEILING if np.isinf(value) else float(value)
    raise ValueError(f"unknown metric '{name}'")


def _mask_builder(family, shape, center_fraction, seed):
    rows, cols = shape
    if family == "variable_density":
        score = variable_density_score(shape, seed=seed)
        return lambda d: mask_from_score(score, d, center_fraction)
    if family == "random_lines":
        row_score = random_lines_score(rows, seed=seed)
        return lambda d: mask_from_row_score(row_score, shape, d, center_fraction)
    if family == "cartesian":
        return lambda d: cartesian_mask(
            shape, acceleration=max(1.0, 1.0 / max(d, 1e-6)), center_fraction=center_fraction
        )
    if family == "radial":
        return lambda d: radial_mask(shape, acceleration=max(1.0, 1.0 / max(d, 1e-6)))
    raise ValueError(f"unknown mask family '{family}'. Choose one of {FAMILIES}.")


def search_target_mask(
    kspace,
    reference_image,
    reconstruct_fn,
    shape,
    metric,
    target_value,
    family="variable_density",
    center_fraction=0.04,
    noise_level=0.0,
    noise_seed=42,
    seed=7,
    max_iterations=24,
    tolerance=None,
    min_density=None,
):
    """
    Find the undersampling mask (from `family`) whose reconstruction gets as
    close as possible to a user-specified target error (`metric` /
    `target_value`), by binary-searching sampling density.

    Why bisection works: for a mask family built by re-thresholding one fixed
    score field (see kspace_core/sampling/optimized.py), raising the density
    only ever *adds* k-space points to the previous mask, never removes any.
    More measured k-space can only add information, so the reconstruction
    error is monotonic in density — mse/nrmse fall (and psnr rises) as
    density goes from `min_density` to 1.0. That monotonicity is what makes
    bisection converge on the right density in O(log2(1/precision)) trial
    reconstructions, instead of a brute-force sweep over hundreds of masks.

    Returns a dict with: mask, recon, density, value (the achieved metric
    value), iterations, achievable (False if the target was outside the
    range spanned by [min_density, 1.0] and was clamped to the nearer end),
    and history (the (density, value) pairs tried, for diagnostics).
    """
    if metric not in _LOWER_IS_BETTER:
        raise ValueError(f"unknown metric '{metric}'. Choose one of {tuple(_LOWER_IS_BETTER)}.")

    rows, cols = shape
    if min_density is None:
        min_density = min(0.5, max(center_fraction * 1.5, 2.0 / max(rows, cols)))
    min_density = float(np.clip(min_density, 1e-4, 1.0))

    if tolerance is None:
        tolerance = {"mse": 1e-6, "nrmse": 1e-3, "psnr": 0.1}[metric]

    build = _mask_builder(family, shape, center_fraction, seed)
    lower_is_better = _LOWER_IS_BETTER[metric]
    is_multicoil = kspace.ndim == 3

    # Noise is drawn once (same seed every trial) so the only thing that
    # changes between trials is which points the mask keeps — otherwise a
    # fresh noise draw at every density would break the monotonicity the
    # bisection depends on.
    noisy_kspace = add_kspace_noise(kspace, noise_level, noise_seed)

    def evaluate(density):
        mask = build(density)
        acquired = noisy_kspace * (mask[None, :, :] if is_multicoil else mask)
        recon = reconstruct_fn(acquired)
        value = _compute_metric(metric, reference_image, recon)
        return value, mask, recon

    def signed_err(value):
        # Recast both directions as "smaller = worse", so density always
        # moves signed_err down regardless of which metric was requested.
        return value if lower_is_better else -value

    target_err = signed_err(target_value)

    lo, hi = min_density, 1.0
    val_lo, mask_lo, recon_lo = evaluate(lo)
    val_hi, mask_hi, recon_hi = evaluate(hi)
    err_lo, err_hi = signed_err(val_lo), signed_err(val_hi)

    history = [
        {"density": lo, "value": val_lo},
        {"density": hi, "value": val_hi},
    ]

    best_density, best_value, best_mask, best_recon = lo, val_lo, mask_lo, recon_lo
    best_diff = abs(val_lo - target_value)
    if abs(val_hi - target_value) < best_diff:
        best_density, best_value, best_mask, best_recon = hi, val_hi, mask_hi, recon_hi
        best_diff = abs(val_hi - target_value)

    achievable = err_hi <= target_err <= err_lo
    iterations = 2

    if achievable and best_diff > tolerance:
        for _ in range(max_iterations):
            mid = (lo + hi) / 2.0
            val_mid, mask_mid, recon_mid = evaluate(mid)
            iterations += 1
            history.append({"density": mid, "value": val_mid})

            diff = abs(val_mid - target_value)
            if diff < best_diff:
                best_diff = diff
                best_density, best_value, best_mask, best_recon = mid, val_mid, mask_mid, recon_mid

            if signed_err(val_mid) > target_err:
                lo = mid  # still worse than the target -> need more density
            else:
                hi = mid  # already at least as good as the target -> pull back

            if (hi - lo) < 1e-4 or best_diff < tolerance:
                break

    return {
        "mask": best_mask,
        "recon": best_recon,
        "density": best_density,
        "value": best_value,
        "iterations": iterations,
        "achievable": achievable,
        "history": history,
        "min_density": min_density,
    }
