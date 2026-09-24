import numpy as np

"""
"Auto" sampling families for the target-error search (kspace_core/auto_mask.py).

The existing patterns (cartesian/radial/random) are controlled by an integer
acceleration factor, which only gives a handful of achievable densities —
too coarse to hit an arbitrary user-requested error value. The masks here are
built from a fixed per-pixel (or per-row) *score* field, so that "sample
density d" just means "keep every point whose score is below the threshold
that admits a d fraction of points". Thresholding the same field at a looser
cutoff strictly grows the previous mask (it never removes an already-kept
point) — the sampling searched for the target error grows smoothly and
deterministically from the k-space center outward as density increases,
which is exactly the monotonic behaviour the binary search in auto_mask.py
relies on, and it makes density continuously tunable (any fraction, not just
1/acceleration) since we're picking a point count directly rather than
striding by an integer factor.
"""


def _radial_weight(rows, cols):
    """Normalized distance from the k-space center, in [0, 1]."""
    cy, cx = rows / 2.0, cols / 2.0
    yy, xx = np.mgrid[0:rows, 0:cols]
    dist = np.sqrt(((yy - cy) / rows) ** 2 + ((xx - cx) / cols) ** 2)
    m = dist.max()
    return dist / m if m > 0 else dist


def variable_density_score(shape, seed=None):
    """
    Point-wise score field for a 2D variable-density custom mask: low near
    the k-space center (so those points threshold in first), rising with
    distance and a random component (so, at any given radius, which exact
    points come in next is randomized rather than a uniform ring — the same
    "incoherent" sampling behaviour compressed-sensing masks look for).
    """
    rows, cols = shape
    rng = np.random.default_rng(seed)
    radial = _radial_weight(rows, cols)
    noise = rng.uniform(0.0, 1.0, size=shape)
    return radial * (0.15 + noise)


def random_lines_score(rows, seed=None):
    """Per-row score for a 1D (phase-encode line) variable-density mask."""
    rng = np.random.default_rng(seed)
    return rng.uniform(0.0, 1.0, size=rows)


def _center_block(rows, cols, center_fraction):
    """(r0, r1, c0, c1) of a centered block covering `center_fraction` of
    the shorter side — the always-sampled ACS-like region."""
    if center_fraction <= 0:
        return rows // 2, rows // 2, cols // 2, cols // 2
    cl = max(1, int(round(min(rows, cols) * center_fraction)))
    r0 = rows // 2 - cl // 2
    r1 = min(rows, r0 + cl)
    c0 = cols // 2 - cl // 2
    c1 = min(cols, c0 + cl)
    return r0, r1, c0, c1


def mask_from_score(score, density, center_fraction=0.04):
    """Threshold a 2D score field so ~`density` fraction of points are kept,
    always including the centered ACS-like block first."""
    rows, cols = score.shape
    density = float(np.clip(density, 0.0, 1.0))
    mask = np.zeros((rows, cols), dtype=np.float64)

    r0, r1, c0, c1 = _center_block(rows, cols, center_fraction)
    mask[r0:r1, c0:c1] = 1

    total = rows * cols
    target_points = int(round(density * total))
    remaining = target_points - int(mask.sum())
    if remaining <= 0:
        return mask

    ranked = score.copy()
    ranked[mask == 1] = np.inf  # already-kept points drop out of the ranking
    flat = ranked.ravel()
    available = flat.size - int(mask.sum())
    if remaining >= available:
        return np.ones((rows, cols), dtype=np.float64)

    idx = np.argpartition(flat, remaining)[:remaining]
    mask_flat = mask.ravel()
    mask_flat[idx] = 1
    return mask_flat.reshape(rows, cols)


def mask_from_row_score(row_score, shape, density, center_fraction=0.04):
    """Threshold a 1D per-row score so ~`density` fraction of *rows* are
    kept (whole phase-encode lines), always including the centered band."""
    rows, cols = shape
    density = float(np.clip(density, 0.0, 1.0))
    mask = np.zeros((rows, cols), dtype=np.float64)

    r0, _, c0, c1 = _center_block(rows, cols, center_fraction)
    # Center band spans full width, matching cartesian/random's convention.
    band = max(1, int(round(rows * center_fraction))) if center_fraction > 0 else 0
    r0 = rows // 2 - band // 2
    r1 = min(rows, r0 + band)
    mask[r0:r1, :] = 1

    target_rows = int(round(density * rows))
    remaining = target_rows - band
    if remaining <= 0:
        return mask

    ranked = row_score.copy()
    ranked[r0:r1] = np.inf
    available = rows - band
    if remaining >= available:
        return np.ones((rows, cols), dtype=np.float64)

    idx = np.argpartition(ranked, remaining)[:remaining]
    mask[idx, :] = 1
    return mask
