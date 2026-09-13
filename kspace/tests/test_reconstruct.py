from kspace.kspace_core.reconstruct import reconstruct
from kspace.io_utils.h5_loader import load_h5_slice, combine_coils_rss, center_crop
import numpy as np
import matplotlib.pyplot as plt
from kspace.kspace_core.fft import (
    load_image_as_array,
    image_to_kspace,
    kspace_to_image,
    log_magnitude_spectrum,
)
from kspace.kspace_core.sampling.cartesian import cartesian_mask
from kspace.kspace_core.sampling.radial import radial_mask
from kspace.kspace_core.sampling.random import random_mask
from kspace.kspace_core.metrics import mse, psnr, nrmse
kspace = load_h5_slice("kspace/data/datasets/file1000007.h5", 22)
image = np.fft.fftshift(reconstruct(kspace))
acceleration = 30

masks = {
    "Cartesian": cartesian_mask(kspace.shape[1:3], acceleration=acceleration, center_fraction=0.02),
    "Radial": radial_mask(kspace.shape[1:3], acceleration=acceleration),
    "Random": random_mask(kspace.shape[1:3], acceleration=acceleration, center_fraction=0.05, seed=42),
}

fig, axes = plt.subplots(3, 4, figsize=(16, 12))

for i, (name, mask) in enumerate(masks.items()):
    undersampled_kspace = kspace * mask
    recon = np.fft.fftshift(reconstruct(undersampled_kspace))

    err_mse = mse(image, recon)
    err_psnr = psnr(image, recon)
    err_nrmse = nrmse(image, recon)

    axes[i, 0].imshow(mask, cmap="gray")
    axes[i, 0].set_title(f"{name} Mask")

    axes[i, 1].imshow(log_magnitude_spectrum(undersampled_kspace[2]), cmap="gray", vmin=0, vmax=1)
    axes[i, 1].set_title(f"{name} K-space")

    axes[i, 2].imshow(recon)
    axes[i, 2].set_title(f"{name} Recon")

    axes[i, 3].imshow(abs(image - recon), cmap="hot")
    axes[i, 3].set_title(f"Error (PSNR={err_psnr:.1f}dB)")

    print(f"{name}: MSE={err_mse:.15e}  PSNR={err_psnr:.2f}dB  NRMSE={err_nrmse:.4f}")

    for j in range(4):
        axes[i, j].axis("off")

plt.tight_layout()
plt.show()