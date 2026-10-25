"""Runs without uvicorn reload, because reload forks and would orphan the worker thread.
Starlette's FileResponse answers Range requests, which the Clip step's <video> needs to seek."""
from __future__ import annotations

import hashlib
import hmac
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import uvicorn
from fastapi import Body, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, StringConstraints

from labelmeme import upload, youtube
from labelmeme.build import build
from labelmeme.draft import ClipFacts, clip_json, parse_draft, read_clip, read_draft, write_draft
from labelmeme.edit import UnknownTemplate, open_template, read_draft_if_any, save_in_place, write_draft_of
from labelmeme.job import (
    DEFAULT_LICENSE, ClipChosen, Conflict, Failed, Job, Jobs, Retry, Saved, SourceFacts,
    UnknownJob, derive_id, is_running, parse_clip, state_json,
)
from labelmeme.seed import seed_templates
from labelmeme.worker import Paths, Worker

log = logging.getLogger("labelmeme.server")

COOKIE = "labelmeme_author"
COOKIE_MAX_AGE = 30 * 24 * 60 * 60

Slug = Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]+$", max_length=40)]
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class CreateJob(BaseModel):
    url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    id: Slug | None = None


class Login(BaseModel):
    password: str


class ChooseClip(BaseModel):
    start: Annotated[float, Field(ge=0)]
    end: Annotated[float, Field(gt=0)]
    title: Text
    credit: Text
    license: Text = DEFAULT_LICENSE


class SaveSubject(BaseModel):
    id: Slug
    name: str
    runs: list[dict[str, object]]


class SaveTemplate(BaseModel):
    title: Text
    subjects: list[SaveSubject]


