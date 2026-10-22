import json
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from labelmeme import worker
from labelmeme.job import Clip as JobClip
from labelmeme.job import ClipChosen, Jobs, SourceFacts, StepDone
from labelmeme.prep import VideoFacts
from labelmeme.server import create_app
from labelmeme.worker import Paths

FIXTURE = Path(__file__).resolve().parents[2] / "web/public/templates/fixture"
SOURCE = SourceFacts("abc", "https://www.youtube.com/watch?v=abc", "Fixture", "Me", 60.0, 640, 360)
ORIGIN = {"origin": "http://localhost:5184"}
FACTS = {"id": "job", "title": "Fixture", "credit": "Me", "width": 640, "height": 360, "fps": 24, "frameCount": 48}


def _clip_files(work: Path) -> None:
    for name in ("video.mp4", "thumb.jpg"):
        shutil.copyfile(FIXTURE / name, work / name)
    (work / "SOURCE.md").write_text("# job\n")
    (work / "video.json").write_text(json.dumps(FACTS))
    (work / "cuts.json").write_text(json.dumps({"cuts": [{"frame": 24}]}))


def _paths(tmp_path: Path) -> Paths:
    paths = Paths(tmp_path / "work", tmp_path / "templates")
    jobs = Jobs(paths.work_dir, paths.templates_dir, lambda job, resumed: None)
    jobs.create("job", SOURCE)
    for event in (StepDone(), ClipChosen(JobClip(1.0, 3.0, "Fixture", "Me", "l")), StepDone()):
        jobs.transition("job", event)
    _clip_files(paths.work_dir / "job")
    return paths


def _draft(track: list | None = None) -> dict:
    track = track if track is not None else [None] * 10 + [[100.5, 80, 30, 0.5]] * 14 + [None] * 24
    return {"version": 1, "title": "Drawn", "tuning": {"lagMs": 120, "smoothRadius": 3},
            "subjects": [{"id": "s1", "name": "Thom", "color": "#f5a524", "track": track}]}


def _save(client: TestClient, subjects: list) -> object:
    return client.post("/api/jobs/job/save", json={"title": "Drawn", "subjects": subjects}, headers=ORIGIN)


RUNS = [{"from": 10, "boxes": [[90, 80, 40, 1]] * 14}]


def test_a_fresh_job_has_an_empty_draft_and_the_clip_facts(tmp_path: Path) -> None:
    with TestClient(create_app(_paths(tmp_path), 5184)) as client:
        res = client.get("/api/jobs/job/draft")
    assert res.status_code == 200, res.text
    assert res.json() == {
        "draft": {"version": 1, "title": "Fixture", "tuning": {"lagMs": 150, "smoothRadius": 4}, "subjects": []},
        "clip": {"width": 640, "height": 360, "fps": 24, "frameCount": 48, "cuts": [24]},
    }


def test_put_twice_writes_the_same_bytes_and_get_echoes_them(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    with TestClient(create_app(paths, 5184)) as client:
        assert client.put("/api/jobs/job/draft", json=_draft(), headers=ORIGIN).status_code == 204
        first = (paths.work_dir / "job/draft.json").read_bytes()
        assert client.put("/api/jobs/job/draft", json=_draft(), headers=ORIGIN).status_code == 204
        assert (paths.work_dir / "job/draft.json").read_bytes() == first
        assert client.get("/api/jobs/job/draft").json()["draft"] == _draft()


def test_put_with_a_blank_title_keeps_the_drawing_and_save_still_refuses_it(tmp_path: Path) -> None:
    with TestClient(create_app(_paths(tmp_path), 5184)) as client:
        assert client.put("/api/jobs/job/draft", json=_draft() | {"title": ""}, headers=ORIGIN).status_code == 204
        assert client.get("/api/jobs/job/draft").json()["draft"] == _draft() | {"title": ""}
        res = client.post("/api/jobs/job/save", json={"title": " ", "subjects": [{"id": "s1", "name": "Thom", "runs": RUNS}]}, headers=ORIGIN)
        assert res.status_code == 422
    assert not (tmp_path / "templates/job").exists()


def test_put_with_a_bad_track_names_the_field_and_writes_nothing(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    with TestClient(create_app(paths, 5184)) as client:
        res = client.put("/api/jobs/job/draft", json=_draft([None] * 47), headers=ORIGIN)
    assert (res.status_code, res.json()["field"]) == (422, "$.subjects[0].track")
    assert not (paths.work_dir / "job/draft.json").exists()


def test_put_while_downloading_is_a_conflict(tmp_path: Path) -> None:
    paths = Paths(tmp_path / "work", tmp_path / "templates")
    Jobs(paths.work_dir, paths.templates_dir, lambda job, resumed: None).create("job", SOURCE)
    client = TestClient(create_app(paths, 5184))
    assert client.put("/api/jobs/job/draft", json=_draft(), headers=ORIGIN).status_code == 409


def test_save_writes_the_template_and_a_second_save_rewrites_it(tmp_path: Path) -> None:
    with TestClient(create_app(_paths(tmp_path), 5184)) as client:
        res = _save(client, [{"id": "s1", "name": " Thom ", "runs": RUNS}])
        assert res.status_code == 200, res.text
        assert res.json()["state"]["kind"] == "ready"
        template = json.loads((tmp_path / "templates/job/template.json").read_text())
        assert (template["title"], template["subjects"]) == ("Drawn", [{"id": "s1", "name": "Thom", "runs": RUNS}])
        assert _save(client, [{"id": "s1", "name": "Bob", "runs": RUNS}]).status_code == 200
        assert json.loads((tmp_path / "templates/job/template.json").read_text())["subjects"][0]["name"] == "Bob"


@pytest.mark.parametrize(("subjects", "field"), [
    ([], "subjects"),
    ([{"id": "s1", "name": "  ", "runs": RUNS}], "subjects[0].name"),
    ([{"id": "s1", "name": "Thom", "runs": [{"from": 20, "boxes": [[90, 80, 40, 1]] * 8}]}], "$.subjects[0].runs[0]"),
])
def test_save_refuses_and_names_the_field(tmp_path: Path, subjects: list, field: str) -> None:
    with TestClient(create_app(_paths(tmp_path), 5184)) as client:
        res = _save(client, subjects)
        assert (res.status_code, res.json()["field"]) == (422, field)
        assert client.get("/api/jobs/job").json()["state"]["kind"] == "editing"
    assert not (tmp_path / "templates/job").exists()


def test_a_new_clip_removes_the_draft(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    paths = _paths(tmp_path)
    sources = paths.sources_dir / "abc"
    sources.mkdir(parents=True)
    (sources / "source.mp4").write_bytes(b"")

    def fake_prep(spec: object, work: Path, command: str) -> VideoFacts:
        _clip_files(work)
        return VideoFacts(**FACTS)

    monkeypatch.setattr(worker, "prep", fake_prep)
    monkeypatch.setattr(worker, "write_cuts", lambda work, fps: [])
    with TestClient(create_app(paths, 5184)) as client:
        assert client.put("/api/jobs/job/draft", json=_draft(), headers=ORIGIN).status_code == 204
        res = client.put("/api/jobs/job/clip", json={"start": 2, "end": 5, "title": "New", "credit": "Me"}, headers=ORIGIN)
        assert res.status_code == 200, res.text
        for _ in range(200):
            if client.get("/api/jobs/job").json()["state"]["kind"] == "editing":
                break
            time.sleep(0.02)
        assert client.get("/api/jobs/job").json()["state"]["kind"] == "editing"
        assert client.get("/api/jobs/job/draft").json()["draft"]["subjects"] == []
