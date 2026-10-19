from __future__ import annotations

import json
from bisect import bisect_right
from dataclasses import dataclass
from pathlib import Path

import cv2

from labelmeme import sheets
from labelmeme.prep import read_facts
from labelmeme.schema import SLUG, WireSubject, WireTemplate, write_template
from labelmeme.shaping import Box, ShapeParams, Track, shape_subject
from labelmeme.track import read_cuts

SAMPLES_PER_SHOT = 4
COLORS = [(0, 200, 255), (255, 120, 0), (80, 220, 80), (220, 80, 220), (0, 80, 255)]


@dataclass(frozen=True, slots=True)
class SubjectSpec:
    id: str
    name: str
    tracks: tuple[str, ...]


def parse_subjects(raw: object, known_tracks: set[str]) -> list[SubjectSpec]:
    if not isinstance(raw, dict) or not isinstance(raw.get("subjects"), list):
        raise ValueError('subjects.json: expected {"subjects": [...]}')
    specs: list[SubjectSpec] = []
    claimed: dict[str, str] = {}
    for i, s in enumerate(raw["subjects"]):
        path = f"subjects.json $.subjects[{i}]"
        if not isinstance(s, dict):
            raise ValueError(f"{path}: expected an object")
        sid, name, tracks = s.get("id"), s.get("name"), s.get("tracks")
        if not isinstance(sid, str) or SLUG.fullmatch(sid) is None:
            raise ValueError(f"{path}.id: expected a slug [a-z0-9-]+, got {sid!r}")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"{path}.name: expected a non-empty name, got {name!r}")
        if not isinstance(tracks, list) or not tracks:
            raise ValueError(f"{path}.tracks: expected a non-empty list of track ids")
        for tid in tracks:
            if tid not in known_tracks:
                raise ValueError(f"{path}.tracks: unknown track id {tid!r}")
            if tid in claimed:
                raise ValueError(f"{path}.tracks: {tid!r} is already claimed by {claimed[tid]!r}")
            claimed[tid] = sid
        specs.append(SubjectSpec(sid, name.strip(), tuple(tracks)))
    return specs


def load_tracks(path: Path) -> dict[str, Track]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {tid: {d["frame"]: _box(d["box"]) for d in dets} for tid, dets in raw.items()}


def _box(b: list[int]) -> Box:
    return (float(b[0]), float(b[1]), float(b[2]), float(b[3]))


def _box_at(subject: WireSubject, frame: int) -> list[int] | None:
    for run in subject["runs"]:
        if run["from"] <= frame < run["from"] + len(run["boxes"]):
            return run["boxes"][frame - run["from"]]
    return None


def _sample_frames(frame_count: int, cuts: list[int]) -> list[int]:
    bounds = [0, *cuts, frame_count]
    frames = []
    for start, end in zip(bounds, bounds[1:]):
        n = SAMPLES_PER_SHOT
        frames += sorted({start + round(i * (end - 1 - start) / (n - 1)) for i in range(n)})
    return frames


def write_built_sheet(video: Path, template: WireTemplate, out: Path) -> None:
    wanted = _sample_frames(template["frameCount"], template["cuts"])
    frames = sheets.read_frames(video, wanted)
    tiles = []
    for f in wanted:
        img = frames[f].copy()
        for i, subject in enumerate(template["subjects"]):
            box = _box_at(subject, f)
            if box is None:
                continue
            x, y, w, h = box
            color = COLORS[i % len(COLORS)]
            cv2.rectangle(img, (x, y), (x + w, y + h), color, 3)
            cv2.putText(img, subject["name"], (x + 6, y + 32), cv2.FONT_HERSHEY_SIMPLEX, 1.1, color, 3, cv2.LINE_AA)
        shot = bisect_right(template["cuts"], f) + 1
        caption = f"f{f}  {f / template['fps']:.2f} s  shot {shot}"
        tiles.append(sheets.tile(img, caption, 400, round(400 * template["height"] / template["width"])))
    sheets.write_jpg(out, sheets.grid(tiles, cols=SAMPLES_PER_SHOT))


def build(work: Path, templates_dir: Path, params: ShapeParams) -> WireTemplate:
    facts = read_facts(work)
    cuts = read_cuts(work)
    tracks = load_tracks(work / "tracks.json")
    specs = parse_subjects(json.loads((work / "subjects.json").read_text(encoding="utf-8")), set(tracks))

    subjects: list[WireSubject] = []
    for spec in specs:
        runs, overlaps = shape_subject([tracks[t] for t in spec.tracks], cuts, facts.width, facts.height, params)
        if overlaps:
            print(f"warning: {spec.id}: tracks overlap on {len(overlaps)} frames ({overlaps[0]}..{overlaps[-1]}), kept the larger box")
        ranges = ", ".join(f"[{r['from']}, {r['from'] + len(r['boxes'])})" for r in runs) or "none"
        print(f"{spec.id} ({spec.name}): {len(runs)} runs {ranges}")
        subjects.append({"id": spec.id, "name": spec.name, "runs": runs})

    template: WireTemplate = {
        "version": 1,
        "id": facts.id,
        "title": facts.title,
        "credit": facts.credit,
        "width": facts.width,
        "height": facts.height,
        "fps": facts.fps,
        "frameCount": facts.frameCount,
        "cuts": cuts,
        "subjects": subjects,
    }
    source_md = (work / "SOURCE.md").read_text(encoding="utf-8")
    print(write_template(templates_dir, template, work / "video.mp4", work / "thumb.jpg", source_md))
    write_built_sheet(work / "video.mp4", template, work / "sheets" / "built.jpg")
    return template

