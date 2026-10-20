from __future__ import annotations

import json
from bisect import bisect_right
from pathlib import Path

import cv2

from labelmeme import plan, sheets
from labelmeme.authoring import parse_authoring, read_clip
from labelmeme.prep import read_facts
from labelmeme.schema import WireSubject, WireTemplate, write_template
from labelmeme.shaping import ShapeParams, shape_subject

SAMPLES_PER_SHOT = 4
COLORS = [(0, 200, 255), (255, 120, 0), (80, 220, 80), (220, 80, 220), (0, 80, 255)]


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
    clip = read_clip(work)
    a = parse_authoring(json.loads((work / "authoring.json").read_text(encoding="utf-8")), clip)

    subjects: list[WireSubject] = []
    for s in a.subjects:
        frames = plan.boxes_by_frame(plan.plan_subject(s.keyframes, clip.cuts, clip.frame_count), a.segments)
        runs = shape_subject(frames, clip.cuts, clip.width, clip.height, params)
        if runs:
            subjects.append({"id": s.id, "name": s.name, "runs": runs})

    template: WireTemplate = {
        "version": 1,
        "id": facts.id,
        "title": a.title,
        "credit": facts.credit,
        "width": facts.width,
        "height": facts.height,
        "fps": facts.fps,
        "frameCount": facts.frameCount,
        "cuts": list(clip.cuts),
        "subjects": subjects,
    }
    source_md = (work / "SOURCE.md").read_text(encoding="utf-8")
    write_template(templates_dir, template, work / "video.mp4", work / "thumb.jpg", source_md)
    write_built_sheet(work / "video.mp4", template, work / "sheets" / "built.jpg")
    return template
