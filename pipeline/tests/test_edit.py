import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from labelmeme.job import Clip as JobClip
from labelmeme.job import ClipChosen, Jobs, Saved, SourceFacts, StepDone
from labelmeme.server import create_app
from labelmeme.worker import Paths

FIXTURE = Path(__file__).resolve().parents[2] / "web/public/templates/fixture"
SOURCE = SourceFacts("abc", "https://www.youtube.com/watch?v=abc", "Fixture", "Me", 60.0, 640, 360)
ORIGIN = {"origin": "http://localhost:5184"}


def _paths(tmp_path: Path, *job_events: object) -> Paths:
    paths = Paths(tmp_path / "work", tmp_path / "templates")
    if job_events:
        jobs = Jobs(paths.work_dir, paths.templates_dir, lambda job, resumed: None)
        jobs.create("fixture", SOURCE)
        for event in job_events:
            jobs.transition("fixture", event)
    shutil.copytree(FIXTURE, paths.templates_dir / "fixture")
    return paths


def _template(paths: Paths) -> dict:
    return json.loads((paths.templates_dir / "fixture/template.json").read_text(encoding="utf-8"))


def _imported_draft(template: dict) -> dict:
    subjects = []
    for s in template["subjects"]:
        track: list = [None] * template["frameCount"]
        for run in s["runs"]:
            for i, box in enumerate(run["boxes"]):
                track[run["from"] + i] = {"box": box}
        subjects.append({"id": s["id"], "name": s["name"], "color": "#f5a524", "track": track})
    return {"version": 1, "title": template["title"], "tuning": {"lagMs": 150, "smoothRadius": 4}, "subjects": subjects}


def _save_body(template: dict) -> dict:
    return {"title": template["title"], "subjects": template["subjects"]}


CHOSEN = ClipChosen(JobClip(1.0, 3.0, "Fixture", "Me", "l"))


def test_opening_a_template_with_no_draft_answers_null_and_writes_nothing(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    with TestClient(create_app(paths, 5184)) as client:
        res = client.get("/api/templates/fixture/draft")
    assert res.status_code == 200, res.text
    assert res.json() == {"draft": None, "clip": {"width": 640, "height": 360, "fps": 24, "frameCount": 48, "cuts": [24]}}
    assert list(paths.work_dir.iterdir()) == []


def test_the_first_edit_adds_only_the_draft_and_leaves_leftover_files_alone(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    leftover = paths.work_dir / "fixture"
    (leftover / "sheets").mkdir(parents=True)
    for name, data in (("tracks.json", b"{}"), ("video.json", b'{"id":"fixture"}'), ("video.mp4", b"mp4"), ("sheets/0.png", b"png")):
        (leftover / name).write_bytes(data)
    before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in leftover.rglob("*") if p.is_file()}
    draft = _imported_draft(_template(paths))
    with TestClient(create_app(paths, 5184)) as client:
        assert client.put("/api/templates/fixture/draft", json=draft, headers=ORIGIN).status_code == 204
        assert client.get("/api/templates/fixture/draft").json()["draft"] == draft
    after = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in leftover.rglob("*") if p.is_file()}
    assert {p.name for p in set(after) - set(before)} == {"draft.json"}
    assert {p: after[p] for p in before} == before


def test_saving_untouched_writes_the_same_template_bytes(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    original = (paths.templates_dir / "fixture/template.json").read_bytes()
    with TestClient(create_app(paths, 5184)) as client:
        res = client.post("/api/templates/fixture/save", json=_save_body(_template(paths)), headers=ORIGIN)
    assert res.status_code == 200, res.text
    assert (paths.templates_dir / "fixture/template.json").read_bytes() == original
    index = json.loads((paths.templates_dir / "index.json").read_text(encoding="utf-8"))
    assert [(e["id"], e["subjectCount"]) for e in index["templates"]] == [("fixture", 2)]


def test_saving_an_edit_replaces_only_the_title_and_subjects(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    original = _template(paths)
    added = {"id": "s1", "name": " Carol ", "runs": [{"from": 30, "boxes": [[10, 10, 50, 1]] * 4}]}
    body = {"title": "Renamed", "subjects": [*original["subjects"], added]}
    with TestClient(create_app(paths, 5184)) as client:
        assert client.post("/api/templates/fixture/save", json=body, headers=ORIGIN).status_code == 200
    saved = _template(paths)
    assert saved == original | {"title": "Renamed", "subjects": [*original["subjects"], added | {"name": "Carol"}]}


@pytest.mark.parametrize(("method", "url"), [
    ("GET", "/api/templates/nope/draft"),
    ("PUT", "/api/templates/nope/draft"),
    ("POST", "/api/templates/nope/save"),
])
def test_an_unknown_template_is_not_found(tmp_path: Path, method: str, url: str) -> None:
    paths = _paths(tmp_path)
    body = {"title": "x", "subjects": []} if method == "POST" else _imported_draft(_template(paths))
    with TestClient(create_app(paths, 5184)) as client:
        res = client.request(method, url, json=None if method == "GET" else body, headers=ORIGIN)
    assert res.status_code == 404, res.text
    assert not (paths.work_dir / "nope").exists()


@pytest.mark.parametrize("events", [(StepDone(), CHOSEN), (StepDone(), CHOSEN, StepDone())], ids=["preparing", "editing"])
def test_a_job_that_is_not_ready_blocks_editing_its_template(tmp_path: Path, events: tuple) -> None:
    paths = _paths(tmp_path, *events)
    original = (paths.templates_dir / "fixture/template.json").read_bytes()
    with TestClient(create_app(paths, 5184)) as client:
        assert client.get("/api/templates/fixture/draft").status_code == 409
        assert client.put("/api/templates/fixture/draft", json=_imported_draft(_template(paths)), headers=ORIGIN).status_code == 409
        assert client.post("/api/templates/fixture/save", json=_save_body(_template(paths)), headers=ORIGIN).status_code == 409
    assert not (paths.work_dir / "fixture/draft.json").exists()
    assert (paths.templates_dir / "fixture/template.json").read_bytes() == original


def test_a_ready_job_stays_ready_after_its_template_is_saved(tmp_path: Path) -> None:
    paths = _paths(tmp_path, StepDone(), CHOSEN, StepDone(), Saved())
    job_json = paths.work_dir / "fixture/job.json"
    before = job_json.read_bytes()
    with TestClient(create_app(paths, 5184)) as client:
        assert client.get("/api/templates/fixture/draft").status_code == 200
        assert client.post("/api/templates/fixture/save", json=_save_body(_template(paths)), headers=ORIGIN).status_code == 200
        assert client.get("/api/jobs/fixture").json()["state"]["kind"] == "ready"
    assert job_json.read_bytes() == before
