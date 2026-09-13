import numpy as np
from PIL import Image

# only for png
def load_image_as_array(path, size=256):
    """Load a PNG, convert to grayscale, resize to size x size, normalize to [0,1]."""
    img = Image.open(path).convert("L")  # "L" = 8-bit grayscale
    img = img.resize((size, size), Image.LANCZOS)
    arr = np.array(img, dtype=np.float64) / 255.0
    return arr

# only for png
def image_to_kspace(image_array):
    """2D FFT: image domain -> k-space (frequency domain)."""
    kspace = np.fft.fft2(image_array) # perform forier transform
    kspace = np.fft.fftshift(kspace)# fftshift() moves the zero-frequency component to the center
    return kspace

def kspace_to_image(kspace_array):
    """Kept for backward compatibility — delegates to the unified reconstruct()."""
    from kspace.kspace_core.reconstruct import reconstruct
    return reconstruct(kspace_array, mask=None, shifted=True)


def log_magnitude_spectrum(kspace_array, normalize=True):
    """Log-scaled magnitude, for visualizing k-space (raw values span huge range).

    Even after log1p, the DC (center) component can still be an order of
    magnitude larger than every other point, which crushes everything else
    to near-black under a plain imshow(). If normalize=True, we additionally
    rescale by the 99.5th percentile (instead of the true max) so the DC
    spike saturates to white and weaker surrounding signal stays visible.
    """
    magnitude = np.abs(kspace_array)
    log_mag = np.log1p(magnitude)
    if normalize:
        vmax = np.percentile(log_mag, 99.5)
        if vmax > 0:
            log_mag = np.clip(log_mag / vmax, 0, 1)
    return log_mag