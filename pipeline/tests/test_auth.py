import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from labelmeme.server import COOKIE, author_token, create_app
from labelmeme.worker import Paths

FIXTURE = Path(__file__).resolve().parents[2] / "web/public/templates/fixture"
SIGNED_IN = {"cookie": f"{COOKIE}={author_token('pw')}"}
LOCKED = [
    ("GET", "/api/jobs"),
    ("POST", "/api/jobs"),
    ("GET", "/api/jobs/fixture/source.mp4"),
    ("GET", "/api/templates/x/draft"),
    ("PUT", "/api/templates/x/draft"),
    ("POST", "/api/uploads?name=a.mp4"),
    ("GET", "/api/session"),
]


def _site(tmp_path: Path) -> Path:
    site = tmp_path / "site"
    (site / "assets").mkdir(parents=True)
    (site / "index.html").write_text("<!doctype html><title>labelmeme</title>")
    (site / "assets/x.js").write_text("console.log(1)")
    return site


def _app(tmp_path: Path, password: str | None = "pw"):
    paths = Paths(tmp_path / "work", tmp_path / "templates")
    shutil.copytree(FIXTURE, paths.templates_dir / "fixture")
    return create_app(paths, 5184, password=password, site_dir=_site(tmp_path))


@pytest.mark.parametrize(("method", "path"), LOCKED)
def test_the_api_refuses_a_request_without_the_cookie(tmp_path: Path, method: str, path: str) -> None:
    with TestClient(_app(tmp_path)) as client:
        res = client.request(method, path, content=b"x")
    assert (res.status_code, res.json()) == (401, {"error": "sign in first", "field": None})
    assert "www-authenticate" not in res.headers


@pytest.mark.parametrize(("method", "path"), LOCKED)
def test_a_forged_cookie_is_refused(tmp_path: Path, method: str, path: str) -> None:
    with TestClient(_app(tmp_path)) as client:
        res = client.request(method, path, content=b"x", headers={"cookie": f"{COOKIE}={author_token('guess')}"})
    assert res.status_code == 401


def test_the_site_and_the_templates_are_open(tmp_path: Path) -> None:
    with TestClient(_app(tmp_path)) as client:
        assert client.get("/").text.startswith("<!doctype html>")
        assert client.get("/templates/index.json").json()["templates"][0]["id"] == "fixture"
        video = client.get("/templates/fixture/video.mp4", headers={"range": "bytes=0-99"})
    assert (video.status_code, len(video.content)) == (206, 100)
    assert video.content == (FIXTURE / "video.mp4").read_bytes()[:100]


def test_a_wrong_password_sets_no_cookie(tmp_path: Path) -> None:
    with TestClient(_app(tmp_path)) as client:
        res = client.post("/api/login", json={"password": "nope"})
    assert (res.status_code, res.json()["field"]) == (401, "password")
    assert "set-cookie" not in res.headers


def test_the_right_password_sets_a_cookie_that_opens_the_api(tmp_path: Path) -> None:
    with TestClient(_app(tmp_path)) as client:
        res = client.post("/api/login", json={"password": "pw"})
        assert res.status_code == 204
        assert res.cookies[COOKIE] == author_token("pw")
        attributes = {a.strip().lower() for a in res.headers["set-cookie"].split(";")[1:]}
        assert attributes == {"httponly", "secure", "samesite=strict", "path=/", "max-age=2592000"}
        assert client.get("/api/jobs", headers=SIGNED_IN).json() == []
        assert client.get("/api/session", headers=SIGNED_IN).json() == {"maxUploadBytes": 200 * 1024 * 1024}


def test_a_new_password_signs_everyone_out(tmp_path: Path) -> None:
    with TestClient(_app(tmp_path, password="rotated")) as client:
        assert client.get("/api/jobs", headers=SIGNED_IN).status_code == 401


def test_the_origin_check_runs_before_the_password(tmp_path: Path) -> None:
    with TestClient(_app(tmp_path)) as client:
        same_host = client.post("/api/login", json={"password": "pw"}, headers={"origin": "https://testserver"})
        evil = client.post("/api/login", json={"password": "pw"}, headers={"origin": "https://evil.example"})
        evil_signed_in = client.post("/api/jobs", json={"url": "x"}, headers={"origin": "https://evil.example", **SIGNED_IN})
        evil_signed_out = client.post("/api/jobs", json={"url": "x"}, headers={"origin": "https://evil.example"})
        vite = client.post("/api/login", json={"password": "pw"}, headers={"origin": "http://localhost:5184"})
    statuses = (same_host.status_code, evil.status_code, evil_signed_in.status_code, evil_signed_out.status_code, vite.status_code)
    assert statuses == (204, 403, 403, 403, 204)


def test_without_a_password_nothing_needs_the_cookie(tmp_path: Path) -> None:
    with TestClient(_app(tmp_path, password=None)) as client:
        assert client.get("/api/jobs").json() == []
        assert client.get("/api/session").json() == {"maxUploadBytes": 200 * 1024 * 1024}
        login = client.post("/api/login", json={"password": "anything"})
    assert login.status_code == 204
    assert "set-cookie" not in login.headers


def test_hashed_assets_are_immutable_and_everything_else_revalidates(tmp_path: Path) -> None:
    with TestClient(_app(tmp_path)) as client:
        assert client.get("/assets/x.js").headers["cache-control"] == "public, max-age=31536000, immutable"
        for path in ("/", "/templates/index.json", "/templates/fixture/template.json"):
            res = client.get(path)
            assert res.headers["cache-control"] == "no-cache", path
            assert client.get(path, headers={"if-none-match": res.headers["etag"]}).status_code == 304, path


def test_a_fresh_data_dir_gets_the_seed_templates(tmp_path: Path) -> None:
    site = _site(tmp_path)
    shutil.copytree(FIXTURE, site / "templates/fixture")
    paths = Paths(tmp_path / "data/work", tmp_path / "data/templates")
    with TestClient(create_app(paths, 5184, password="pw", site_dir=site)) as client:
        assert [t["id"] for t in client.get("/templates/index.json").json()["templates"]] == ["fixture"]
    assert (paths.templates_dir / "fixture/video.mp4").read_bytes() == (FIXTURE / "video.mp4").read_bytes()
