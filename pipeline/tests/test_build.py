import json
import shutil
from pathlib import Path

from labelmeme.authoring import Authoring, dump_authoring
from labelmeme.build import build
from labelmeme.plan import HiddenKey, PointKey, Subject, Tracked
from labelmeme.schema import validate_template
from labelmeme.shaping import ShapeParams

FIXTURE = Path(__file__).resolve().parents[2] / "web/public/templates/fixture"
BOX = (100, 50, 40, 80)


def _work(tmp_path: Path, authoring: Authoring) -> Path:
    work = tmp_path / "work/built"
    work.mkdir(parents=True)
    shutil.copyfile(FIXTURE / "video.mp4", work / "video.mp4")
    shutil.copyfile(FIXTURE / "thumb.jpg", work / "thumb.jpg")
    (work / "SOURCE.md").write_text("# built\n")
    facts = {"id": "built", "title": "Prep title", "credit": "c", "width": 640, "height": 360, "fps": 24, "frameCount": 48}
    (work / "video.json").write_text(json.dumps(facts))
    (work / "cuts.json").write_text(json.dumps({"cuts": [{"frame": 24}]}))
    (work / "authoring.json").write_text(dump_authoring(authoring))
    return work


def _tracked(start: int, stop: int) -> Tracked:
    return Tracked(start, tuple(BOX for _ in range(start, stop)))


def test_build_writes_the_tracked_segments_and_nothing_after_a_hide(tmp_path: Path) -> None:
    thom = Subject("s1", "Thom", "#f5b800", (PointKey(4, (120, 90)), HiddenKey(16), PointKey(30, (110, 80))))
    nobody = Subject("s2", "", "#2f7df6", ())
    authoring = Authoring(3, "Edited title", (thom, nobody), {
        "lead|0-4|4@120,90": _tracked(0, 4),
        "tail|4-16|4@120,90": _tracked(4, 16),
        "tail|30-48|30@110,80": _tracked(30, 48),
        "tail|4-24|4@120,90": _tracked(4, 24),
    })

    template = build(_work(tmp_path, authoring), tmp_path / "templates", ShapeParams())

    validate_template(template)
    assert template["title"] == "Edited title"
    assert template["cuts"] == [24]
    assert [s["id"] for s in template["subjects"]] == ["s1"]
    runs = template["subjects"][0]["runs"]
    assert [(r["from"], r["from"] + len(r["boxes"])) for r in runs] == [(0, 16), (30, 48)]
    written = json.loads((tmp_path / "templates/built/template.json").read_text())
    assert written == template
    index = json.loads((tmp_path / "templates/index.json").read_text())
    assert [(t["id"], t["subjectCount"]) for t in index["templates"]] == [("built", 1)]


def test_a_hide_shorter_than_the_gap_fill_still_breaks_the_run(tmp_path: Path) -> None:
    thom = Subject("s1", "Thom", "#f5b800", (PointKey(2, (120, 90)), HiddenKey(10), PointKey(14, (110, 80))))
    authoring = Authoring(1, "T", (thom,), {
        "lead|0-2|2@120,90": _tracked(0, 2),
        "tail|2-10|2@120,90": _tracked(2, 10),
        "tail|14-24|14@110,80": _tracked(14, 24),
    })

    template = build(_work(tmp_path, authoring), tmp_path / "templates", ShapeParams())

    runs = template["subjects"][0]["runs"]
    assert [(r["from"], r["from"] + len(r["boxes"])) for r in runs] == [(0, 10), (14, 24)]
