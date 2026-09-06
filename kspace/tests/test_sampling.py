from kspace.kspace_core.reconstruct import reconstruct
from kspace.io_utils.h5_loader import load_h5_slice, combine_coils_rss, center_crop
import matplotlib.pyplot as plt
from kspace.kspace_core.sampling.cartesian import cartesian_mask
from kspace.kspace_core.sampling.radial import radial_mask
from kspace.kspace_core.sampling.random import random_mask
from kspace.kspace_core.metrics import mse, psnr, nrmse
kspace = load_h5_slice("kspace/data/datasets/file1000007.h5", 22)
image = reconstruct(kspace, cartesian_mask(kspace))
plt.imshow(image, cmap = "gray")
plt.show()


