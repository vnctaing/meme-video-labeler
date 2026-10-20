from __future__ import annotations

import json
import re
import threading
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path

from labelmeme import plan
from labelmeme.cuts import read_cuts
from labelmeme.job import write_atomic
from labelmeme.plan import Box4, HiddenKey, Keyframe, PointKey, Segment, Subject, Tracked
from labelmeme.prep import read_facts
from labelmeme.schema import SLUG

TRACKER_BUILD = "edgetam-7711e01-s2"
COLOR = re.compile(r"#[0-9a-f]{6}")
MAX_NAME = 60


@dataclass(frozen=True, slots=True)
class Authoring:
    rev: int
    title: str
    subjects: tuple[Subject, ...]
    segments: Mapping[str, Tracked]


@dataclass(frozen=True, slots=True)
class ClipFacts:
    frame_count: int
    width: int
    height: int
    cuts: tuple[int, ...]


def read_clip(work: Path) -> ClipFacts:
    facts = read_facts(work)
    return ClipFacts(facts.frameCount, facts.width, facts.height, tuple(read_cuts(work, facts.frameCount)))


def empty(title: str) -> Authoring:
    return Authoring(0, title, (), {})


def _record(v: object, path: str) -> dict:
    if not isinstance(v, dict):
        raise ValueError(f"{path}: expected an object")
    return v


def _list(v: object, path: str) -> list:
    if not isinstance(v, list):
        raise ValueError(f"{path}: expected an array")
    return v


def _int(v: object, path: str, lo: int, hi: int) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v < hi:
        raise ValueError(f"{path}: expected an integer in [{lo}, {hi}), got {v!r}")
    return v


def _str(v: object, path: str) -> str:
    if not isinstance(v, str):
        raise ValueError(f"{path}: expected a string, got {v!r}")
    return v


def _keyframe(v: object, path: str, clip: ClipFacts) -> Keyframe:
    o = _record(v, path)
    frame = _int(o.get("frame"), f"{path}.frame", 0, clip.frame_count)
    if ("point" in o) == ("hidden" in o):
        raise ValueError(f"{path}: expected exactly one of point or hidden")
    if "hidden" in o:
        if o["hidden"] is not True:
            raise ValueError(f"{path}.hidden: expected true, got {o['hidden']!r}")
        return HiddenKey(frame)
    p = _list(o["point"], f"{path}.point")
    if len(p) != 2:
        raise ValueError(f"{path}.point: expected [x, y]")
    return PointKey(frame, (_int(p[0], f"{path}.point[0]", 0, clip.width), _int(p[1], f"{path}.point[1]", 0, clip.height)))


def parse_subjects(raw: object, clip: ClipFacts, path: str = "$.subjects") -> tuple[Subject, ...]:
    subjects: list[Subject] = []
    for i, v in enumerate(_list(raw, path)):
        sp = f"{path}[{i}]"
        o = _record(v, sp)
        sid = _str(o.get("id"), f"{sp}.id")
        if SLUG.fullmatch(sid) is None:
            raise ValueError(f"{sp}.id: expected a slug, got {sid!r}")
        if any(s.id == sid for s in subjects):
            raise ValueError(f"{sp}.id: duplicate subject id {sid!r}")
        name = _str(o.get("name"), f"{sp}.name").strip()
        if len(name) > MAX_NAME:
            raise ValueError(f"{sp}.name: at most {MAX_NAME} characters")
        color = _str(o.get("color"), f"{sp}.color")
        if COLOR.fullmatch(color) is None:
            raise ValueError(f"{sp}.color: expected #rrggbb, got {color!r}")
        keys = tuple(_keyframe(k, f"{sp}.keyframes[{j}]", clip) for j, k in enumerate(_list(o.get("keyframes"), f"{sp}.keyframes")))
        for j in range(1, len(keys)):
            if keys[j - 1].frame >= keys[j].frame:
                raise ValueError(f"{sp}.keyframes[{j}].frame: keyframes must be sorted by frame, one per frame")
        subjects.append(Subject(sid, name, color, keys))
    return tuple(subjects)


def _box(v: object, path: str, clip: ClipFacts) -> Box4 | None:
    if v is None:
        return None
    b = _list(v, path)
    if len(b) != 4:
        raise ValueError(f"{path}: expected [x, y, w, h] or null")
    x, y = _int(b[0], f"{path}[0]", 0, clip.width), _int(b[1], f"{path}[1]", 0, clip.height)
    return (x, y, _int(b[2], f"{path}[2]", 1, clip.width - x + 1), _int(b[3], f"{path}[3]", 1, clip.height - y + 1))


