# Run from the folder that CONTAINS kspace/ :
#     python -m kspace.tests.test_auto_mask
import numpy as np

from kspace.kspace_core.auto_mask import FAMILIES, search_target_mask
from kspace.kspace_core.metrics import nrmse, psnr
from kspace.kspace_core.reconstruct import reconstruct


def _synthetic_kspace(n=96):
    """A blob plus higher-frequency texture (stripes + a checkerboard) ->
    centered k-space. No files or datasets needed. Unlike a pure smooth
    blob, this has real high-frequency content, so undersampling actually
    costs reconstruction quality across the density range the tests probe —
    a pure blob is already reconstructed almost perfectly from a handful of
    low-frequency lines, which leaves no room for a target error search.
    """
    y, x = np.mgrid[-1:1:complex(n), -1:1:complex(n)]
    image = np.exp(-(x ** 2 + y ** 2) * 6)
    image += 0.5 * np.sin(30 * x) * np.sin(30 * y)
    image += 0.3 * ((np.floor(x * 8) % 2 == 0) ^ (np.floor(y * 8) % 2 == 0)).astype(float)
    image -= image.min()
    image /= image.max()
    return image, np.fft.fftshift(np.fft.fft2(image))


def _reconstruct_fn(kspace):
    return reconstruct(kspace, shifted=True)


def test_hits_reachable_nrmse_target_within_tolerance():
    image, k = _synthetic_kspace()
    result = search_target_mask(
        kspace=k,
        reference_image=image,
        reconstruct_fn=_reconstruct_fn,
        shape=k.shape,
        metric="nrmse",
        target_value=0.05,
        family="variable_density",
    )
    assert result["achievable"]
    assert abs(result["value"] - 0.05) < 0.01


def test_hits_reachable_psnr_target_within_tolerance():
    image, k = _synthetic_kspace()
    result = search_target_mask(
        kspace=k,
        reference_image=image,
        reconstruct_fn=_reconstruct_fn,
        shape=k.shape,
        metric="psnr",
        target_value=30.0,
        family="variable_density",
    )
    assert result["achievable"]
    assert abs(result["value"] - 30.0) < 1.0


def test_higher_density_target_gives_denser_mask():
    """A stricter (lower) error target should be satisfied by keeping more
    k-space points — this is the monotonicity the bisection depends on."""
    image, k = _synthetic_kspace()
    loose = search_target_mask(
        kspace=k, reference_image=image, reconstruct_fn=_reconstruct_fn,
        shape=k.shape, metric="nrmse", target_value=0.2, family="variable_density",
    )
    strict = search_target_mask(
        kspace=k, reference_image=image, reconstruct_fn=_reconstruct_fn,
        shape=k.shape, metric="nrmse", target_value=0.02, family="variable_density",
    )
    assert strict["density"] > loose["density"]
    assert strict["mask"].sum() > loose["mask"].sum()


def test_returned_mask_actually_produces_the_reported_metric():
    image, k = _synthetic_kspace()
    result = search_target_mask(
        kspace=k, reference_image=image, reconstruct_fn=_reconstruct_fn,
        shape=k.shape, metric="nrmse", target_value=0.08, family="random_lines",
    )
    recon = _reconstruct_fn(k * result["mask"])
    assert abs(nrmse(image, recon) - result["value"]) < 1e-9


def test_unreachable_target_is_flagged_and_clamped():
    image, k = _synthetic_kspace()
    # No amount of undersampling can push a noise-free reconstruction's PSNR
    # above what full sampling already gives (near-perfect / infinite).
    result = search_target_mask(
        kspace=k, reference_image=image, reconstruct_fn=_reconstruct_fn,
        shape=k.shape, metric="psnr", target_value=500.0, family="variable_density",
    )
    assert not result["achievable"]
    assert result["density"] == 1.0


def test_center_block_always_kept():
    image, k = _synthetic_kspace()
    result = search_target_mask(
        kspace=k, reference_image=image, reconstruct_fn=_reconstruct_fn,
        shape=k.shape, metric="nrmse", target_value=0.3, family="variable_density",
        center_fraction=0.1,
    )
    rows, cols = k.shape
    r0, r1 = rows // 2 - 4, rows // 2 + 4
    c0, c1 = cols // 2 - 4, cols // 2 + 4
    assert np.all(result["mask"][r0:r1, c0:c1] == 1)


def test_all_families_run_without_error():
    image, k = _synthetic_kspace(64)
    for family in FAMILIES:
        result = search_target_mask(
            kspace=k, reference_image=image, reconstruct_fn=_reconstruct_fn,
            shape=k.shape, metric="mse", target_value=0.01, family=family,
            max_iterations=10,
        )
        assert result["mask"].shape == k.shape


if __name__ == "__main__":
    tests = [v for name, v in list(globals().items()) if name.startswith("test_")]
    for t in tests:
        t()
        print("PASS", t.__name__)
    print(f"{len(tests)} tests passed")
