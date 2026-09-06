import numpy as np


def reconstruct(kspace_array, mask=None, shifted=True):
    
    is_multicoil = kspace_array.ndim == 3

    if mask is not None:
        if is_multicoil:
            kspace_array = kspace_array * mask[None, :, :]  # broadcast across coils
        else:
            kspace_array = kspace_array * mask

    if is_multicoil:
        coil_images = _ifft2(kspace_array, axes=(-2, -1), shifted=shifted)
        return _combine_coils_rss(coil_images)
    else:
        image = _ifft2(kspace_array, axes=(-2, -1), shifted=shifted)
        return np.abs(image)


def _ifft2(kspace_array, axes, shifted):
    if shifted:
        kspace_array = np.fft.ifftshift(kspace_array, axes=axes)
    return np.fft.ifft2(kspace_array, axes=axes)


def _combine_coils_rss(coil_images):
    return np.sqrt(np.sum(np.abs(coil_images) ** 2, axis=0))


def center_crop(image, crop_size):
    
    rows, cols = image.shape
    ch, cw = crop_size
    start_row = max(0, (rows - ch) // 2)
    start_col = max(0, (cols - cw) // 2)
    return image[start_row:start_row + ch, start_col:start_col + cw]