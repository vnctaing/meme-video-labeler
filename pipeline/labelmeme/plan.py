from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from labelmeme.shaping import Box

Point = tuple[int, int]
Box4 = tuple[int, int, int, int]


@dataclass(frozen=True, slots=True)
class PointKey:
    frame: int
    point: Point


@dataclass(frozen=True, slots=True)
class HiddenKey:
    frame: int


Keyframe = PointKey | HiddenKey


@dataclass(frozen=True, slots=True)
class Subject:
    id: str
    name: str
    color: str
    keyframes: tuple[Keyframe, ...]


@dataclass(frozen=True, slots=True)
class Tracked:
    start: int
    boxes: tuple[Box4 | None, ...]


Kind = Literal["lead", "bridge", "tail"]


@dataclass(frozen=True, slots=True)
class Segment:
    kind: Kind
    start: int
    stop: int
    clicks: tuple[PointKey, ...]

    @property
    def key(self) -> str:
        clicks = ";".join(f"{c.frame}@{c.point[0]},{c.point[1]}" for c in self.clicks)
        return f"{self.kind}|{self.start}-{self.stop}|{clicks}"


def shots(cuts: Sequence[int], frame_count: int) -> list[tuple[int, int]]:
    bounds = [0, *cuts, frame_count]
    return list(zip(bounds, bounds[1:]))


def plan_subject(keyframes: Sequence[Keyframe], cuts: Sequence[int], frame_count: int) -> list[Segment]:
    segments: list[Segment] = []
    for a, b in shots(cuts, frame_count):
        keys = [k for k in keyframes if a <= k.frame < b]
        if not keys:
            continue
        first = keys[0]
        if isinstance(first, PointKey) and first.frame > a:
            segments.append(Segment("lead", a, first.frame, (first,)))
        for k, after in zip(keys, [*keys[1:], None]):
            if not isinstance(k, PointKey):
                continue
            match after:
                case PointKey():
                    segments.append(Segment("bridge", k.frame, after.frame, (k, after)))
                case HiddenKey():
                    segments.append(Segment("tail", k.frame, after.frame, (k,)))
                case None:
                    segments.append(Segment("tail", k.frame, b, (k,)))
    return segments


def plan(subjects: Sequence[Subject], cuts: Sequence[int], frame_count: int) -> list[tuple[str, Segment]]:
    return [(s.id, seg) for s in subjects for seg in plan_subject(s.keyframes, cuts, frame_count)]


def missing(planned: Sequence[tuple[str, Segment]], cached: Mapping[str, Tracked]) -> list[tuple[str, Segment]]:
    seen: set[str] = set()
    out: list[tuple[str, Segment]] = []
    for subject_id, seg in planned:
        if seg.key in cached or seg.key in seen:
            continue
        seen.add(seg.key)
        out.append((subject_id, seg))
    return out


def boxes_by_frame(segments: Sequence[Segment], cached: Mapping[str, Tracked]) -> dict[int, Box]:
    frames: dict[int, Box] = {}
    for seg in segments:
        tracked = cached.get(seg.key)
        if tracked is None:
            continue
        for i, box in enumerate(tracked.boxes):
            if box is not None:
                frames[tracked.start + i] = (float(box[0]), float(box[1]), float(box[2]), float(box[3]))
    return dict(sorted(frames.items()))

