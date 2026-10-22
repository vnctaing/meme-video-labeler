from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path

from labelmeme.cuts import read_cuts
from labelmeme.job import write_atomic
from labelmeme.prep import read_facts
from labelmeme.schema import SLUG

DEFAULT_TUNING = {"lagMs": 150, "smoothRadius": 4}
RATES = (0.25, 0.5, 1)
MAX_TITLE = 200
MAX_NAME = 60
COLOR = re.compile(r"#[0-9a-f]{6}")


@dataclass(frozen=True, slots=True)
class ClipFacts:
    fps: int
    frame_count: int
    width: int
    height: int
    cuts: tuple[int, ...]


def read_clip(work: Path) -> ClipFacts:
    facts = read_facts(work)
    return ClipFacts(facts.fps, facts.frameCount, facts.width, facts.height, tuple(read_cuts(work, facts.frameCount)))


def clip_json(clip: ClipFacts) -> dict:
    return {"width": clip.width, "height": clip.height, "fps": clip.fps, "frameCount": clip.frame_count, "cuts": list(clip.cuts)}


def _record(v: object, path: str) -> dict:
    if not isinstance(v, dict):
        raise ValueError(f"{path}: expected an object")
    return v


def _list(v: object, path: str) -> list:
    if not isinstance(v, list):
        raise ValueError(f"{path}: expected an array")
    return v


def _str(v: object, path: str) -> str:
    if not isinstance(v, str):
        raise ValueError(f"{path}: expected a string")
    return v


def _int(v: object, path: str, lo: int, hi: int) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise ValueError(f"{path}: expected an integer in [{lo}, {hi}], got {v!r}")
    return v


def _number(v: object, path: str, lo: float, hi: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise ValueError(f"{path}: expected a number in [{lo:g}, {hi:g}], got {v!r}")
    return v


def _cell(v: object, path: str, clip: ClipFacts) -> object:
    if v is None or v == "hidden":
        return v
    cell = _list(v, path)
    if len(cell) != 4:
        raise ValueError(f"{path}: expected null, \"hidden\" or [x, y, size, rate]")
    x = _number(cell[0], f"{path}[0]", 0, clip.width)
    y = _number(cell[1], f"{path}[1]", 0, clip.height)
    size = _number(cell[2], f"{path}[2]", 0, math.inf)
    if size <= 0:
        raise ValueError(f"{path}[2]: expected a size above 0, got {size!r}")
    rate = cell[3]
    if isinstance(rate, bool) or rate not in RATES:
        raise ValueError(f"{path}[3]: expected a rate in {list(RATES)}, got {rate!r}")
    return [x, y, size, rate]


def parse_draft(raw: object, clip: ClipFacts) -> dict:
    o = _record(raw, "$")
    if o.get("version") != 1 or isinstance(o.get("version"), bool):
        raise ValueError("$.version: expected 1")
    title = _str(o.get("title"), "$.title")
    if not 1 <= len(title) <= MAX_TITLE:
        raise ValueError(f"$.title: expected 1 to {MAX_TITLE} characters")
    t = _record(o.get("tuning"), "$.tuning")
    tuning = {"lagMs": _int(t.get("lagMs"), "$.tuning.lagMs", 0, 400), "smoothRadius": _int(t.get("smoothRadius"), "$.tuning.smoothRadius", 0, 12)}
    subjects: list[dict] = []
    for i, v in enumerate(_list(o.get("subjects"), "$.subjects")):
        sp = f"$.subjects[{i}]"
        s = _record(v, sp)
        sid = _str(s.get("id"), f"{sp}.id")
        if SLUG.fullmatch(sid) is None:
            raise ValueError(f"{sp}.id: expected a slug, got {sid!r}")
        if any(x["id"] == sid for x in subjects):
            raise ValueError(f"{sp}.id: duplicate subject id {sid!r}")
        name = _str(s.get("name"), f"{sp}.name").strip()
        if len(name) > MAX_NAME:
            raise ValueError(f"{sp}.name: at most {MAX_NAME} characters")
        color = _str(s.get("color"), f"{sp}.color")
        if COLOR.fullmatch(color) is None:
            raise ValueError(f"{sp}.color: expected #rrggbb in lowercase hex, got {color!r}")
        track = _list(s.get("track"), f"{sp}.track")
        if len(track) != clip.frame_count:
            raise ValueError(f"{sp}.track: expected {clip.frame_count} cells, got {len(track)}")
        cells = [_cell(c, f"{sp}.track[{f}]", clip) for f, c in enumerate(track)]
        subjects.append({"id": sid, "name": name, "color": color, "track": cells})
    return {"version": 1, "title": title, "tuning": tuning, "subjects": subjects}


def dump_draft(draft: dict) -> str:
    return json.dumps(draft, separators=(",", ":"), ensure_ascii=False) + "\n"


def read_draft(work: Path, title: str, clip: ClipFacts) -> dict:
    path = work / "draft.json"
    if not path.is_file():
        return {"version": 1, "title": title, "tuning": dict(DEFAULT_TUNING), "subjects": []}
    return parse_draft(json.loads(path.read_text(encoding="utf-8")), clip)


def write_draft(work: Path, draft: dict) -> None:
    write_atomic(work / "draft.json", dump_draft(draft))
