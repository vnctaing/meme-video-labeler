import time
from collections.abc import Callable
from pathlib import Path

import pytest

from labelmeme import worker
from labelmeme.job import INTERRUPTED, MAX_ATTEMPTS, Clip, ClipChosen, Editing, Failed, Jobs, Preparing, Retry, SourceFacts, StepDone
from labelmeme.prep import VideoFacts
from labelmeme.worker import Paths, Worker

SOURCE = SourceFacts("abc", "https://www.youtube.com/watch?v=abc", "Fixture", "Me", 60.0, 640, 360)
CLIP = Clip(1.0, 3.0, "Fixture", "Me", "l")
FACTS = VideoFacts("job", "Fixture", "Me", 640, 360, 24, 48)

pytestmark = pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")


class Killed(SystemExit):
    pass


def _until(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


def _preparing(paths: Paths) -> None:
    jobs = Jobs(paths.work_dir, paths.templates_dir, lambda job, resumed: None)
    jobs.create("job", SOURCE)
    jobs.transition("job", StepDone())
    jobs.transition("job", ClipChosen(CLIP))


def _boot(paths: Paths) -> Jobs:
    w = Worker(paths)
    jobs = Jobs(paths.work_dir, paths.templates_dir, w.enqueue)
    jobs.recover()
    w.start(jobs)
    return jobs


@pytest.fixture
def paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Paths:
    paths = Paths(tmp_path / "work", tmp_path / "templates")
    (paths.sources_dir / SOURCE.video_id).mkdir(parents=True)
    monkeypatch.setattr(worker, "write_cuts", lambda work, fps: None)
    _preparing(paths)
    return paths


def _fake_prep(monkeypatch: pytest.MonkeyPatch, kills: int) -> list[int]:
    calls: list[int] = []

    def prep(spec, work, command):
        calls.append(len(calls) + 1)
        if len(calls) <= kills:
            raise Killed()
        return FACTS

    monkeypatch.setattr(worker, "prep", prep)
    return calls


def test_a_prep_killed_mid_step_resumes_on_the_next_boot(paths: Paths, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_prep(monkeypatch, kills=1)
    jobs = _boot(paths)
    _until(lambda: calls == [1])
    assert jobs.get("job").state == Preparing(SOURCE, CLIP, attempts=1)

    jobs = _boot(paths)
    _until(lambda: jobs.get("job").state == Editing(SOURCE, CLIP))
    assert calls == [1, 2]


def test_a_prep_that_always_kills_the_machine_fails_on_the_fourth_start(paths: Paths, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_prep(monkeypatch, kills=99)
    for n in range(1, MAX_ATTEMPTS + 1):
        jobs = _boot(paths)
        _until(lambda: len(calls) == n)
        assert jobs.get("job").state == Preparing(SOURCE, CLIP, attempts=n)

    jobs = _boot(paths)
    _until(lambda: isinstance(jobs.get("job").state, Failed))
    assert jobs.get("job").state == Failed("prepare", INTERRUPTED.format(n=MAX_ATTEMPTS), Preparing(SOURCE, CLIP))
    time.sleep(0.1)
    assert len(calls) == MAX_ATTEMPTS


def test_retry_after_the_budget_runs_the_step_again(paths: Paths, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_prep(monkeypatch, kills=MAX_ATTEMPTS)
    for n in range(1, MAX_ATTEMPTS + 1):
        _boot(paths)
        _until(lambda: len(calls) == n)
    jobs = _boot(paths)
    _until(lambda: isinstance(jobs.get("job").state, Failed))

    jobs.transition("job", Retry())
    _until(lambda: jobs.get("job").state == Editing(SOURCE, CLIP))
    assert len(calls) == MAX_ATTEMPTS + 1
