from __future__ import annotations

import json
import logging
import os
import re
import threading
import unicodedata
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from labelmeme.schema import SLUG

Step = Literal["download", "prepare"]
STEPS: tuple[Step, ...] = ("download", "prepare")

MAX_CLIP_SECONDS = 30.0
MIN_CLIP_SECONDS = 1.0
DEFAULT_LICENSE = "unknown, personal use"
MAX_ID_LENGTH = 40


@dataclass(frozen=True, slots=True)
class SourceFacts:
    video_id: str
    url: str
    title: str
    channel: str
    duration: float
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class Clip:
    start: float
    end: float
    title: str
    credit: str
    license: str


def parse_clip(*, start: float, end: float, title: str, credit: str, license: str, source: SourceFacts) -> Clip:
    if end <= start:
        raise ValueError(f"end must be after start (start {start:g} s, end {end:g} s)")
    length = end - start
    if length < MIN_CLIP_SECONDS:
        raise ValueError(f"the clip must be at least {MIN_CLIP_SECONDS:g} s long, got {length:.2f} s")
    if length > MAX_CLIP_SECONDS:
        raise ValueError(f"the clip must be at most {MAX_CLIP_SECONDS:g} s long, got {length:.2f} s")
    if end > source.duration:
        raise ValueError(f"end {end:g} s is past the end of the video ({source.duration:g} s)")
    return Clip(start, end, title, credit, license)


@dataclass(frozen=True, slots=True)
class Downloading:
    source: SourceFacts
    kind: Literal["downloading"] = "downloading"


@dataclass(frozen=True, slots=True)
class Downloaded:
    source: SourceFacts
    kind: Literal["downloaded"] = "downloaded"


@dataclass(frozen=True, slots=True)
class Preparing:
    source: SourceFacts
    clip: Clip
    kind: Literal["preparing"] = "preparing"


@dataclass(frozen=True, slots=True)
class Editing:
    source: SourceFacts
    clip: Clip
    kind: Literal["editing"] = "editing"


@dataclass(frozen=True, slots=True)
class Ready:
    source: SourceFacts
    clip: Clip
    kind: Literal["ready"] = "ready"


Running = Downloading | Preparing


@dataclass(frozen=True, slots=True)
class Failed:
    step: Step
    message: str
    resume: Running
    kind: Literal["failed"] = "failed"


State = Downloading | Downloaded | Preparing | Editing | Ready | Failed


@dataclass(frozen=True, slots=True)
class Job:
    id: str
    url: str
    created_at: str
    state: State


def is_running(state: State) -> bool:
    return isinstance(state, (Downloading, Preparing))


@dataclass(frozen=True, slots=True)
class StepDone:
    pass


@dataclass(frozen=True, slots=True)
class StepFailed:
    message: str


@dataclass(frozen=True, slots=True)
class ClipChosen:
    clip: Clip


@dataclass(frozen=True, slots=True)
class Saved:
    pass


@dataclass(frozen=True, slots=True)
class Retry:
    pass


Event = StepDone | StepFailed | ClipChosen | Saved | Retry

EVENT_NAMES: dict[type, str] = {StepDone: "done", StepFailed: "fail", ClipChosen: "clip", Saved: "save", Retry: "retry"}


class Conflict(Exception):
    pass


class UnknownJob(KeyError):
    pass


def advance(state: State, event: Event) -> State:
    match state, event:
        case Downloading(source=s), StepDone():
            return Downloaded(s)
        case Preparing(source=s, clip=c), StepDone():
            return Editing(s, c)
        case Downloading(), StepFailed(message=m):
            return Failed("download", m, state)
        case Preparing(), StepFailed(message=m):
            return Failed("prepare", m, state)
        case Downloaded(source=s) | Editing(source=s) | Ready(source=s) | Failed(resume=Preparing(source=s)), ClipChosen(clip=c):
            return Preparing(s, c)
        case Editing(source=s, clip=c) | Ready(source=s, clip=c), Saved():
            return Ready(s, c)
        case Failed(resume=r), Retry():
            return r
    raise Conflict(f"cannot {EVENT_NAMES[type(event)]} while the job is {_describe(state)}")


