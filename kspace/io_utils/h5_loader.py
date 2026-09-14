import h5py
import numpy as np


def load_h5_slice(path, slice_index=None):
    """
    Load one MRI slice from a fastMRI-style .h5 file.

    The H5 file contains multi-coil k-space data with the shape:

        (slices, coils, rows, cols)

    This function reads ONLY one requested slice instead of
    loading the entire H5 file into memory.

    Returns:
        Raw complex multi-coil k-space
        Shape: (coils, rows, cols)

    The returned k-space is NOT fftshifted.
    """

    # Open the H5 file in read-only mode.
    # "r" means we are only reading the file.
    with h5py.File(path, "r") as f:

        # Get the "kspace" dataset from the H5 file.
        #
        # Its expected shape is:
        # (number of slices, number of coils, rows, columns)
        kspace_dataset = f["kspace"]

        # Get the total number of slices.
        #
        # shape[0] represents the first dimension,
        # which is the number of slices.
        num_slices = kspace_dataset.shape[0]

        # Decide which slice to load.
        #
        # If the user provided a slice_index, use that.
        #
        # If slice_index is None, use the middle slice.
        #
        # Example:
        # If there are 20 slices:
        # 20 // 2 = 10
        # So slice 10 will be selected.
        s = (
            slice_index
            if slice_index is not None
            else num_slices // 2
        )

        # Read ONLY the selected slice from the H5 file.
        #
        # We are NOT loading all slices.
        #
        # The result has shape:
        # (coils, rows, cols)
        coil_kspace = kspace_dataset[s]

    # Convert the data to complex128.
    #
    # MRI k-space contains complex numbers:
    # real part + imaginary part.
    #
    # Example:
    # 3 + 2j
    #
    # complex128 gives us a standard high-precision
    # complex NumPy data type.
    return coil_kspace.astype(np.complex128)


def get_num_slices(path):
    """
    Get the number of MRI slices in an H5 file.

    This function does NOT read the actual k-space data.
    It only checks the shape of the "kspace" dataset.
    """

    # Open the H5 file in read-only mode.
    with h5py.File(path, "r") as f:

        # Access the kspace dataset.
        kspace_dataset = f["kspace"]

        # shape[0] is the number of slices.
        #
        # Example:
        # shape = (30, 15, 320, 320)
        #
        # shape[0] = 30 slices
        return kspace_dataset.shape[0]


def combine_coils_rss(coil_images):
    """
    Combine multiple MRI coil images into one image
    using Root-Sum-of-Squares (RSS).

    Input:
        coil_images
        Shape: (coils, rows, cols)

    Output:
        One combined magnitude image
        Shape: (rows, cols)
    """

    # np.abs() gets the magnitude of each complex value.
    #
    # Example:
    # If a complex value is:
    #     3 + 4j
    #
    # np.abs() gives:
    #     sqrt(3^2 + 4^2) = 5
    magnitudes = np.abs(coil_images)

    # Square every magnitude.
    #
    # This gives:
    # |coil_image|^2
    squared_magnitudes = magnitudes ** 2

    # Add the squared values from all coils.
    #
    # axis=0 means:
    # "combine along the coil dimension."
    #
    # If we have:
    # (coils, rows, cols)
    #
    # after summing over axis=0:
    # (rows, cols)
    summed = np.sum(squared_magnitudes, axis=0)

    # Take the square root.
    #
    # RSS formula:
    #
    # RSS = sqrt(
    #     |coil1|² +
    #     |coil2|² +
    #     ...
    # )
    return np.sqrt(summed)


def center_crop(image, crop_size):
    """
    Crop the center of an image.

    Input:
        image:
            2D image with shape (rows, cols)

        crop_size:
            Tuple containing:
            (desired_height, desired_width)

    Example:
        Image = 400 x 400
        crop_size = (256, 256)

    Output:
        Center 256 x 256 region.
    """

    # Get the height and width of the image.
    #
    # Example:
    # image.shape = (400, 400)
    #
    # rows = 400
    # cols = 400
    rows, cols = image.shape

    # Separate the desired crop height and width.
    #
    # Example:
    # crop_size = (256, 256)
    #
    # ch = 256
    # cw = 256
    ch, cw = crop_size

    # Calculate where the crop should start vertically.
    #
    # Example:
    # Image height = 400
    # Crop height  = 256
    #
    # (400 - 256) // 2
    # = 72
    #
    # So cropping starts at row 72.
    start_row = (rows - ch) // 2

    # Calculate where the crop should start horizontally.
    start_col = (cols - cw) // 2

    # Extract the center region.
    #
    # start_row : start_row + ch
    # gives the desired rows.
    #
    # start_col : start_col + cw
    # gives the desired columns.
    return image[
        start_row:start_row + ch,
        start_col:start_col + cw
    ]
