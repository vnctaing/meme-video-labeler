import hashlib
from pathlib import Path

import pytest

from labelmeme.plan import PointKey, Segment
from labelmeme.tracker import ensure_weights, fill, grid


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