def _describe(state: State) -> str:
    return f"failed at {state.step}" if isinstance(state, Failed) else state.kind


def _source_json(s: SourceFacts) -> dict:
    return {"videoId": s.video_id, "url": s.url, "title": s.title, "channel": s.channel,
            "duration": s.duration, "width": s.width, "height": s.height}


def _clip_json(c: Clip) -> dict:
    return {"start": c.start, "end": c.end, "title": c.title, "credit": c.credit, "license": c.license}


def state_json(state: State) -> dict:
    match state:
        case Downloading(source=s) | Downloaded(source=s):
            return {"kind": state.kind, "source": _source_json(s)}
        case Preparing(source=s, clip=c) | Editing(source=s, clip=c) | Ready(source=s, clip=c):
            return {"kind": state.kind, "source": _source_json(s), "clip": _clip_json(c)}
        case Failed(step=step, message=m, resume=r):
            return {"kind": "failed", "step": step, "message": m, "resume": state_json(r)}


def dump_job(job: Job) -> str:
    raw = {"version": 1, "id": job.id, "url": job.url, "createdAt": job.created_at, "state": state_json(job.state)}
    return json.dumps(raw, indent=2, ensure_ascii=False) + "\n"


def _record(v: object, path: str) -> dict:
    if not isinstance(v, dict):
        raise ValueError(f"{path}: expected an object")
    return v


def _text(v: object, path: str) -> str:
    if not isinstance(v, str):
        raise ValueError(f"{path}: expected a string, got {v!r}")
    return v


