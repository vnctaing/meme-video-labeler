import json
import shutil
from pathlib import Path

import pytest

from labelmeme.build import build

FIXTURE = Path(__file__).resolve().parents[2] / "web/public/templates/fixture"


def _work(tmp_path: Path) -> Path:
    work = tmp_path / "work/built"
    work.mkdir(parents=True)
    shutil.copyfile(FIXTURE / "video.mp4", work / "video.mp4")
    shutil.copyfile(FIXTURE / "thumb.jpg", work / "thumb.jpg")
    (work / "SOURCE.md").write_text("# built\n")
    facts = {"id": "built", "title": "Prep title", "credit": "c", "width": 640, "height": 360, "fps": 24, "frameCount": 48}
    (work / "video.json").write_text(json.dumps(facts))
    (work / "cuts.json").write_text(json.dumps({"cuts": [{"frame": 24}]}))
    return work


def test_build_writes_the_given_runs_with_the_cuts_and_lists_the_template(tmp_path: Path) -> None:
    runs = [{"from": 4, "boxes": [[100, 50, 40, 1]] * 20}, {"from": 24, "boxes": [[110, 60, 40, 1]] * 4}]
    template = build(_work(tmp_path), tmp_path / "templates", "Drawn", [{"id": "s1", "name": "Thom", "runs": runs}])

    written = json.loads((tmp_path / "templates/built/template.json").read_text())
    assert written == template
    assert (written["title"], written["cuts"], written["subjects"][0]["runs"]) == ("Drawn", [24], runs)
    index = json.loads((tmp_path / "templates/index.json").read_text())
    assert [(t["id"], t["subjectCount"]) for t in index["templates"]] == [("built", 1)]


def test_a_run_across_the_cut_is_refused_and_nothing_is_written(tmp_path: Path) -> None:
    runs = [{"from": 20, "boxes": [[100, 50, 40, 1]] * 8}]
    with pytest.raises(ValueError, match="cut"):
        build(_work(tmp_path), tmp_path / "templates", "Drawn", [{"id": "s1", "name": "Thom", "runs": runs}])
    assert not (tmp_path / "templates").exists()
