from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from labelmeme.draft import ClipFacts, parse_draft, write_draft
from labelmeme.schema import SLUG, WireSubject, WireTemplate, validate_template, write_atomic, write_template

log = logging.getLogger(__name__)


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


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _move_aside(path: Path, reason: str) -> Path:
    aside = path.with_name(f"draft.{reason}-{datetime.now(UTC):%Y%m%dT%H%M%S%fZ}.json")
    path.rename(aside)
    return aside


def read_draft_if_any(work: Path, template_path: Path, clip: ClipFacts) -> dict | None:
    path, base = work / "draft.json", work / "draft.base"
    if not path.is_file():
        return None
    if base.is_file() and base.read_text(encoding="utf-8").strip() != _sha256(template_path):
        aside = _move_aside(path, "stale")
        base.unlink()
        log.warning("moved a draft of an older %s to %s", template_path, aside)
        return None
    try:
        return parse_draft(json.loads(path.read_text(encoding="utf-8")), clip)
    except ValueError as e:
        aside = _move_aside(path, "corrupt")
        log.warning("moved a draft that cannot be read to %s: %s", aside, e)
        return None


def write_draft_of(work: Path, template_path: Path, draft: dict) -> None:
    work.mkdir(parents=True, exist_ok=True)
    write_draft(work, draft)
    write_atomic(work / "draft.base", _sha256(template_path) + "\n")


def save_in_place(templates_dir: Path, work: Path, template: WireTemplate, title: str, subjects: list[WireSubject]) -> WireTemplate:
    saved: WireTemplate = {**template, "title": title, "subjects": subjects}
    tdir = templates_dir / template["id"]
    write_template(templates_dir, saved, tdir / "video.mp4", tdir / "thumb.jpg", (tdir / "SOURCE.md").read_text(encoding="utf-8"))
    if (work / "draft.json").is_file():
        write_atomic(work / "draft.base", _sha256(tdir / "template.json") + "\n")
    return saved
