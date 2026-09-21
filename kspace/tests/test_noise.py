# Run from the folder that CONTAINS kspace/ :
#     python -m kspace.tests.test_noise
import numpy as np

from kspace.kspace_core.noise import add_kspace_noise, approx_snr_db, signal_rms
from kspace.kspace_core.reconstruct import reconstruct
from kspace.kspace_core.metrics import mse, psnr


def _synthetic_kspace(n=128):
    """A smooth blob image -> centered k-space. No files or datasets needed."""
    y, x = np.mgrid[-1:1:complex(n), -1:1:complex(n)]
    image = np.exp(-(x ** 2 + y ** 2) * 6)
    return image, np.fft.fftshift(np.fft.fft2(image))


def test_zero_noise_is_identity():
    _, k = _synthetic_kspace()
    assert np.array_equal(add_kspace_noise(k, 0.0), k)


def test_input_is_not_modified():
    _, k = _synthetic_kspace()
    before = k.copy()
    add_kspace_noise(k, 10.0)
    assert np.array_equal(k, before)


def test_same_seed_same_noise_different_seed_different_noise():
    _, k = _synthetic_kspace()
    a = add_kspace_noise(k, 10.0, seed=1)
    b = add_kspace_noise(k, 10.0, seed=1)
    c = add_kspace_noise(k, 10.0, seed=2)
    assert np.array_equal(a, b)
    assert not np.array_equal(a, c)


def test_noise_rms_matches_requested_level():
    _, k = _synthetic_kspace()
    level = 10.0
    noise = add_kspace_noise(k, level, seed=0) - k
    expected = level / 100 * signal_rms(k)
    assert abs(signal_rms(noise) - expected) / expected < 0.02


def test_noise_is_complex():
    _, k = _synthetic_kspace()
    noise = add_kspace_noise(k, 10.0) - k
    assert np.std(noise.real) > 0 and np.std(noise.imag) > 0
    assert abs(np.std(noise.real) - np.std(noise.imag)) / np.std(noise.real) < 0.05


def test_multicoil_shape_dtype_and_independent_coils():
    _, k = _synthetic_kspace(64)
    k = np.stack([k, k, k]).astype(np.complex64)
    out = add_kspace_noise(k, 10.0)
    assert out.shape == k.shape and out.dtype == np.complex64
    assert not np.allclose(out[0] - k[0], out[1] - k[1])


def test_more_noise_means_worse_psnr_and_snr_matches_formula():
    image, k = _synthetic_kspace()
    psnrs = []
    for level in (1.0, 5.0, 20.0):
        recon = reconstruct(add_kspace_noise(k, level, seed=3), shifted=True)
        psnrs.append(psnr(image, recon, max_val=image.max()))
    assert psnrs[0] > psnrs[1] > psnrs[2]
    assert abs(approx_snr_db(10.0) - 20.0) < 1e-9
    assert approx_snr_db(0) is None


def test_noise_then_mask_leaves_unsampled_points_zero():
    _, k = _synthetic_kspace()
    mask = np.zeros(k.shape)
    mask[::4, :] = 1
    out = add_kspace_noise(k, 10.0) * mask
    assert np.all(out[mask == 0] == 0)


if __name__ == "__main__":
    tests = [v for name, v in list(globals().items()) if name.startswith("test_")]
    for t in tests:
        t()
        print("PASS", t.__name__)
    print(f"{len(tests)} tests passed")
