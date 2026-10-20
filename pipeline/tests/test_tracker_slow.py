import os
import time
from pathlib import Path

import pytest

from labelmeme.plan import PointKey, Segment
from labelmeme.tracker import STRIDE, Cancelled, Clip, Tracker

PIPELINE = Path(__file__).resolve().parents[1]
VIDEO = PIPELINE / "work/tos-lab/video.mp4"
CLIP = Clip(VIDEO, 1280, 534)
THOM = PointKey(114, (230, 210))
EYEPIECE = PointKey(114, (585, 160))
CORRECTION = PointKey(190, (310, 200))

pytestmark = pytest.mark.skipif(os.environ.get("LABELMEME_SLOW") != "1" or not VIDEO.is_file(), reason="set LABELMEME_SLOW=1 and put the tos-lab clip in work/tos-lab/")


@pytest.fixture(scope="module")
def tracker() -> Tracker:
    return Tracker(PIPELINE / "models")


def _contains(box: tuple[int, int, int, int] | None, point: tuple[int, int]) -> bool:
    return box is not None and box[0] <= point[0] < box[0] + box[2] and box[1] <= point[1] < box[1] + box[3]


@pytest.mark.parametrize(
    "seg",
    [
        Segment("tail", 114, 228, (THOM,)),
        Segment("lead", 0, 114, (THOM,)),
        Segment("tail", 114, 228, (EYEPIECE,)),
        Segment("bridge", 114, 190, (THOM, CORRECTION)),
    ],
    ids=lambda s: s.key,
)
def test_tracks_the_segment_and_keeps_the_clicked_subject(tracker: Tracker, seg: Segment) -> None:
    progress: list[tuple[int, int]] = []
    started = time.perf_counter()
    tracked = tracker.track(CLIP, seg, on_frame=lambda d, t: progress.append((d, t)), cancelled=lambda: False)
    print(f"\n{seg.key}: {time.perf_counter() - started:.1f} s for {len(progress)} grid frames")
    assert tracked.start == seg.start
    assert len(tracked.boxes) == seg.stop - seg.start
    assert progress[-1][0] == progress[-1][1] >= (seg.stop - seg.start) // STRIDE
    click = seg.clicks[0]
    if seg.start <= click.frame < seg.stop:
        assert _contains(tracked.boxes[click.frame - seg.start], click.point)
    assert sum(b is not None for b in tracked.boxes) >= 0.9 * len(tracked.boxes)


def test_cancel_stops_within_one_grid_frame(tracker: Tracker) -> None:
    seen: list[int] = []
    with pytest.raises(Cancelled):
        tracker.track(CLIP, Segment("tail", 114, 228, (THOM,)), on_frame=lambda d, _: seen.append(d), cancelled=lambda: len(seen) >= 5)
    assert seen == [1, 2, 3, 4, 5]
