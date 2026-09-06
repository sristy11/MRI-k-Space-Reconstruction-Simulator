import numpy as np


def cartesian_mask(shape, acceleration=4, center_fraction=0.02):
    """
    Cartesian undersampling: keep a fully-sampled center band (low frequencies,
    which carry most image energy/contrast) and skip every Nth line elsewhere
    (high frequencies, which carry fine detail/edges).

    shape: (rows, cols) of the k-space array
    acceleration: e.g. 4 means keep ~1/4 of the outer lines
    center_fraction: fraction of rows in the center to always keep fully
    """
    rows, cols = shape
    mask = np.zeros((rows, cols), dtype=np.float64)

    # Always keep a fully-sampled center band (this preserves overall contrast/shape)
    center_lines = int(rows * center_fraction)
    center_start = rows // 2 - center_lines // 2
    center_end = center_start + center_lines
    mask[center_start:center_end, :] = 1

    # Outside the center band, keep every Nth line based on acceleration factor
    for row in range(rows):
        if row < center_start or row >= center_end:
            if row % acceleration == 0:
                mask[row, :] = 1

    return mask


def apply_mask(kspace_array, mask):
    """Zero out k-space wherever the mask is 0."""
    return kspace_array * mask