class ApiError(Exception):
    def __init__(self, status: int, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.field = field


def author_token(password: str) -> str:
    return hmac.new(password.encode(), b"labelmeme-author", hashlib.sha256).hexdigest()


def _source_of(job: Job) -> SourceFacts:
    state = job.state.resume if isinstance(job.state, Failed) else job.state
    return state.source


def _subjects_of(body: SaveTemplate) -> list[dict]:
    if not body.subjects:
        raise ApiError(422, "draw at least one subject", "subjects")
    for i, s in enumerate(body.subjects):
        if s.name.strip() == "":
            raise ApiError(422, "every drawn subject needs a name", f"subjects[{i}].name")
    return [{"id": s.id, "name": s.name.strip(), "runs": s.runs} for s in body.subjects]


def _parsed_draft(body: dict, clip: ClipFacts) -> dict:
    try:
        return parse_draft(body, clip)
    except ValueError as e:
        raise ApiError(422, str(e), str(e).split(":", 1)[0]) from e


def create_app(paths: Paths, web_port: int, password: str | None = None, site_dir: Path | None = None) -> FastAPI:
    dev_origins = {f"http://localhost:{web_port}", f"http://127.0.0.1:{web_port}"}
    token = None if password is None else author_token(password)
    worker = Worker(paths)
    jobs = Jobs(paths.work_dir, paths.templates_dir, worker.enqueue)

    def signed_in(request: Request) -> bool:
        return token is None or hmac.compare_digest(request.cookies.get(COOKIE, ""), token)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        paths.work_dir.mkdir(parents=True, exist_ok=True)
        paths.templates_dir.mkdir(parents=True, exist_ok=True)
        upload.sweep(paths)
        if site_dir is not None:
            for template_id in seed_templates(site_dir / "templates", paths.templates_dir):
                log.info("seeded template %s", template_id)
        for job in jobs.recover():
            log.info("resuming %s in state %s", job.id, job.state.kind)
        worker.start(jobs)
        yield

    app = FastAPI(lifespan=lifespan)

    @app.middleware("http")
    async def cache_static(request: Request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            immutable = request.url.path.startswith("/assets/")
            response.headers["cache-control"] = "public, max-age=31536000, immutable" if immutable else "no-cache"
        return response

    @app.middleware("http")
    async def same_origin_and_signed_in(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin is not None and origin not in dev_origins | {f"https://{request.headers.get('host')}"}:
            return JSONResponse({"error": f"origin {origin} is not allowed"}, status_code=403)
        path = request.url.path
        if path.startswith("/api/") and path != "/api/login" and not signed_in(request):
            return JSONResponse({"error": "sign in first", "field": None}, status_code=401)
        return await call_next(request)

    @app.exception_handler(ApiError)
    async def api_error(_: Request, e: ApiError):
        return JSONResponse({"error": str(e), "field": e.field}, status_code=e.status)

    @app.exception_handler(RequestValidationError)
    async def invalid_body(_: Request, e: RequestValidationError):
        first = e.errors()[0]
        field = ".".join(str(part) for part in first["loc"] if part != "body")
        return JSONResponse({"error": f"{field}: {first['msg']}", "field": field}, status_code=422)

    @app.exception_handler(Conflict)
    async def conflict(_: Request, e: Conflict):
        return JSONResponse({"error": str(e), "field": None}, status_code=409)

    @app.exception_handler(UnknownJob)
    async def unknown(_: Request, e: UnknownJob):
        return JSONResponse({"error": f"no job named {e.args[0]!r}", "field": None}, status_code=404)

    @app.exception_handler(UnknownTemplate)
    async def unknown_template(_: Request, e: UnknownTemplate):
        return JSONResponse({"error": f"no template named {e.args[0]!r}", "field": None}, status_code=404)

    def job_out(job: Job) -> dict:
        progress = worker.progress(job.id) if is_running(job.state) else None
        return {
            "id": job.id, "url": job.url, "createdAt": job.created_at, "state": state_json(job.state),
            "progress": None if progress is None else {
                "status": progress.status, "done": progress.done, "total": progress.total, "resumed": progress.resumed,
            },
        }

    @app.post("/api/login", status_code=204)
    def login(body: Login, response: Response) -> None:
        if token is None:
            return
        if not hmac.compare_digest(author_token(body.password), token):
            raise ApiError(401, "wrong password", "password")
        response.set_cookie(COOKIE, token, max_age=COOKIE_MAX_AGE, path="/", secure=True, httponly=True, samesite="strict")

    @app.get("/api/session")
    def session() -> dict:
        return {"maxUploadBytes": upload.MAX_UPLOAD_BYTES}

    @app.get("/api/jobs")
    def list_jobs() -> list[dict]:
        return [job_out(j) for j in jobs.list()]

    @app.post("/api/jobs", status_code=201)
    def create_job(body: CreateJob) -> dict:
        try:
            _, url = youtube.parse_youtube_url(body.url)
            source = youtube.probe(url)
        except youtube.SourceError as e:
            raise ApiError(422, str(e), "url") from e
        job_id = body.id or derive_id(source.title, jobs.taken())
        try:
            return job_out(jobs.create(job_id, source))
        except Conflict as e:
            raise ApiError(409, str(e), "id") from e

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str) -> dict:
        return job_out(jobs.get(job_id))

    @app.get("/api/jobs/{job_id}/source.mp4")
    def source_video(job_id: str) -> FileResponse:
        path = youtube.source_path(paths.sources_dir, _source_of(jobs.get(job_id)).video_id)
        if not path.is_file():
            raise ApiError(409, "the video is not downloaded yet")
        return FileResponse(path, media_type="video/mp4")

    @app.put("/api/jobs/{job_id}/clip")
    def choose_clip(job_id: str, body: ChooseClip) -> dict:
        source = _source_of(jobs.get(job_id))
        try:
            clip = parse_clip(start=body.start, end=body.end, title=body.title, credit=body.credit, license=body.license, source=source)
        except ValueError as e:
            raise ApiError(422, str(e), "clip") from e
        return job_out(jobs.transition(job_id, ClipChosen(clip)))

    @app.get("/api/jobs/{job_id}/clip.mp4")
    def clip_video(job_id: str) -> FileResponse:
        with jobs.with_settled(job_id, ("editing", "ready")):
            return FileResponse(paths.work_dir / job_id / "video.mp4", media_type="video/mp4")

    @app.get("/api/jobs/{job_id}/draft")
    def get_draft(job_id: str) -> dict:
        with jobs.with_settled(job_id, ("editing", "ready")) as job:
            work = paths.work_dir / job_id
            clip = read_clip(work)
            return {"draft": read_draft(work, job.state.clip.title, clip), "clip": clip_json(clip)}

    @app.put("/api/jobs/{job_id}/draft", status_code=204)
    def put_draft(job_id: str, body: dict = Body(...)) -> None:
        with jobs.with_settled(job_id, ("editing", "ready")):
            work = paths.work_dir / job_id
            write_draft(work, _parsed_draft(body, read_clip(work)))

    @app.post("/api/jobs/{job_id}/save")
    def save(job_id: str, body: SaveTemplate) -> dict:
        with jobs.with_settled(job_id, ("editing", "ready")):
            subjects = _subjects_of(body)
            started = time.perf_counter()
            try:
                build(paths.work_dir / job_id, paths.templates_dir, body.title, subjects)
            except ValueError as e:
                raise ApiError(422, str(e), str(e).split(":", 1)[0]) from e
            log.info("saved %s in %.2f s", job_id, time.perf_counter() - started)
            return job_out(jobs.transition(job_id, Saved()))

    @app.get("/api/templates/{template_id}/draft")
    def get_template_draft(template_id: str) -> dict:
        with jobs.with_template_editable(template_id):
            _, clip = open_template(paths.templates_dir, template_id)
            template_path = paths.templates_dir / template_id / "template.json"
            return {"draft": read_draft_if_any(paths.work_dir / template_id, template_path, clip), "clip": clip_json(clip)}

    @app.put("/api/templates/{template_id}/draft", status_code=204)
    def put_template_draft(template_id: str, body: dict = Body(...)) -> None:
        with jobs.with_template_editable(template_id):
            _, clip = open_template(paths.templates_dir, template_id)
            draft = _parsed_draft(body, clip)
            write_draft_of(paths.work_dir / template_id, paths.templates_dir / template_id / "template.json", draft)

    @app.post("/api/templates/{template_id}/save")
    def save_template(template_id: str, body: SaveTemplate) -> dict:
        with jobs.with_template_editable(template_id):
            template, _ = open_template(paths.templates_dir, template_id)
            subjects = _subjects_of(body)
            try:
                save_in_place(paths.templates_dir, paths.work_dir / template_id, template, body.title, subjects)
            except ValueError as e:
                raise ApiError(422, str(e), str(e).split(":", 1)[0]) from e
            return {"id": template_id}

    @app.post("/api/jobs/{job_id}/retry")
    def retry(job_id: str) -> dict:
        return job_out(jobs.transition(job_id, Retry()))

    app.include_router(upload.router(jobs, paths, job_out))
    if site_dir is not None:
        app.mount("/templates", StaticFiles(directory=paths.templates_dir, check_dir=False))
        app.mount("/", StaticFiles(directory=site_dir, html=True))
    return app


def serve(
    paths: Paths, port: int, web_port: int, host: str = "127.0.0.1",
    password: str | None = None, site_dir: Path | None = None,
) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    uvicorn.run(create_app(paths, web_port, password, site_dir), host=host, port=port, workers=1)
