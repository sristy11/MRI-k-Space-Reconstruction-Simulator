import numpy as np


def mse(original, reconstructed):
    """
    Mean Squared Error (MSE)

    Measures the average squared difference between
    corresponding pixels of the original and reconstructed images.

    Lower is better.
    MSE = 0 means the images are identical.
    """

    # Compute pixel-wise error
    error = original - reconstructed

    # Square all errors so negatives become positive
    squared_error = error ** 2

    # Return the average squared error
    return np.mean(squared_error)


def psnr(original, reconstructed, max_val=1.0):
    """
    Peak Signal-to-Noise Ratio (PSNR)

    Indicates reconstruction quality in decibels (dB).

    Higher is better.
    Infinite PSNR means perfect reconstruction.

    Formula:
        PSNR = 10 * log10(MAX^2 / MSE)

    where:
        MAX = maximum possible pixel value
        MSE = mean squared error
    """

    # Compute MSE first
    error = mse(original, reconstructed)

    # Perfect reconstruction case
    if error == 0:
        return float("inf")

    # Apply PSNR formula
    return 10 * np.log10((max_val ** 2) / error)


def nrmse(original, reconstructed):
    """
    Normalized Root Mean Squared Error (NRMSE)

    Computes RMSE and normalizes it by the image intensity range.

    Lower is better.
    NRMSE = 0 means perfect reconstruction.

    Formula:
        RMSE = sqrt(MSE)
        NRMSE = RMSE / (max_pixel - min_pixel)
    """

    # Compute root mean squared error
    rmse = np.sqrt(mse(original, reconstructed))

    # Compute intensity range of original image
    image_range = original.max() - original.min()

    # Avoid division by zero for constant images
    if image_range == 0:
        return 0.0

    # Normalize RMSE
    return rmse / image_range


def error_heatmap(original, reconstructed):
    """
    Pixel-wise absolute error map.

    Returns an array where each pixel contains:

        |original - reconstructed|

    Useful for visualization using matplotlib.

    Dark regions  -> small error
    Bright regions -> large error
    """

    return np.abs(original - reconstructed)