import matplotlib.pyplot as plt
from kspace_core.fft import (
    load_image_as_array,
    image_to_kspace,
    kspace_to_image,
    log_magnitude_spectrum,
)

# 1. Load a test PNG (put any photo at this path first)
image = load_image_as_array("test_image.png")

# 2. Forward transform: image -> k-space
kspace = image_to_kspace(image)

# 3. Inverse transform: k-space -> image (should match original)
reconstructed = kspace_to_image(kspace)

# 4. Sanity check: how close is the round trip?
error = image - reconstructed
print("Max abs error:", error.max())
print("Mean abs error:", error.mean())

# 5. Visualize all three
fig, axes = plt.subplots(1, 3, figsize=(12, 4))
axes[0].imshow(image, cmap="gray")
axes[0].set_title("Original")

axes[1].imshow(log_magnitude_spectrum(kspace), cmap="gray")
axes[1].set_title("K-space (log magnitude)")

axes[2].imshow(reconstructed, cmap="gray")
axes[2].set_title("Reconstructed")

for ax in axes:
    ax.axis("off")

plt.tight_layout()
plt.show()