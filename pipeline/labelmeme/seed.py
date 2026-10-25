from __future__ import annotations

import os
import shutil
from pathlib import Path

from labelmeme.schema import write_index

DONE_MARKER = "template.json"


def _copy_with_marker_last(seed: Path, out: Path) -> None:
    out.mkdir(exist_ok=True)
    for src in sorted(seed.iterdir()):
        if src.is_file() and src.name != DONE_MARKER:
            shutil.copyfile(src, out / src.name)
    shutil.copyfile(seed / DONE_MARKER, out / f"{DONE_MARKER}.tmp")
    os.replace(out / f"{DONE_MARKER}.tmp", out / DONE_MARKER)


def seed_templates(seed_dir: Path, templates_dir: Path) -> list[str]:
    templates_dir.mkdir(parents=True, exist_ok=True)
    copied = []
    for seed in sorted(p for p in seed_dir.glob("*/") if (p / DONE_MARKER).is_file()):
        if not (templates_dir / seed.name / DONE_MARKER).exists():
            _copy_with_marker_last(seed, templates_dir / seed.name)
            copied.append(seed.name)
    write_index(templates_dir)
    return copied
