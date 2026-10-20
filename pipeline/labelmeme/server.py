"""Runs without uvicorn reload, because reload forks and would orphan the worker thread.
Starlette's FileResponse answers Range requests, which the Clip step's <video> needs to seek."""
from __future__ import annotations

import json
import logging
import re
from contextlib import asynccontextmanager
from typing import Annotated

import uvicorn
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, StringConstraints

from labelmeme import people, youtube
from labelmeme.job import (
    DEFAULT_LICENSE, BuildRequested, ClipChosen, Conflict, Failed, Job, Jobs, Reopen, Retry, SourceFacts,
    UnknownJob, derive_id, is_running, parse_clip, state_json, write_atomic,
)
from labelmeme.prep import read_facts
from labelmeme.track import read_cuts, tracks_id
from labelmeme.worker import Paths, Worker

ALLOWED_ORIGINS = {"http://localhost:5174", "http://127.0.0.1:5174"}
SHEET = re.compile(r"track_s\d+-\d+\.jpg|overview\.jpg|built\.jpg")

Slug = Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]+$", max_length=40)]
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class CreateJob(BaseModel):
    url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    id: Slug | None = None


class ChooseClip(BaseModel):
    start: Annotated[float, Field(ge=0)]
    end: Annotated[float, Field(gt=0)]
    title: Text
    credit: Text
    license: Text = DEFAULT_LICENSE


class PersonBody(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)]
    tracks: Annotated[list[str], Field(min_length=1)]


class SavePeople(BaseModel):
    tracksId: str
    people: list[PersonBody]


class ApiError(Exception):
    def __init__(self, status: int, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.field = field


def _source_of(job: Job) -> SourceFacts:
    state = job.state.resume if isinstance(job.state, Failed) else job.state
    return state.source


def create_app(paths: Paths) -> FastAPI:
    worker = Worker(paths)
    jobs = Jobs(paths.work_dir, paths.templates_dir, worker.enqueue)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        paths.work_dir.mkdir(parents=True, exist_ok=True)
        for job in jobs.recover():
            logging.getLogger("labelmeme.server").info("resuming %s in state %s", job.id, job.state.kind)
        worker.start(jobs)
        yield

    app = FastAPI(lifespan=lifespan)

    @app.middleware("http")
    async def same_origin_only(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin is not None and origin not in ALLOWED_ORIGINS:
            return JSONResponse({"error": f"origin {origin} is not allowed"}, status_code=403)
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

    def job_out(job: Job) -> dict:
        progress = worker.progress(job.id) if is_running(job.state) else None
        return {
            "id": job.id, "url": job.url, "createdAt": job.created_at, "state": state_json(job.state),
            "progress": None if progress is None else {
                "status": progress.status, "done": progress.done, "total": progress.total, "resumed": progress.resumed,
            },
        }

    def people_out(job_id: str, draft: people.Draft | None = None) -> dict:
        work = paths.work_dir / job_id
        try:
            facts = read_facts(work)
            cuts = read_cuts(work, facts.frameCount)
            tracks_json = (work / "tracks.json").read_bytes()
            tracks = json.loads(tracks_json)
            current = tracks_id(cuts, tracks_json)
            if draft is None:
                raw = json.loads((work / "subjects.json").read_text(encoding="utf-8"))
                draft = people.parse_draft(raw, set(tracks), current)
        except (OSError, ValueError) as e:
            raise ApiError(409, f"cannot read the People draft: {e}") from e
        return {
            "tracksId": current, "fps": facts.fps, "frameCount": facts.frameCount, "cuts": cuts,
            "tracks": [
                {"id": c.id, "shot": c.shot, "first": c.first, "last": c.last, "detections": c.detections,
                 "sheetUrl": f"/api/jobs/{job_id}/sheets/track_{c.id}.jpg?v={current}"}
                for c in people.cards(tracks)
            ],
            "people": [{"name": p.name, "tracks": list(p.tracks)} for p in draft.people],
            "issues": [{"person": i.person, "blocking": i.blocking, "message": i.message} for i in people.issues(draft, tracks)],
        }

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

    @app.get("/api/jobs/{job_id}/people")
    def get_people(job_id: str) -> dict:
        with jobs.with_settled(job_id, ("tracked", "ready")):
            return people_out(job_id)

    @app.put("/api/jobs/{job_id}/people")
    def save_people(job_id: str, body: SavePeople) -> dict:
        with jobs.with_settled(job_id, ("tracked",)):
            work = paths.work_dir / job_id
            draft = people.Draft(body.tracksId, tuple(people.Person(p.name, tuple(p.tracks)) for p in body.people))
            raw = people.to_subjects_json(draft)
            out = people_out(job_id)
            try:
                people.parse_draft(raw, {t["id"] for t in out["tracks"]}, out["tracksId"])
            except ValueError as e:
                raise ApiError(409, str(e)) from e
            write_atomic(work / "subjects.json", json.dumps(raw, indent=2, ensure_ascii=False) + "\n")
            return people_out(job_id, draft)

    @app.get("/api/jobs/{job_id}/sheets/{name}")
    def sheet(job_id: str, name: str) -> FileResponse:
        jobs.get(job_id)
        path = paths.work_dir / job_id / "sheets" / name
        if SHEET.fullmatch(name) is None or not path.is_file():
            raise ApiError(404, f"no sheet named {name}")
        return FileResponse(path, media_type="image/jpeg")

    @app.post("/api/jobs/{job_id}/build")
    def request_build(job_id: str) -> dict:
        with jobs.with_settled(job_id, ("tracked",)):
            blocking = [i["message"] for i in people_out(job_id)["issues"] if i["blocking"]]
            if blocking:
                raise ApiError(422, " ".join(blocking), "people")
            return job_out(jobs.transition(job_id, BuildRequested()))

    @app.post("/api/jobs/{job_id}/reopen")
    def reopen(job_id: str) -> dict:
        return job_out(jobs.transition(job_id, Reopen()))

    @app.post("/api/jobs/{job_id}/retry")
    def retry(job_id: str) -> dict:
        return job_out(jobs.transition(job_id, Retry()))

    return app


def serve(paths: Paths, port: int) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    uvicorn.run(create_app(paths), host="127.0.0.1", port=port, workers=1)
