import copy
import json
from pathlib import Path

import pytest

from labelmeme.fixture import fixture_template
from labelmeme.schema import WireTemplate, validate_template, write_template


@pytest.fixture
def template() -> WireTemplate:
    return copy.deepcopy(fixture_template())


def test_accepts_fixture(template: WireTemplate) -> None:
    validate_template(template)


def test_rejects_overlapping_runs(template: WireTemplate) -> None:
    template["subjects"][1]["runs"][1]["from"] = 10
    with pytest.raises(ValueError, match=r"^\$\.subjects\[1\]\.runs\[1\]\.from: run starts at 10, before the previous run ends at 20"):
        validate_template(template)


def test_rejects_run_crossing_a_cut(template: WireTemplate) -> None:
    alice = template["subjects"][0]
    alice["runs"] = [{"from": 0, "boxes": alice["runs"][0]["boxes"] + alice["runs"][1]["boxes"]}]
    with pytest.raises(ValueError, match=r"^\$\.subjects\[0\]\.runs\[0\]: run \[0, 48\) crosses cut 24"):
        validate_template(template)


def test_rejects_box_outside_the_frame(template: WireTemplate) -> None:
    template["subjects"][1]["runs"][0]["boxes"][3] = [600, 160, 100, 160]
    with pytest.raises(ValueError, match=r"^\$\.subjects\[1\]\.runs\[0\]\.boxes\[3\]: box .* is outside the 640x360 frame"):
        validate_template(template)


def test_rejects_unsorted_cuts(template: WireTemplate) -> None:
    template["cuts"] = [30, 24]
    with pytest.raises(ValueError, match=r"^\$\.cuts\[1\]: cuts must be sorted and unique"):
        validate_template(template)


def test_rejects_non_integer_fps(template: WireTemplate) -> None:
    template["fps"] = 23.976
    with pytest.raises(ValueError, match=r"^\$\.fps: expected an integer"):
        validate_template(template)


def test_rejects_duplicate_subject_ids(template: WireTemplate) -> None:
    template["subjects"][1]["id"] = "alice"
    with pytest.raises(ValueError, match=r"^\$\.subjects\[1\]\.id: duplicate subject id"):
        validate_template(template)


def test_write_template_is_idempotent_and_indexes_every_template(tmp_path: Path, template: WireTemplate) -> None:
    video, thumb = tmp_path / "v.mp4", tmp_path / "t.jpg"
    video.write_bytes(b"video")
    thumb.write_bytes(b"thumb")
    out = tmp_path / "templates"
    other = copy.deepcopy(template)
    other["id"] = "another"

    write_template(out, other, video, thumb, "other\n")
    write_template(out, template, video, thumb, "source\n")
    first = {p: p.read_bytes() for p in out.rglob("*") if p.is_file()}
    write_template(out, template, video, thumb, "source\n")
    second = {p: p.read_bytes() for p in out.rglob("*") if p.is_file()}

    assert second == first
    assert json.loads((out / "fixture" / "template.json").read_text()) == template
    assert (out / "fixture" / "video.mp4").read_bytes() == b"video"
    index = json.loads((out / "index.json").read_text())
    assert [e["id"] for e in index["templates"]] == ["another", "fixture"]
    assert index["templates"][1] == {
        "id": "fixture", "title": template["title"], "credit": template["credit"],
        "width": 640, "height": 360, "fps": 24, "frameCount": 48, "subjectCount": 2,
    }


def test_write_template_refuses_an_invalid_template(tmp_path: Path, template: WireTemplate) -> None:
    template["cuts"] = [0]
    with pytest.raises(ValueError, match=r"^\$\.cuts\[0\]"):
        write_template(tmp_path, template, tmp_path / "v", tmp_path / "t", "")
    assert list(tmp_path.iterdir()) == []
