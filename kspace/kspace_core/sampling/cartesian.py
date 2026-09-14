import numpy as np


def cartesian_mask(shape, acceleration=4, center_fraction=0.02):
    """
    Cartesian undersampling mask.

    Keeps the center of k-space fully sampled and
    samples fewer lines outside the center.
    """
    rows, cols = shape

    # Start with everything removed
    mask = np.zeros((rows, cols), dtype=np.float64)

    # Find the center region
    center_lines = int(rows * center_fraction)
    center_start = rows // 2 - center_lines // 2
    center_end = center_start + center_lines

    # Keep all points in the center lines
    mask[center_start:center_end, :] = 1

    # Keep every Nth line outside the center
    for row in range(rows):
        if row < center_start or row >= center_end:
            if row % acceleration == 0:
                mask[row, :] = 1

    return mask


def apply_mask(kspace_array, mask):
    """Zero out k-space wherever the mask is 0."""

    # 1 keeps the value, 0 removes it
    return kspace_array * mask
