import json
from pathlib import Path

import pytest

from labelmeme.job import (
    BuildRequested,
    Building,
    Clip,
    ClipChosen,
    Conflict,
    Downloaded,
    Downloading,
    Failed,
    Job,
    Jobs,
    Ready,
    Reopen,
    Retry,
    SourceFacts,
    StepDone,
    StepFailed,
    Tracked,
    Tracking,
    advance,
    derive_id,
    dump_job,
    parse_clip,
    parse_job,
)

SOURCE = SourceFacts(
    video_id="R6MlUcmOul8", url="https://www.youtube.com/watch?v=R6MlUcmOul8",
    title="Tears of Steel - Blender VFX Open Movie", channel="Blender", duration=734.0, width=1280, height=534,
)
CLIP = Clip(start=225.0, end=240.0, title="The lab", credit="Blender", license="unknown, personal use")
CLIP2 = Clip(start=10.0, end=20.0, title="Other", credit="Blender", license="unknown, personal use")

STATES = {
    "downloading": Downloading(SOURCE),
    "downloaded": Downloaded(SOURCE),
    "tracking": Tracking(SOURCE, CLIP),
    "tracked": Tracked(SOURCE, CLIP),
    "building": Building(SOURCE, CLIP),
    "ready": Ready(SOURCE, CLIP),
    "failed-download": Failed("download", "boom", Downloading(SOURCE)),
    "failed-track": Failed("track", "boom", Tracking(SOURCE, CLIP)),
    "failed-build": Failed("build", "boom", Building(SOURCE, CLIP)),
}
EVENTS = {
    "done": StepDone(),
    "fail": StepFailed("boom"),
    "clip": ClipChosen(CLIP2),
    "build": BuildRequested(),
    "reopen": Reopen(),
    "retry": Retry(),
}
LEGAL = {
    ("downloading", "done"): Downloaded(SOURCE),
    ("downloading", "fail"): Failed("download", "boom", Downloading(SOURCE)),
    ("downloaded", "clip"): Tracking(SOURCE, CLIP2),
    ("tracking", "done"): Tracked(SOURCE, CLIP),
    ("tracking", "fail"): Failed("track", "boom", Tracking(SOURCE, CLIP)),
    ("tracked", "clip"): Tracking(SOURCE, CLIP2),
    ("tracked", "build"): Building(SOURCE, CLIP),
    ("building", "done"): Ready(SOURCE, CLIP),
    ("building", "fail"): Failed("build", "boom", Building(SOURCE, CLIP)),
    ("ready", "clip"): Tracking(SOURCE, CLIP2),
    ("ready", "reopen"): Tracked(SOURCE, CLIP),
    ("failed-download", "retry"): Downloading(SOURCE),
    ("failed-track", "retry"): Tracking(SOURCE, CLIP),
    ("failed-track", "clip"): Tracking(SOURCE, CLIP2),
    ("failed-build", "retry"): Building(SOURCE, CLIP),
    ("failed-build", "clip"): Tracking(SOURCE, CLIP2),
    ("failed-build", "reopen"): Tracked(SOURCE, CLIP),
}
PAIRS = [(s, e) for s in STATES for e in EVENTS]


@pytest.mark.parametrize(("state", "event"), [p for p in PAIRS if p in LEGAL])
def test_legal_transition(state: str, event: str) -> None:
    assert advance(STATES[state], EVENTS[event]) == LEGAL[(state, event)]


@pytest.mark.parametrize(("state", "event"), [p for p in PAIRS if p not in LEGAL])
def test_illegal_transition_is_a_conflict(state: str, event: str) -> None:
    with pytest.raises(Conflict, match=f"cannot {event}"):
        advance(STATES[state], EVENTS[event])


@pytest.mark.parametrize("state", list(STATES))
def test_job_json_round_trips(state: str) -> None:
    job = Job(id="tos-kiss", url=SOURCE.url, created_at="2026-10-19T14:02:11Z", state=STATES[state])
    assert parse_job(json.loads(dump_job(job))) == job


def test_parse_job_names_the_broken_path() -> None:
    raw = json.loads(dump_job(Job("tos-kiss", SOURCE.url, "2026-10-19T14:02:11Z", STATES["failed-track"])))
    raw["state"]["resume"]["clip"]["start"] = "soon"
    with pytest.raises(ValueError, match=r"\$\.state\.resume\.clip\.start: expected a number"):
        parse_job(raw)
    raw["state"]["resume"] = {"kind": "tracked", "source": raw["state"]["resume"]["source"]}
    with pytest.raises(ValueError, match=r"\$\.state\.resume\.kind: expected one of"):
        parse_job(raw)


