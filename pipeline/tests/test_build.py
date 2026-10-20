import json
from pathlib import Path

import pytest

from labelmeme.build import parse_subjects
from labelmeme.track import tracks_id, write_subjects_stub

TRACKS = b'{"s1-1":[{"frame":0,"box":[1,1,2,2],"conf":0.9}],"s2-1":[{"frame":30,"box":[1,1,2,2],"conf":0.9}]}\n'


def _subjects(tid: str | None) -> dict[str, object]:
    raw: dict[str, object] = {"subjects": [{"id": "thom", "name": "Thom", "tracks": ["s1-1", "s2-1"]}]}
    if tid is not None:
        raw["tracksId"] = tid
    return raw


def test_tracks_id_changes_when_the_cuts_or_the_tracks_change() -> None:
    base = tracks_id([24], TRACKS)
    assert tracks_id([24], TRACKS) == base
    assert tracks_id([20], TRACKS) != base
    assert tracks_id([24], TRACKS.replace(b"s2-1", b"s2-2")) != base


def test_the_stub_track_writes_is_accepted_by_build(tmp_path: Path) -> None:
    tid = tracks_id([24], TRACKS)
    write_subjects_stub(tmp_path / "subjects.json", ["s1-1", "s2-1"], tid)
    stub = json.loads((tmp_path / "subjects.json").read_text())
    assert stub["tracksId"] == tid
    stub["subjects"] = [{"id": "thom", "name": "Thom", "tracks": ["s1-1", "s2-1"]}]
    assert [s.id for s in parse_subjects(stub, {"s1-1", "s2-1"}, tid)] == ["thom"]


def test_refuses_subjects_written_for_other_tracks() -> None:
    old, new = tracks_id([24], TRACKS), tracks_id([20], TRACKS)
    with pytest.raises(ValueError, match=rf'subjects\.json: written for tracksId "{old}", but cuts\.json and tracks\.json now give "{new}"'):
        parse_subjects(_subjects(old), {"s1-1", "s2-1"}, new)


def test_refuses_subjects_without_a_tracks_id() -> None:
    tid = tracks_id([24], TRACKS)
    with pytest.raises(ValueError, match=rf'subjects\.json: no "tracksId" field.*"tracksId": "{tid}"'):
        parse_subjects(_subjects(None), {"s1-1", "s2-1"}, tid)
