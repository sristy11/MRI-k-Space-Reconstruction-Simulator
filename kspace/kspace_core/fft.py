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


def log_magnitude_spectrum(kspace_array):
    """Log-scaled magnitude, for visualizing k-space (raw values span huge range)."""
    magnitude = np.abs(kspace_array)
    return np.log1p(magnitude)  # log1p avoids log(0) issues