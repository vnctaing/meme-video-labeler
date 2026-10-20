import json
import shutil
import time
from collections.abc import Callable
from pathlib import Path

from fastapi.testclient import TestClient

from labelmeme.authoring import AuthoringStore
from labelmeme.job import Clip as JobClip
from labelmeme.job import ClipChosen, Jobs, SourceFacts, StepDone
from labelmeme.plan import PointKey, Segment, Subject, Tracked
from labelmeme.server import create_app
from labelmeme.tracker import Cancelled, Clip
from labelmeme.worker import Paths

FIXTURE = Path(__file__).resolve().parents[2] / "web/public/templates/fixture"
SOURCE = SourceFacts("abc", "https://www.youtube.com/watch?v=abc", "Fixture", "Me", 60.0, 640, 360)
BOX = (100, 50, 40, 80)
ORIGIN = {"origin": "http://localhost:5184"}


class FakeTracker:
    def __init__(self) -> None:
        self.tracked: list[str] = []

    def track(self, clip: Clip, seg: Segment, *, on_frame: Callable[[int, int], None], cancelled: Callable[[], bool]) -> Tracked:
        for i in range(3):
            on_frame(i + 1, 3)
            if cancelled():
                raise Cancelled(seg.key)
        self.tracked.append(seg.key)
        return Tracked(seg.start, tuple(BOX for _ in range(seg.start, seg.stop)))


def _paths(tmp_path: Path) -> Paths:
    paths = Paths(tmp_path / "work", tmp_path / "models", tmp_path / "templates")
    jobs = Jobs(paths.work_dir, paths.templates_dir, lambda job, resumed: None)
    jobs.create("job", SOURCE)
    for event in (StepDone(), ClipChosen(JobClip(1.0, 3.0, "Fixture", "Me", "l")), StepDone()):
        jobs.transition("job", event)
    work = paths.work_dir / "job"
    for name in ("video.mp4", "thumb.jpg"):
        shutil.copyfile(FIXTURE / name, work / name)
    (work / "SOURCE.md").write_text("# job\n")
    (work / "video.json").write_text(json.dumps({"id": "job", "title": "Fixture", "credit": "Me", "width": 640, "height": 360, "fps": 24, "frameCount": 48}))
    (work / "cuts.json").write_text(json.dumps({"cuts": [{"frame": 24}]}))
    AuthoringStore(paths.work_dir).reset("job", "Fixture")
    return paths


def _settled(client: TestClient) -> dict:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        view = client.get("/api/jobs/job/authoring").json()
        if all(seg["status"] == "done" for t in view["tracks"].values() for seg in t["segments"]):
            return view
        time.sleep(0.02)
    raise AssertionError(f"segments did not finish: {view}")


def _put(client: TestClient, *keyframes: dict) -> dict:
    subjects = [{"id": "s1", "name": "Thom", "color": "#f5b800", "keyframes": list(keyframes)}]
    res = client.put("/api/jobs/job/authoring", json={"title": "Edited", "subjects": subjects}, headers=ORIGIN)
    assert res.status_code == 200, res.text
    return res.json()


def test_a_correction_retracks_only_its_two_segments_and_save_writes_the_hide(tmp_path: Path) -> None:
    fake = FakeTracker()
    with TestClient(create_app(_paths(tmp_path), 5184, fake)) as client:
        _put(client, {"frame": 10, "point": [120, 90]})
        view = _settled(client)
        assert fake.tracked == ["tail|10-24|10@120,90", "lead|0-10|10@120,90"]
        assert [(r["from"], len(r["boxes"])) for r in view["tracks"]["s1"]["runs"]] == [(0, 24)]

        fake.tracked.clear()
        _put(client, {"frame": 10, "point": [120, 90]}, {"frame": 18, "point": [130, 95]})
        _settled(client)
        assert sorted(fake.tracked) == ["bridge|10-18|10@120,90;18@130,95", "tail|18-24|18@130,95"]

        fake.tracked.clear()
        _put(client, {"frame": 10, "point": [120, 90]}, {"frame": 18, "point": [130, 95]}, {"frame": 20, "hidden": True})
        _settled(client)
        assert fake.tracked == ["tail|18-20|18@130,95"]

        res = client.post("/api/jobs/job/save", headers=ORIGIN)
        assert res.status_code == 200, res.text
        assert res.json()["state"]["kind"] == "ready"
        template = json.loads((tmp_path / "templates/job/template.json").read_text())
        assert template["title"] == "Edited"
        assert [(r["from"], len(r["boxes"])) for r in template["subjects"][0]["runs"]] == [(0, 20)]


def test_a_restart_tracks_the_segments_a_crash_left_missing(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    AuthoringStore(paths.work_dir).edit("job", (Subject("s1", "Thom", "#f5b800", (PointKey(30, (120, 90)),)),), "Fixture")
    fake = FakeTracker()
    with TestClient(create_app(paths, 5184, fake)) as client:
        _settled(client)
    assert sorted(fake.tracked) == ["lead|24-30|30@120,90", "tail|30-48|30@120,90"]


def test_save_refuses_while_segments_track_and_names_a_blank_name(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    with TestClient(create_app(paths, 5184, FakeTracker())) as client:
        subjects = [{"id": "s1", "name": "", "color": "#f5b800", "keyframes": [{"frame": 30, "point": [120, 90]}]}]
        client.put("/api/jobs/job/authoring", json={"title": "T", "subjects": subjects}, headers=ORIGIN)
        _settled(client)
        res = client.post("/api/jobs/job/save", headers=ORIGIN)
        assert (res.status_code, res.json()["field"]) == (422, "subjects[0].name")
        bad = client.put("/api/jobs/job/authoring", json={"title": "T", "subjects": [{**subjects[0], "keyframes": [{"frame": 99, "hidden": True}]}]}, headers=ORIGIN)
        assert (bad.status_code, bad.json()["field"]) == (422, "subjects[0].keyframes[0].frame")
