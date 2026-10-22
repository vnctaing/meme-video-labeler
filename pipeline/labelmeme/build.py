from __future__ import annotations

from pathlib import Path

from labelmeme.cuts import read_cuts
from labelmeme.prep import read_facts
from labelmeme.schema import WireSubject, WireTemplate, write_template


def build(work: Path, templates_dir: Path, title: str, subjects: list[WireSubject]) -> WireTemplate:
    facts = read_facts(work)
    template: WireTemplate = {
        "version": 1,
        "id": facts.id,
        "title": title,
        "credit": facts.credit,
        "width": facts.width,
        "height": facts.height,
        "fps": facts.fps,
        "frameCount": facts.frameCount,
        "cuts": read_cuts(work, facts.frameCount),
        "subjects": subjects,
    }
    source_md = (work / "SOURCE.md").read_text(encoding="utf-8")
    write_template(templates_dir, template, work / "video.mp4", work / "thumb.jpg", source_md)
    return template
