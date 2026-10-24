from __future__ import annotations

import json
from pathlib import Path

from labelmeme.draft import ClipFacts, parse_draft
from labelmeme.schema import SLUG, WireSubject, WireTemplate, validate_template, write_template


class UnknownTemplate(KeyError):
    pass


def open_template(templates_dir: Path, template_id: str) -> tuple[WireTemplate, ClipFacts]:
    path = templates_dir / template_id / "template.json"
    if SLUG.fullmatch(template_id) is None or not path.is_file():
        raise UnknownTemplate(template_id)
    template: WireTemplate = json.loads(path.read_text(encoding="utf-8"))
    validate_template(template)
    clip = ClipFacts(template["fps"], template["frameCount"], template["width"], template["height"], tuple(template["cuts"]))
    return template, clip


def read_draft_if_any(work: Path, clip: ClipFacts) -> dict | None:
    path = work / "draft.json"
    if not path.is_file():
        return None
    return parse_draft(json.loads(path.read_text(encoding="utf-8")), clip)


def save_in_place(templates_dir: Path, template: WireTemplate, title: str, subjects: list[WireSubject]) -> WireTemplate:
    saved: WireTemplate = {**template, "title": title, "subjects": subjects}
    tdir = templates_dir / template["id"]
    write_template(templates_dir, saved, tdir / "video.mp4", tdir / "thumb.jpg", (tdir / "SOURCE.md").read_text(encoding="utf-8"))
    return saved