def parse_authoring(raw: object, clip: ClipFacts) -> Authoring:
    o = _record(raw, "$")
    if o.get("version") != 1:
        raise ValueError(f"$.version: expected 1, got {o.get('version')!r}")
    segments: dict[str, Tracked] = {}
    if o.get("tracker") == TRACKER_BUILD:
        for key, v in _record(o.get("segments"), "$.segments").items():
            sp = f"$.segments[{key!r}]"
            s = _record(v, sp)
            start = _int(s.get("from"), f"{sp}.from", 0, clip.frame_count)
            boxes = tuple(_box(b, f"{sp}.boxes[{i}]", clip) for i, b in enumerate(_list(s.get("boxes"), f"{sp}.boxes")))
            segments[key] = Tracked(start, boxes)
    rev = o.get("rev")
    if isinstance(rev, bool) or not isinstance(rev, int):
        raise ValueError(f"$.rev: expected an integer, got {rev!r}")
    return Authoring(rev, _str(o.get("title"), "$.title"), parse_subjects(o.get("subjects"), clip), segments)


def _keyframe_json(k: Keyframe) -> dict:
    match k:
        case PointKey(frame=f, point=(x, y)):
            return {"frame": f, "point": [x, y]}
        case HiddenKey(frame=f):
            return {"frame": f, "hidden": True}


def subject_json(s: Subject) -> dict:
    return {"id": s.id, "name": s.name, "color": s.color, "keyframes": [_keyframe_json(k) for k in s.keyframes]}


def dump_authoring(a: Authoring) -> str:
    raw = {
        "version": 1,
        "tracker": TRACKER_BUILD,
        "rev": a.rev,
        "title": a.title,
        "subjects": [subject_json(s) for s in a.subjects],
        "segments": {k: {"from": t.start, "boxes": [None if b is None else list(b) for b in t.boxes]} for k, t in a.segments.items()},
    }
    return json.dumps(raw, ensure_ascii=False, separators=(",", ":")) + "\n"


def _first_change(old: tuple[Subject, ...], new: tuple[Subject, ...]) -> tuple[str, int] | None:
    before = {s.id: set(s.keyframes) for s in old}
    for s in new:
        changed = before.get(s.id, set()) ^ set(s.keyframes)
        if changed:
            return s.id, min(k.frame for k in changed)
    return None


def _nearest_edit_first(todo: tuple[str, Segment], subject: str, frame: int) -> tuple[bool, int]:
    subject_id, seg = todo
    return subject_id != subject, min(abs(seg.start - frame), abs(seg.stop - 1 - frame))


class AuthoringStore:
    def __init__(self, work_dir: Path) -> None:
        self._work_dir = work_dir
        self._lock = threading.Lock()
        self._planned: dict[str, frozenset[str]] = {}
        self._last_edit: dict[str, tuple[str, int]] = {}

    def _path(self, job_id: str) -> Path:
        return self._work_dir / job_id / "authoring.json"

    def _load(self, job_id: str) -> tuple[Authoring, ClipFacts, list[tuple[str, Segment]]]:
        clip = read_clip(self._work_dir / job_id)
        a = parse_authoring(json.loads(self._path(job_id).read_text(encoding="utf-8")), clip)
        planned = plan.plan(a.subjects, clip.cuts, clip.frame_count)
        self._planned[job_id] = frozenset(seg.key for _, seg in planned)
        return a, clip, planned

    def _write(self, job_id: str, a: Authoring) -> None:
        write_atomic(self._path(job_id), dump_authoring(a))

    def read(self, job_id: str) -> tuple[Authoring, ClipFacts]:
        with self._lock:
            a, clip, _ = self._load(job_id)
            return a, clip

    def reset(self, job_id: str, title: str) -> None:
        with self._lock:
            self._write(job_id, empty(title))
            self._planned[job_id] = frozenset()
            self._last_edit.pop(job_id, None)

    def edit(self, job_id: str, subjects: tuple[Subject, ...], title: str) -> Authoring:
        with self._lock:
            a, clip, _ = self._load(job_id)
            keys = {seg.key for _, seg in plan.plan(subjects, clip.cuts, clip.frame_count)}
            change = _first_change(a.subjects, subjects)
            if change is not None:
                self._last_edit[job_id] = change
            edited = Authoring(a.rev + 1, title, subjects, {k: v for k, v in a.segments.items() if k in keys})
            self._write(job_id, edited)
            self._planned[job_id] = frozenset(keys)
            return edited

    def put_segment(self, job_id: str, seg: Segment, tracked: Tracked) -> bool:
        with self._lock:
            a, _, _ = self._load(job_id)
            if seg.key not in self._planned[job_id]:
                return False
            self._write(job_id, replace(a, rev=a.rev + 1, segments={**a.segments, seg.key: tracked}))
            return True

    def missing(self, job_id: str) -> list[tuple[str, Segment]]:
        with self._lock:
            a, _, planned = self._load(job_id)
            todo = plan.missing(planned, a.segments)
            last = self._last_edit.get(job_id)
        return todo if last is None else sorted(todo, key=lambda t: _nearest_edit_first(t, *last))

    def is_planned(self, job_id: str, key: str) -> bool:
        return key in self._planned.get(job_id, frozenset())
