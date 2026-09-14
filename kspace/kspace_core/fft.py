
import numpy as np
from PIL import Image


# ---------------------------------------------------------
# IMAGE → NUMPY ARRAY
# ---------------------------------------------------------

# Only used for PNG/image files.
def load_image_as_array(path, size=256):
    """
    Load an image, convert it to grayscale,
    resize it to size x size, and normalize
    pixel values to the range [0, 1].
    """

    # Open the image from the given path.
    #
    # .convert("L") converts the image to
    # 8-bit grayscale.
    #
    # Instead of having RGB values:
    #     Red + Green + Blue
    #
    # each pixel now has only one value:
    #     0 = black
    #     255 = white
    img = Image.open(path).convert("L")

    # Resize the image to size x size.
    #
    # If size = 256:
    #     256 x 256 pixels
    #
    # Image.LANCZOS is a high-quality resizing method.
    img = img.resize(
        (size, size),
        Image.LANCZOS
    )

    # Convert the PIL image into a NumPy array.
    #
    # dtype=np.float64 means each pixel is stored
    # as a floating-point number.
    #
    # Before normalization:
    #     pixel values = 0 to 255
    #
    # Dividing by 255 changes them to:
    #     0 to 1
    #
    # Example:
    #     0   / 255 = 0.0
    #     128 / 255 ≈ 0.502
    #     255 / 255 = 1.0
    arr = np.array(
        img,
        dtype=np.float64
    ) / 255.0

    # Return the final 2D NumPy array.
    return arr


# ---------------------------------------------------------
# IMAGE → K-SPACE
# ---------------------------------------------------------

# Only used for PNG/image input.
def image_to_kspace(image_array):
    """
    Convert an image from the image domain
    to the frequency domain (k-space) using
    a 2D Fourier Transform.
    """

    # Perform a 2D Fast Fourier Transform.
    #
    # Input:
    #     image_array
    #
    # Output:
    #     complex-valued k-space
    #
    # The FFT changes the representation from:
    #
    #     IMAGE DOMAIN
    #           ↓
    #     FREQUENCY DOMAIN
    #
    # which we call k-space in MRI.
    kspace = np.fft.fft2(image_array)

    # Move the zero-frequency (DC) component
    # from the corner to the center of the array.
    #
    # Without fftshift():
    #     low frequencies are near the corner.
    #
    # After fftshift():
    #     low frequencies are in the center.
    #
    # This makes k-space easier to visualize.
    kspace = np.fft.fftshift(kspace)

    # Return the shifted k-space.
    return kspace


# ---------------------------------------------------------
# K-SPACE → IMAGE
# ---------------------------------------------------------

def kspace_to_image(kspace_array):
    """
    Convert k-space back into an image.

    This function is kept for backward compatibility.
    The actual reconstruction is handled by reconstruct().
    """

    # Import reconstruct() here instead of at the top.
    #
    # This avoids importing it immediately when this
    # module is loaded.
    from kspace.kspace_core.reconstruct import reconstruct

    # Send the k-space data to the unified reconstruction
    # function.
    #
    # mask=None:
    #     No undersampling mask is being applied here.
    #
    # shifted=True:
    #     The k-space has already been fftshifted.
    return reconstruct(
        kspace_array,
        mask=None,
        shifted=True
    )


# ---------------------------------------------------------
# K-SPACE → LOG MAGNITUDE FOR DISPLAY
# ---------------------------------------------------------

def log_magnitude_spectrum(kspace_array, normalize=True):
    """
    Create a log-scaled magnitude image for displaying k-space.

    K-space values can have a very large range, so displaying
    the raw magnitude directly can make most of the image
    appear almost completely black.
    """

    # k-space contains complex numbers.
    #
    # np.abs() calculates the magnitude of each
    # complex number.
    #
    # For:
    #     a + bj
    #
    # magnitude is:
    #     sqrt(a² + b²)
    magnitude = np.abs(kspace_array)

    # Apply logarithmic scaling.
    #
    # log1p(x) means:
    #     log(1 + x)
    #
    # This compresses very large values and makes
    # weaker k-space information easier to see.
    #
    # Without log scaling:
    #     very large values dominate the display.
    #
    # With log scaling:
    #     strong and weak values become more visible.
    log_mag = np.log1p(magnitude)

    # Normalize the result if requested.
    if normalize:

        # Find the 99.5th percentile of the log magnitude.
        #
        # This means roughly 99.5% of the values are
        # at or below this value.
        #
        # We use this instead of the absolute maximum
        # because the center/DC value can be extremely large
        # compared with the rest of k-space.
        vmax = np.percentile(
            log_mag,
            99.5
        )

        # Make sure vmax is not zero before dividing.
        if vmax > 0:

            # Divide all values by vmax.
            #
            # This approximately maps the values to:
            #     0 → 1
            #
            # Then clip anything outside that range.
            #
            # Values larger than vmax become 1.
            # Values smaller than 0 become 0.
            log_mag = np.clip(
                log_mag / vmax,
                0,
                1
            )

    # Return the final normalized log-magnitude image.
    #
    # This array can be displayed using imshow().
    return log_mag
