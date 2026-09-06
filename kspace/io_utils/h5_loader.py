import h5py
import numpy as np


def load_h5_slice(path, slice_index=None):
    """
    Load one slice of multi-coil k-space from a fastMRI-style .h5 file.
    Returns the combined (single-channel) complex k-space for that slice,
    ready to feed into the same fft/sampling/reconstruct pipeline used for PNGs.
    """
    with h5py.File(path, "r") as f:
        kspace = f["kspace"][()]  # shape: (slices, coils, rows, cols)

    num_slices = kspace.shape[0]
    s = slice_index if slice_index is not None else num_slices // 2
    # if slice not selected,middle slice 19th will be selected
    coil_kspace = kspace[s]  # shape: (coils, rows, cols)

    return coil_kspace.astype(np.complex128)


def combine_coils_rss(coil_images):
    """
    Root-sum-of-squares coil combination — the standard way to merge
    multi-coil MRI images into a single magnitude image.
    coil_images: array of shape (coils, rows, cols), complex
    """
    return np.sqrt(np.sum(np.abs(coil_images) ** 2, axis=0))


def center_crop(image, crop_size):
    """Crop the center crop_size x crop_size region out of a larger image."""
    rows, cols = image.shape
    ch, cw = crop_size
    start_row = (rows - ch) // 2
    start_col = (cols - cw) // 2
    return image[start_row:start_row + ch, start_col:start_col + cw]