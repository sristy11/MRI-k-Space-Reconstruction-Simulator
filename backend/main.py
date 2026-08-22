import h5py
import numpy as np
import matplotlib.pyplot as plt
file_path = "file1000007.h5"
with h5py.File(file_path, "r") as f:
    kspace = f["kspace"][:]
    # print(kspace.shape)
print(kspace.shape)
#kspace: Multi-coil k-space data. The shape of the kspace tensor is (number of slices, number of coils, height, width).
ifts = []
slice = kspace[37, :, :, :]
for coil in slice:
    ifts.append(np.fft.fftshift(
        np.fft.ifft2(
            np.fft.ifftshift(coil)
        )
    )
)
ifts = np.array(ifts)
coils = len(slice)
rss_image = np.sqrt(np.sum(np.abs(ifts)**2, axis=0))
rss_display = rss_image / (
    rss_image.max() + 1e-12
)
plt.imshow(rss_image, cmap="gray")
plt.axis("off")
plt.show()

plt.imshow(rss_display, cmap="gray")
plt.axis("off")
plt.show()

    
