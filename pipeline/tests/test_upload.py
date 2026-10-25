import asyncio
import hashlib
import os
import subprocess
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from labelmeme import upload
from labelmeme.job import Jobs, state_json
from labelmeme.upload import UploadError, receive, router, sweep
from labelmeme.worker import Paths
from labelmeme.youtube import source_path


@pytest.fixture(scope="session")
def mp4(tmp_path_factory: pytest.TempPathFactory) -> bytes:
    path = tmp_path_factory.mktemp("media") / "clip.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )
    return path.read_bytes()


@pytest.fixture
def paths(tmp_path: Path) -> Paths:
    return Paths(tmp_path / "work", tmp_path / "templates")


@pytest.fixture
def client(paths: Paths) -> Iterator[TestClient]:
    jobs = Jobs(paths.work_dir, paths.templates_dir, lambda job, resumed: pytest.fail("an upload must not enqueue"))
    app = FastAPI()
    app.include_router(router(jobs, paths, lambda job: {"id": job.id, "url": job.url, "state": state_json(job.state)}))
    with TestClient(app) as c:
        yield c


def _uploads_left(paths: Paths) -> list[str]:
    return sorted(p.name for p in (paths.work_dir / ".uploads").glob("*"))


def test_an_uploaded_video_becomes_a_downloaded_job(client: TestClient, paths: Paths, mp4: bytes) -> None:
    r = client.post("/api/uploads", params={"name": "Robot dance.mov"}, content=mp4)
    assert r.status_code == 201, r.text
    body = r.json()
    video_id = "upload-" + hashlib.sha256(mp4).hexdigest()[:16]
    assert body["id"] == "robot-dance"
    assert body["url"] == "upload:Robot dance.mov"
    assert body["state"] == {"kind": "downloaded", "source": {
        "videoId": video_id, "url": "upload:Robot dance.mov", "title": "Robot dance", "channel": "uploaded file",
        "duration": 2.0, "width": 320, "height": 240,
    }}
    assert source_path(paths.sources_dir, video_id).read_bytes() == mp4
    assert _uploads_left(paths) == []


def test_the_same_file_again_converges_on_the_same_source(client: TestClient, paths: Paths, mp4: bytes) -> None:
    first = client.post("/api/uploads", params={"name": "a.mp4"}, content=mp4).json()
    second = client.post("/api/uploads", params={"name": "a.mp4"}, content=mp4).json()
    assert second["id"] == "a-2"
    assert first["state"]["source"]["videoId"] == second["state"]["source"]["videoId"]
    assert [p.name for p in paths.sources_dir.iterdir()] == [first["state"]["source"]["videoId"]]
    assert _uploads_left(paths) == []


def test_a_file_that_is_not_a_video_is_refused_and_leaves_nothing(client: TestClient, paths: Paths) -> None:
    r = client.post("/api/uploads", params={"name": "noise.mp4"}, content=os.urandom(64 * 1024))
    assert r.status_code == 422
    assert r.json() == {"error": "This file is not a video ffmpeg can read.", "field": "file"}
    assert _uploads_left(paths) == []
    assert not paths.sources_dir.exists() or list(paths.sources_dir.iterdir()) == []
    assert not (paths.work_dir / "noise").exists()


def test_a_file_over_the_cap_is_refused_before_reading(client: TestClient, paths: Paths, mp4: bytes, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(upload, "MAX_UPLOAD_BYTES", len(mp4) - 1)
    r = client.post("/api/uploads", params={"name": "a.mp4"}, content=mp4)
    assert r.status_code == 413
    assert r.json()["field"] == "file"
    assert _uploads_left(paths) == []
    assert not paths.sources_dir.exists()


def test_a_body_without_a_length_is_refused(client: TestClient, paths: Paths, mp4: bytes) -> None:
    r = client.post("/api/uploads", params={"name": "a.mp4"}, content=iter([mp4]))
    assert r.status_code == 411
    assert r.json()["field"] == "file"
    assert not paths.sources_dir.exists()


def test_a_taken_id_is_refused_before_the_body_is_read(client: TestClient, paths: Paths, mp4: bytes) -> None:
    (paths.templates_dir / "tos-lab").mkdir(parents=True)
    r = client.post("/api/uploads", params={"name": "a.mp4", "id": "tos-lab"}, content=mp4)
    assert r.status_code == 409
    assert r.json()["field"] == "id"
    assert not (paths.work_dir / ".uploads").exists()
    assert not paths.sources_dir.exists()


async def _chunks(*parts: bytes) -> AsyncIterator[bytes]:
    for part in parts:
        yield part


def test_a_body_longer_than_its_stated_length_is_cut_at_the_cap(paths: Paths, mp4: bytes, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(upload, "MAX_UPLOAD_BYTES", len(mp4) - 1)
    with pytest.raises(UploadError) as e:
        asyncio.run(receive(_chunks(mp4[:100], mp4[100:]), 100, "a.mp4", paths))
    assert e.value.status == 413
    assert _uploads_left(paths) == []
    assert not paths.sources_dir.exists()


def test_sweep_deletes_uploads_left_by_a_stop(paths: Paths) -> None:
    (paths.work_dir / ".uploads").mkdir(parents=True)
    (paths.work_dir / ".uploads/dead.part").write_bytes(b"x")
    sweep(paths)
    assert _uploads_left(paths) == []
    sweep(Paths(paths.work_dir / "nowhere", paths.templates_dir))
