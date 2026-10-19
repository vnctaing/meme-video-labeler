from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Literal, TypedDict

WireBox = list[int]
WireRun = TypedDict("WireRun", {"from": int, "boxes": list[WireBox]})


class WireSubject(TypedDict):
    id: str
    name: str
    runs: list[WireRun]


class WireTemplate(TypedDict):
    version: Literal[1]
    id: str
    title: str
    credit: str
    width: int
    height: int
    fps: int
    frameCount: int
    cuts: list[int]
    subjects: list[WireSubject]


class WireIndexEntry(TypedDict):
    id: str
    title: str
    credit: str
    width: int
    height: int
    fps: int
    frameCount: int
    subjectCount: int


class WireIndex(TypedDict):
    version: Literal[1]
    templates: list[WireIndexEntry]


SLUG = re.compile(r"[a-z0-9-]+")


def _is_int(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _require(ok: bool, path: str, message: str) -> None:
    if not ok:
        raise ValueError(f"{path}: {message}")


def _require_int(v: object, path: str, minimum: int) -> None:
    if not (isinstance(v, int) and not isinstance(v, bool)):
        raise ValueError(f"{path}: expected an integer, got {v!r}")
    _require(v >= minimum, path, f"expected >= {minimum}, got {v}")


def validate_template(t: WireTemplate) -> None:
    """Raise ValueError naming the JSON path of the first broken invariant."""
    _require(t["version"] == 1, "$.version", f"expected 1, got {t['version']!r}")
    _require(isinstance(t["id"], str) and SLUG.fullmatch(t["id"]) is not None, "$.id", f"expected a slug, got {t['id']!r}")
    for key in ("fps", "frameCount", "width", "height"):
        _require_int(t[key], f"$.{key}", 1)
    frame_count, width, height = t["frameCount"], t["width"], t["height"]

    cuts = t["cuts"]
    for i, cut in enumerate(cuts):
        _require(_is_int(cut) and 0 < cut < frame_count, f"$.cuts[{i}]", f"expected an integer in (0, {frame_count}), got {cut!r}")
        _require(i == 0 or cuts[i - 1] < cut, f"$.cuts[{i}]", "cuts must be sorted and unique")

    seen_ids: set[str] = set()
    for s, subject in enumerate(t["subjects"]):
        sp = f"$.subjects[{s}]"
        sid = subject["id"]
        _require(isinstance(sid, str) and SLUG.fullmatch(sid) is not None, f"{sp}.id", f"expected a slug, got {sid!r}")
        _require(sid not in seen_ids, f"{sp}.id", f"duplicate subject id {sid!r}")
        seen_ids.add(sid)

        prev_end = 0
        for r, run in enumerate(subject["runs"]):
            rp = f"{sp}.runs[{r}]"
            start, boxes = run["from"], run["boxes"]
            _require_int(start, f"{rp}.from", 0)
            _require(len(boxes) >= 1, f"{rp}.boxes", "a run needs at least one box")
            end = start + len(boxes)
            _require(start >= prev_end, f"{rp}.from", f"run starts at {start}, before the previous run ends at {prev_end}")
            _require(end <= frame_count, rp, f"run ends at {end}, past frameCount {frame_count}")
            crossed = next((c for c in cuts if start < c < end), None)
            _require(crossed is None, rp, f"run [{start}, {end}) crosses cut {crossed}")
            prev_end = end

            for b, box in enumerate(boxes):
                bp = f"{rp}.boxes[{b}]"
                _require(len(box) == 4 and all(_is_int(v) for v in box), bp, f"expected 4 integers, got {box!r}")
                x, y, w, h = box
                _require(w >= 1 and h >= 1, bp, f"w and h must be >= 1, got {box}")
                _require(x >= 0 and y >= 0 and x + w <= width and y + h <= height, bp, f"box {box} is outside the {width}x{height} frame")


def _dump(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n"


def write_template(
    templates_dir: Path,
    template: WireTemplate,
    video_path: Path,
    thumb_path: Path,
    source_md: str,
) -> Path:
    """Validate, write templates_dir/<id>/{template.json, video.mp4, thumb.jpg, SOURCE.md}, regenerate index.json."""
    validate_template(template)
    out = templates_dir / template["id"]
    out.mkdir(parents=True, exist_ok=True)
    (out / "template.json").write_text(_dump(template), encoding="utf-8")
    (out / "SOURCE.md").write_text(source_md, encoding="utf-8")
    for src, name in ((video_path, "video.mp4"), (thumb_path, "thumb.jpg")):
        if src.resolve() != (out / name).resolve():
            shutil.copyfile(src, out / name)
    write_index(templates_dir)
    return out


def write_index(templates_dir: Path) -> None:
    entries: list[WireIndexEntry] = []
    for path in sorted(templates_dir.glob("*/template.json")):
        t: WireTemplate = json.loads(path.read_text(encoding="utf-8"))
        entries.append(
            {
                "id": t["id"],
                "title": t["title"],
                "credit": t["credit"],
                "width": t["width"],
                "height": t["height"],
                "fps": t["fps"],
                "frameCount": t["frameCount"],
                "subjectCount": len(t["subjects"]),
            }
        )
    index: WireIndex = {"version": 1, "templates": entries}
    (templates_dir / "index.json").write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
