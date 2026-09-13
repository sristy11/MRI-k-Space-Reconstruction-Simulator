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
from pathlib import Path

image_path = Path(__file__).parent / "test_image.png"

image = load_image_as_array(str(image_path))

kspace = image_to_kspace(image)

acceleration = 4

masks = {
    "Cartesian": cartesian_mask(kspace.shape, acceleration=acceleration),
    "Radial": radial_mask(kspace.shape, acceleration=acceleration),
    "Random": random_mask(kspace.shape, acceleration=acceleration, seed=42),
}

fig, axes = plt.subplots(3, 5, figsize=(20, 12))

for i, (name, mask) in enumerate(masks.items()):
    undersampled_kspace = kspace * mask
    recon = kspace_to_image(undersampled_kspace)

    err_mse = mse(image, recon)
    err_psnr = psnr(image, recon)
    err_nrmse = nrmse(image, recon)

    axes[i, 0].imshow(image, cmap="gray")
    axes[i, 0].set_title("Ground Truth (Source)")

    axes[i, 1].imshow(mask, cmap="gray")
    axes[i, 1].set_title(f"{name} Mask")

    axes[i, 2].imshow(log_magnitude_spectrum(undersampled_kspace), cmap="gray", vmin=0, vmax=1)
    axes[i, 2].set_title(f"{name} K-space")

    axes[i, 3].imshow(recon, cmap="gray")
    axes[i, 3].set_title(f"{name} Recon")

    axes[i, 4].imshow(abs(image - recon), cmap="hot")
    axes[i, 4].set_title(f"Error (PSNR={err_psnr:.1f}dB)")

    print(f"{name}: MSE={err_mse:.5f}  PSNR={err_psnr:.2f}dB  NRMSE={err_nrmse:.4f}")

    for j in range(5):
        axes[i, j].axis("off")

plt.tight_layout()
plt.show()