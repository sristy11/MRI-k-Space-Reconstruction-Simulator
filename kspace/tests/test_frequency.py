import numpy as np
import pytest
from fastapi.testclient import TestClient
from app import app
from routes import pipeline

client = TestClient(app)

@pytest.mark.parametrize('shape', [(32, 32), (31, 47), (1, 1)])
def test_complementary_masks(shape):
    for cutoff in (0, .25, 1):
        low, high = pipeline.frequency_masks(shape, cutoff)
        np.testing.assert_array_equal(low + high, np.ones(shape))
        if cutoff == 0:
            assert not low.any()
        elif cutoff == 1:
            assert low.all()
        else:
            assert low[shape[0] // 2, shape[1] // 2] == 1


def test_constant_and_checkerboard_separate(monkeypatch):
    yy, xx = np.indices((32, 32))
    image = .5 + .25 * (-1.) ** (xx + yy)
    kspace = pipeline.image_to_kspace(image)
    monkeypatch.setattr(pipeline, '_resolve_source', lambda _: (kspace, image))
    result = client.post('/pipeline/frequency-experiment', json={'filename': 'synthetic', 'cutoff': .25})
    assert result.status_code == 200
    data = result.json()
    np.testing.assert_allclose(data['low']['recon'], .5 / .75)
    np.testing.assert_allclose(data['high']['recon'], .25 / .75)
    assert client.post('/pipeline/frequency-experiment', json={'cutoff': 1.1}).status_code == 422


def test_multicoil_video_response_and_frequency(monkeypatch):
    rng = np.random.default_rng(4)
    kspace = rng.normal(size=(2, 24, 32)) + 1j * rng.normal(size=(2, 24, 32))
    reference = pipeline._reconstruct_from(kspace, 'dataset')
    monkeypatch.setattr(pipeline, '_resolve_source', lambda _: (kspace, reference))
    payload = {'source': 'dataset', 'dataset': 'synthetic.h5', 'slice_index': 0}
    data = client.post('/pipeline/reconstruct', json={**payload, 'pattern': 'full', 'acceleration': 1}).json()
    assert np.array(data['error']).shape == (24, 32)
    np.testing.assert_allclose(data['reference'], data['recon'])
    data = client.post('/pipeline/frequency-experiment', json={**payload, 'cutoff': 1}).json()
    np.testing.assert_allclose(data['reference'], data['low']['recon'])
    assert not np.array(data['high']['recon']).any()
