from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import uuid
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from labelmeme import youtube
from labelmeme.job import Conflict, Job, Jobs, SourceFacts, derive_id
from labelmeme.worker import Paths

MAX_UPLOAD_BYTES = 200 * 1024 * 1024
NOT_A_VIDEO = "This file is not a video ffmpeg can read."


class UploadError(Exception):
    def __init__(self, status: Literal[409, 411, 413, 422], message: str) -> None:
        super().__init__(message)
        self.status: Literal[409, 411, 413, 422] = status
        self.message = message


def _too_big() -> UploadError:
    return UploadError(413, f"The file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")


def _uploads_dir(paths: Paths) -> Path:
    return paths.work_dir / ".uploads"


def _probe(path: Path) -> tuple[float, int, int]:
    run = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", str(path)],
        capture_output=True, text=True,
    )
    if run.returncode != 0:
        raise UploadError(422, NOT_A_VIDEO)
    try:
        out = json.loads(run.stdout)
        video = next(s for s in out["streams"] if s.get("codec_type") == "video")
        duration, width, height = float(out["format"]["duration"]), int(video["width"]), int(video["height"])
    except (ValueError, KeyError, StopIteration) as e:
        raise UploadError(422, NOT_A_VIDEO) from e
    if duration <= 0:
        raise UploadError(422, NOT_A_VIDEO)
    return duration, width, height


async def receive(chunks: AsyncIterator[bytes], length: int | None, name: str, paths: Paths) -> SourceFacts:
    if length is None:
        raise UploadError(411, "Send the file with its length (Content-Length).")
    if length > MAX_UPLOAD_BYTES:
        raise _too_big()
    uploads = _uploads_dir(paths)
    uploads.mkdir(parents=True, exist_ok=True)
    part = uploads / f"{uuid.uuid4().hex}.part"
    try:
        digest, size = hashlib.sha256(), 0
        with part.open("wb") as f:
            async for chunk in chunks:
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise _too_big()
                digest.update(chunk)
                f.write(chunk)
        duration, width, height = await asyncio.to_thread(_probe, part)
        video_id = f"upload-{digest.hexdigest()[:16]}"
        target = youtube.source_path(paths.sources_dir, video_id)
        if not target.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(part, target)
    finally:
        part.unlink(missing_ok=True)
    filename = Path(name).name
    return SourceFacts(
        video_id=video_id, url=f"upload:{filename}", title=Path(filename).stem, channel="uploaded file",
        duration=duration, width=width, height=height,
    )


def sweep(paths: Paths) -> None:
    shutil.rmtree(_uploads_dir(paths), ignore_errors=True)


def _error(status: int, message: str, field: str) -> JSONResponse:
    return JSONResponse({"error": message, "field": field}, status_code=status)


def _length(request: Request) -> int | None:
    try:
        return int(request.headers["content-length"])
    except (KeyError, ValueError):
        return None


def router(jobs: Jobs, paths: Paths, job_out: Callable[[Job], dict]) -> APIRouter:
    r = APIRouter()

    @r.post("/api/uploads", status_code=201, response_model=None)
    async def create_upload(
        request: Request, name: Annotated[str, Query(min_length=1, max_length=200)],
        id: Annotated[str | None, Query(pattern=r"^[a-z0-9-]+$", max_length=40)] = None,
    ) -> dict | JSONResponse:
        if id is not None and id in jobs.taken():
            return _error(409, f"the name {id!r} is already used by a template or a work directory", "id")
        try:
            source = await receive(request.stream(), _length(request), name, paths)
        except UploadError as e:
            return _error(e.status, e.message, "file")
        job_id = id or derive_id(source.title, jobs.taken())
        try:
            return job_out(jobs.create_downloaded(job_id, source))
        except Conflict as e:
            return _error(409, str(e), "id")

    return r