def _number(v: object, path: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{path}: expected a number, got {v!r}")
    return float(v)


def _int(v: object, path: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"{path}: expected an integer, got {v!r}")
    return v


def _parse_source(v: object, path: str) -> SourceFacts:
    o = _record(v, path)
    return SourceFacts(
        video_id=_text(o.get("videoId"), f"{path}.videoId"), url=_text(o.get("url"), f"{path}.url"),
        title=_text(o.get("title"), f"{path}.title"), channel=_text(o.get("channel"), f"{path}.channel"),
        duration=_number(o.get("duration"), f"{path}.duration"),
        width=_int(o.get("width"), f"{path}.width"), height=_int(o.get("height"), f"{path}.height"),
    )


def _parse_clip(v: object, path: str) -> Clip:
    o = _record(v, path)
    return Clip(
        start=_number(o.get("start"), f"{path}.start"), end=_number(o.get("end"), f"{path}.end"),
        title=_text(o.get("title"), f"{path}.title"), credit=_text(o.get("credit"), f"{path}.credit"),
        license=_text(o.get("license"), f"{path}.license"),
    )


def _kind(o: dict, path: str, allowed: tuple[str, ...]) -> str:
    kind = o.get("kind")
    if kind not in allowed:
        raise ValueError(f"{path}.kind: expected one of {', '.join(allowed)}, got {kind!r}")
    return kind


RUNNING_KINDS = ("downloading", "preparing")
KINDS = (*RUNNING_KINDS, "downloaded", "editing", "ready", "failed")


def _parse_state(v: object, path: str, allowed: tuple[str, ...] = KINDS) -> State:
    o = _record(v, path)
    kind = _kind(o, path, allowed)
    if kind == "failed":
        step = o.get("step")
        if step not in STEPS:
            raise ValueError(f"{path}.step: expected one of {', '.join(STEPS)}, got {step!r}")
        resume = _parse_state(o.get("resume"), f"{path}.resume", RUNNING_KINDS)
        return Failed(step, _text(o.get("message"), f"{path}.message"), resume)
    source = _parse_source(o.get("source"), f"{path}.source")
    match kind:
        case "downloading":
            return Downloading(source)
        case "downloaded":
            return Downloaded(source)
    clip = _parse_clip(o.get("clip"), f"{path}.clip")
    match kind:
        case "preparing":
            return Preparing(source, clip)
        case "editing":
            return Editing(source, clip)
        case _:
            return Ready(source, clip)


def parse_job(raw: object) -> Job:
    o = _record(raw, "$")
    if o.get("version") != 1:
        raise ValueError(f"$.version: expected 1, got {o.get('version')!r}")
    job_id = _text(o.get("id"), "$.id")
    if SLUG.fullmatch(job_id) is None:
        raise ValueError(f"$.id: expected a slug, got {job_id!r}")
    return Job(job_id, _text(o.get("url"), "$.url"), _text(o.get("createdAt"), "$.createdAt"), _parse_state(o.get("state"), "$.state"))


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def derive_id(title: str, taken: set[str]) -> str:
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    words = re.findall(r"[a-z0-9]+", ascii_title)
    base = ""
    for word in words:
        candidate = f"{base}-{word}" if base else word
        if len(candidate) > MAX_ID_LENGTH:
            break
        base = candidate
    base = base or (words[0][:MAX_ID_LENGTH] if words else "clip")
    job_id, n = base, 2
    while job_id in taken:
        job_id, n = f"{base}-{n}", n + 1
    return job_id


log = logging.getLogger(__name__)

Enqueue = Callable[[Job, bool], None]


class Jobs:
    def __init__(self, work_dir: Path, templates_dir: Path, enqueue: Enqueue) -> None:
        self._work_dir = work_dir
        self._templates_dir = templates_dir
        self._lock = threading.RLock()
        self._enqueue = enqueue

    def _path(self, job_id: str) -> Path:
        return self._work_dir / job_id / "job.json"

    def _load(self, job_id: str) -> Job:
        path = self._path(job_id)
        if SLUG.fullmatch(job_id) is None or not path.is_file():
            raise UnknownJob(job_id)
        try:
            return parse_job(json.loads(path.read_text(encoding="utf-8")))
        except ValueError as e:
            raise ValueError(f"{path}: {e}") from e

    def taken(self) -> set[str]:
        dirs = [*self._work_dir.glob("*"), *self._templates_dir.glob("*")]
        return {d.name for d in dirs if d.is_dir()}

    def create(self, job_id: str, source: SourceFacts) -> Job:
        with self._lock:
            if job_id in self.taken():
                raise Conflict(f"the name {job_id!r} is already used by a template or a work directory")
            job = Job(job_id, source.url, datetime.now(UTC).isoformat(timespec="microseconds"), Downloading(source))
            self._path(job_id).parent.mkdir(parents=True)
            write_atomic(self._path(job_id), dump_job(job))
        self._enqueue(job, False)
        return job

    def get(self, job_id: str) -> Job:
        return self._load(job_id)

    def list(self) -> list[Job]:
        jobs = []
        for path in self._work_dir.glob("*/job.json"):
            try:
                jobs.append(self._load(path.parent.name))
            except ValueError as e:
                log.warning("skipping a job that cannot be read: %s", e)
        return sorted(jobs, key=lambda j: j.created_at, reverse=True)

    def transition(self, job_id: str, event: Event) -> Job:
        with self._lock:
            current = self._load(job_id)
            job = Job(current.id, current.url, current.created_at, advance(current.state, event))
            write_atomic(self._path(job_id), dump_job(job))
        if is_running(job.state):
            self._enqueue(job, False)
        return job

    @contextmanager
    def with_settled(self, job_id: str, kinds: tuple[str, ...]) -> Iterator[Job]:
        with self._lock:
            job = self._load(job_id)
            if job.state.kind not in kinds:
                raise Conflict(f"this needs the job to be {' or '.join(kinds)}, but it is {_describe(job.state)}")
            yield job

    @contextmanager
    def with_template_editable(self, template_id: str) -> Iterator[None]:
        with self._lock:
            if self._path(template_id).is_file():
                state = self._load(template_id).state
                if state.kind != "ready":
                    raise Conflict(f"this template's job is {_describe(state)}: finish or redo the job first")
            yield

    def recover(self) -> list[Job]:
        pending = sorted((j for j in self.list() if is_running(j.state)), key=lambda j: j.created_at)
        for job in pending:
            self._enqueue(job, True)
        return pending
