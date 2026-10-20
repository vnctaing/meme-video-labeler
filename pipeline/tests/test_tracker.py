import hashlib
from pathlib import Path

import numpy as np
import pytest

from labelmeme.plan import PointKey, Segment
from labelmeme.tracker import IMG_MEAN, IMG_STD, ensure_weights, fill, grid, normalize


def test_grid_keeps_even_frames_the_ends_and_every_click() -> None:
    lead = Segment("lead", 3, 9, (PointKey(9, (1, 1)),))
    bridge = Segment("bridge", 4, 11, (PointKey(4, (1, 1)), PointKey(11, (2, 2))))
    tail = Segment("tail", 7, 12, (PointKey(7, (1, 1)),))
    assert grid(lead) == [3, 4, 6, 8, 9]
    assert grid(bridge) == [4, 6, 8, 10, 11]
    assert grid(tail) == [7, 8, 10, 11]


def test_fill_interpolates_between_tracked_frames_and_drops_frames_next_to_a_lost_one() -> None:
    boxes = {0: (0, 0, 10, 10), 2: (10, 4, 20, 10), 4: None, 6: (0, 0, 10, 10)}
    assert fill(boxes, 0, 6) == [(0, 0, 10, 10), (5, 2, 15, 10), (10, 4, 20, 10), None, None, None, (0, 0, 10, 10)]


def test_ensure_weights_downloads_once_and_refuses_a_wrong_checksum(tmp_path: Path) -> None:
    upstream = tmp_path / "upstream.pt"
    upstream.write_bytes(b"weights")
    sha = hashlib.sha256(b"weights").hexdigest()
    models = tmp_path / "models"

    path = ensure_weights(models, upstream.as_uri(), sha)
    assert path.read_bytes() == b"weights"
    upstream.write_bytes(b"moved upstream")
    assert ensure_weights(models, upstream.as_uri(), sha) == path

    with pytest.raises(ValueError, match="sha256"):
        ensure_weights(tmp_path / "other", upstream.as_uri(), sha)
    assert list((tmp_path / "other").iterdir()) == []


def test_normalize_scales_each_channel_by_the_model_mean_and_std_into_half_precision_nchw() -> None:
    frames = np.zeros((2, 2, 3, 3), np.uint8)
    frames[1, 0, 2] = (255, 0, 51)

    images = normalize(frames)

    assert (str(images.dtype), tuple(images.shape)) == ("torch.float16", (2, 3, 2, 3))
    expected = [(v / 255 - m) / s for v, m, s in zip((255, 0, 51), IMG_MEAN, IMG_STD)]
    assert images[1, :, 0, 2].tolist() == pytest.approx(expected, rel=1e-3)
    assert images[0, :, 1, 1].tolist() == pytest.approx([-m / s for m, s in zip(IMG_MEAN, IMG_STD)], rel=1e-3)
