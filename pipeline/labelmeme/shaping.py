from __future__ import annotations

from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from labelmeme.schema import WireRun

Box = tuple[float, float, float, float]
Track = Mapping[int, Box]


@dataclass(frozen=True, slots=True)
class Run:
    start: int
    boxes: tuple[Box, ...]

    @property
    def end(self) -> int:
        return self.start + len(self.boxes)


@dataclass(frozen=True, slots=True)
class ShapeParams:
    max_gap: int = 6
    min_run: int = 1
    smooth_window: int = 5


def _lerp(a: Box, b: Box, t: float) -> Box:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t)


def runs_from_frames(frames: Track, cuts: Sequence[int], max_gap: int) -> list[Run]:
    runs: list[Run] = []
    start, boxes, prev = -1, list[Box](), -1
    for frame in sorted(frames):
        box = frames[frame]
        same_shot = bisect_right(cuts, frame) == bisect_right(cuts, prev)
        if boxes and same_shot and frame - prev - 1 <= max_gap:
            last, span = boxes[-1], frame - prev
            boxes.extend(_lerp(last, box, i / span) for i in range(1, span))
        else:
            if boxes:
                runs.append(Run(start, tuple(boxes)))
            start, boxes = frame, []
        boxes.append(box)
        prev = frame
    if boxes:
        runs.append(Run(start, tuple(boxes)))
    return runs


def drop_short_runs(runs: Sequence[Run], min_len: int) -> list[Run]:
    return [run for run in runs if len(run.boxes) >= min_len]


def smooth_run(run: Run, window: int) -> Run:
    half = window // 2
    n = len(run.boxes)
    return Run(run.start, tuple(_mean(run.boxes[max(0, i - half) : min(n, i + half + 1)]) for i in range(n)))


def _mean(boxes: Sequence[Box]) -> Box:
    n = len(boxes)
    return (
        sum(b[0] for b in boxes) / n,
        sum(b[1] for b in boxes) / n,
        sum(b[2] for b in boxes) / n,
        sum(b[3] for b in boxes) / n,
    )


def to_wire_run(run: Run, width: int, height: int) -> WireRun:
    boxes = []
    for x, y, w, h in run.boxes:
        x1 = min(max(round(x), 0), width - 1)
        y1 = min(max(round(y), 0), height - 1)
        x2 = min(max(round(x + w), x1 + 1), width)
        y2 = min(max(round(y + h), y1 + 1), height)
        boxes.append([x1, y1, x2 - x1, y2 - y1])
    return {"from": run.start, "boxes": boxes}


def shape_subject(track: Track, cuts: Sequence[int], width: int, height: int, params: ShapeParams) -> list[WireRun]:
    runs = drop_short_runs(runs_from_frames(track, cuts, params.max_gap), params.min_run)
    return [to_wire_run(smooth_run(run, params.smooth_window), width, height) for run in runs]
