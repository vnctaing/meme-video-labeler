from __future__ import annotations

import logging
import queue
import shlex
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from labelmeme import youtube
from labelmeme.cuts import write_cuts
from labelmeme.job import Downloading, Job, Jobs, Preparing, StepDone, StepFailed
from labelmeme.prep import PrepSpec, prep

log = logging.getLogger("labelmeme.worker")


@dataclass(frozen=True, slots=True)
class Progress:
    status: Literal["queued", "running"]
    done: int
    total: int | None
    resumed: bool


@dataclass(frozen=True, slots=True)
class Paths:
    work_dir: Path
    templates_dir: Path

    @property
    def sources_dir(self) -> Path:
        return self.work_dir / ".sources"


CLIP_OUTPUTS = ("video.mp4", "thumb.jpg", "video.json", "SOURCE.md", "cuts.json", "draft.json")


class Worker:
    def __init__(self, paths: Paths) -> None:
        self._paths = paths
        self._queue: queue.Queue[str] = queue.Queue()
        self._pending: set[str] = set()
        self._pending_lock = threading.Lock()
        self._progress: dict[str, Progress] = {}

    def start(self, jobs: Jobs) -> None:
        threading.Thread(target=self._loop, args=(jobs,), daemon=True, name="labelmeme-worker").start()

    def enqueue(self, job: Job, resumed: bool) -> None:
        with self._pending_lock:
            if job.id in self._pending:
                return
            self._pending.add(job.id)
        self._progress[job.id] = Progress("queued", 0, None, resumed)
        self._queue.put(job.id)

    def progress(self, job_id: str) -> Progress | None:
        return self._progress.get(job_id)

    def _report(self, job_id: str, done: int, total: int | None) -> None:
        current = self._progress.get(job_id)
        self._progress[job_id] = Progress("running", done, total, current is not None and current.resumed)

    def _loop(self, jobs: Jobs) -> None:
        while True:
            job_id = self._queue.get()
            with self._pending_lock:
                self._pending.discard(job_id)
            try:
                job = jobs.get(job_id)
            except Exception:
                log.exception("cannot read job %s", job_id)
                continue
            try:
                self._report(job_id, 0, None)
                match job.state:
                    case Downloading() as state:
                        self._download(job, state)
                    case Preparing() as state:
                        self._prepare(job, state)
                    case _:
                        continue
                jobs.transition(job_id, StepDone())
            except Exception as e:
                log.exception("job %s failed", job_id)
                try:
                    jobs.transition(job_id, StepFailed(plain_message(e)))
                except Exception:
                    log.exception("could not record the failure of job %s", job_id)
            finally:
                self._progress.pop(job_id, None)

    def _download(self, job: Job, state: Downloading) -> None:
        youtube.download(state.source, self._paths.sources_dir, lambda done, total: self._report(job.id, done, total))

    def _prepare(self, job: Job, state: Preparing) -> None:
        work = self._paths.work_dir / job.id
        for name in CLIP_OUTPUTS:
            (work / name).unlink(missing_ok=True)
        clip = state.clip
        source = youtube.source_path(self._paths.sources_dir, state.source.video_id)
        spec = PrepSpec(
            source=source, start=clip.start, duration=round(clip.end - clip.start, 3), id=job.id, title=clip.title,
            credit=clip.credit, source_url=state.source.url, license=clip.license, fps=24,
        )
        facts = prep(spec, work, _prep_command(spec, source.relative_to(self._paths.work_dir.parent)))
        write_cuts(work, facts.fps)


def _prep_command(spec: PrepSpec, source: Path) -> str:
    return shlex.join([
        "uv", "run", "python", "-m", "labelmeme", "prep", str(source), "--start", f"{spec.start:g}",
        "--duration", f"{spec.duration:g}", "--id", spec.id, "--title", spec.title, "--credit", spec.credit,
        "--source-url", spec.source_url, "--license", spec.license,
    ])


def plain_message(e: Exception) -> str:
    if isinstance(e, (youtube.SourceError, ValueError)):
        return str(e)
    return f"{type(e).__name__}: {e}"

