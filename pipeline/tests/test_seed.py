import json
import shutil
from pathlib import Path

from labelmeme.seed import seed_templates

TEMPLATES = Path(__file__).resolve().parents[2] / "web/public/templates"
SEEDS = ("tos-lab", "tos-robot")
FILES = ("template.json", "video.mp4", "thumb.jpg", "SOURCE.md")


def _seed_dir(tmp_path: Path) -> Path:
    seed = tmp_path / "site/templates"
    for tid in SEEDS:
        shutil.copytree(TEMPLATES / tid, seed / tid)
    shutil.copyfile(TEMPLATES / "index.json", seed / "index.json")
    return seed


def _snapshot(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def _indexed(templates: Path) -> list[str]:
    return [t["id"] for t in json.loads((templates / "index.json").read_text())["templates"]]


def test_an_empty_dir_gets_every_seed_and_an_index_of_them(tmp_path: Path) -> None:
    seed, templates = _seed_dir(tmp_path), tmp_path / "data/templates"
    assert sorted(seed_templates(seed, templates)) == list(SEEDS)
    for tid in SEEDS:
        for name in FILES:
            assert (templates / tid / name).read_bytes() == (seed / tid / name).read_bytes()
    assert _indexed(templates) == list(SEEDS)


def test_a_second_run_copies_nothing_and_changes_no_byte(tmp_path: Path) -> None:
    seed, templates = _seed_dir(tmp_path), tmp_path / "data/templates"
    seed_templates(seed, templates)
    before = _snapshot(templates)
    assert seed_templates(seed, templates) == []
    assert _snapshot(templates) == before


def test_an_edited_template_is_never_overwritten(tmp_path: Path) -> None:
    seed, templates = _seed_dir(tmp_path), tmp_path / "data/templates"
    seed_templates(seed, templates)
    edited = json.loads((templates / "tos-lab/template.json").read_text()) | {"title": "Edited on the volume"}
    (templates / "tos-lab/template.json").write_text(json.dumps(edited))
    assert seed_templates(seed, templates) == []
    assert json.loads((templates / "tos-lab/template.json").read_text())["title"] == "Edited on the volume"


def test_a_copy_cut_off_before_template_json_is_finished_on_the_next_run(tmp_path: Path) -> None:
    seed, templates = _seed_dir(tmp_path), tmp_path / "data/templates"
    (templates / "tos-robot").mkdir(parents=True)
    (templates / "tos-robot/video.mp4").write_bytes(b"half a vid")
    assert sorted(seed_templates(seed, templates)) == list(SEEDS)
    assert (templates / "tos-robot/video.mp4").read_bytes() == (seed / "tos-robot/video.mp4").read_bytes()
    assert "tos-robot" in _indexed(templates)


def test_templates_saved_on_the_volume_stay_in_the_index(tmp_path: Path) -> None:
    seed, templates = _seed_dir(tmp_path), tmp_path / "data/templates"
    shutil.copytree(TEMPLATES / "kakashi-vs-obito", templates / "kakashi-vs-obito")
    seed_templates(seed, templates)
    assert _indexed(templates) == ["kakashi-vs-obito", *SEEDS]


def test_a_missing_seed_dir_still_writes_an_index(tmp_path: Path) -> None:
    templates = tmp_path / "data/templates"
    assert seed_templates(tmp_path / "nowhere", templates) == []
    assert _indexed(templates) == []