@pytest.mark.parametrize(
    ("start", "end", "message"),
    [
        (10.0, 10.0, "end must be after start"),
        (10.0, 10.5, "at least 1 s"),
        (10.0, 40.5, "at most 30 s"),
        (720.0, 740.0, "past the end of the video"),
    ],
)
def test_parse_clip_rejects_bad_ranges(start: float, end: float, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        parse_clip(start=start, end=end, title="t", credit="c", license="l", source=SOURCE)


def test_parse_clip_accepts_the_30_s_cap() -> None:
    assert parse_clip(start=0.0, end=30.0, title="t", credit="c", license="l", source=SOURCE).end == 30.0


def test_derive_id_slugs_and_dedupes() -> None:
    assert derive_id("Tears of Steel - Blender VFX Open Movie", set()) == "tears-of-steel-blender-vfx-open-movie"
    assert derive_id("Tears of Steel", {"tears-of-steel"}) == "tears-of-steel-2"
    assert derive_id("ÉTÉ à Paris!!", set()) == "ete-a-paris"
    assert derive_id("日本語", set()) == "clip"
    long = derive_id("A very long title that keeps going well past the forty character limit", set())
    assert long == "a-very-long-title-that-keeps-going-well"


def _store(tmp_path: Path) -> tuple[Jobs, list[tuple[str, bool]]]:
    enqueued: list[tuple[str, bool]] = []
    jobs = Jobs(tmp_path / "work", tmp_path / "templates", lambda job, resumed: enqueued.append((job.id, resumed)))
    return jobs, enqueued


def test_create_persists_and_enqueues(tmp_path: Path) -> None:
    jobs, enqueued = _store(tmp_path)
    job = jobs.create("tos-kiss", SOURCE)
    assert job.state == Downloading(SOURCE)
    assert parse_job(json.loads((tmp_path / "work/tos-kiss/job.json").read_text())) == job
    assert enqueued == [("tos-kiss", False)]


@pytest.mark.parametrize("taken_in", ["work", "templates"])
def test_create_refuses_a_taken_id(tmp_path: Path, taken_in: str) -> None:
    (tmp_path / taken_in / "tos-lab").mkdir(parents=True)
    jobs, enqueued = _store(tmp_path)
    with pytest.raises(Conflict, match="tos-lab"):
        jobs.create("tos-lab", SOURCE)
    assert enqueued == []
    assert not (tmp_path / "work/tos-lab/job.json").exists()


def test_transition_writes_through_and_enqueues_only_running_states(tmp_path: Path) -> None:
    jobs, enqueued = _store(tmp_path)
    jobs.create("a", SOURCE)
    jobs.transition("a", StepDone())
    assert enqueued == [("a", False)]
    jobs.transition("a", ClipChosen(CLIP))
    assert enqueued == [("a", False), ("a", False)]
    assert jobs.get("a").state == Tracking(SOURCE, CLIP)
    with pytest.raises(Conflict):
        jobs.transition("a", ClipChosen(CLIP2))
    assert jobs.get("a").state == Tracking(SOURCE, CLIP)


def test_recover_enqueues_running_jobs_oldest_first(tmp_path: Path) -> None:
    jobs, _ = _store(tmp_path)
    for job_id in ("b", "a", "c"):
        jobs.create(job_id, SOURCE)
    jobs.transition("a", StepDone())
    (tmp_path / "work/tos-lab").mkdir()
    (tmp_path / "work/.sources").mkdir()

    restarted, enqueued = _store(tmp_path)
    assert [j.id for j in restarted.recover()] == ["b", "c"]
    assert enqueued == [("b", True), ("c", True)]
    assert {j.id for j in restarted.list()} == {"a", "b", "c"}


def test_with_settled_holds_only_in_the_named_states(tmp_path: Path) -> None:
    jobs, _ = _store(tmp_path)
    jobs.create("a", SOURCE)
    with pytest.raises(Conflict):
        with jobs.with_settled("a", ("tracked",)):
            pass
    jobs.transition("a", StepDone())
    with jobs.with_settled("a", ("downloaded",)) as job:
        assert job.state == Downloaded(SOURCE)


def test_unknown_job_is_a_key_error(tmp_path: Path) -> None:
    jobs, _ = _store(tmp_path)
    with pytest.raises(KeyError):
        jobs.get("nope")
