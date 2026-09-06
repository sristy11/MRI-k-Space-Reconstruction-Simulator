import numpy as np


def mse(original, reconstructed):

    # Compute pixel-wise error
    error = original - reconstructed

    # Square all errors so negatives become positive
    squared_error = error ** 2

    # Return the average squared error
    return np.mean(squared_error)


def psnr(original, reconstructed, max_val=1.0):

    # Compute MSE first
    error = mse(original, reconstructed)

    # Perfect reconstruction case
    if error == 0:
        return float("inf")

    # Apply PSNR formula
    return 10 * np.log10((max_val ** 2) / error)


def nrmse(original, reconstructed):

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

    return np.abs(original - reconstructed)