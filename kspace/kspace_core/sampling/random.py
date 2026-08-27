import numpy as np


def random_mask(shape, acceleration=4, center_fraction=0.08, seed=None):
    """
    Random undersampling: keep a fully-sampled center band (like Cartesian,
    to preserve contrast/energy), then randomly select remaining lines
    outside the center according to the acceleration factor. Random patterns
    tend to produce incoherent, noise-like artifacts rather than structured
    ghosting or streaking — often easier for reconstruction algorithms to
    handle, which is why it's popular in compressed-sensing MRI.

    shape: (rows, cols) of the k-space array
    acceleration: e.g. 4 means keep ~1/4 of the outer lines
    center_fraction: fraction of rows in the center to always keep fully
    seed: optional, for reproducible masks
    """
    rows, cols = shape
    rng = np.random.default_rng(seed)
    mask = np.zeros((rows, cols), dtype=np.float64)

    # Always keep a fully-sampled center band
    center_lines = int(rows * center_fraction)
    center_start = rows // 2 - center_lines // 2
    center_end = center_start + center_lines
    mask[center_start:center_end, :] = 1

    # Randomly select lines outside the center band
    outside_rows = [r for r in range(rows) if r < center_start or r >= center_end]
    num_to_keep = max(1, int(len(outside_rows) / acceleration))
    chosen_rows = rng.choice(outside_rows, size=num_to_keep, replace=False)
    mask[chosen_rows, :] = 1

    return mask