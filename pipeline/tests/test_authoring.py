import json
from pathlib import Path

import pytest

from labelmeme.authoring import AuthoringStore, ClipFacts, parse_subjects
from labelmeme.plan import HiddenKey, PointKey, Subject, Tracked

CLIP = ClipFacts(fps=24, frame_count=300, width=640, height=360, cuts=(100, 200))


def _store(tmp_path: Path) -> AuthoringStore:
    work = tmp_path / "job"
    work.mkdir()
    facts = {"id": "job", "title": "t", "credit": "c", "width": 640, "height": 360, "fps": 24, "frameCount": 300}
    (work / "video.json").write_text(json.dumps(facts))
    (work / "cuts.json").write_text(json.dumps({"cuts": [{"frame": 100}, {"frame": 200}]}))
    store = AuthoringStore(tmp_path)
    store.reset("job", "Title")
    return store


def _subject(sid: str, *keys: PointKey | HiddenKey) -> Subject:
    return Subject(sid, sid.upper(), "#f5b800", keys)


def test_an_edit_drops_cached_segments_it_no_longer_plans_and_a_superseded_result_is_discarded(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.edit("job", (_subject("s1", PointKey(40, (10, 20))),), "Title")
    lead, tail = sorted((seg for _, seg in store.missing("job")), key=lambda seg: seg.start)
    assert store.put_segment("job", lead, Tracked(0, ()))
    assert store.put_segment("job", tail, Tracked(40, ()))

    edited = store.edit("job", (_subject("s1", PointKey(40, (10, 20)), HiddenKey(60)),), "Title")

    assert set(edited.segments) == {lead.key}
    assert not store.is_planned("job", tail.key)
    assert not store.put_segment("job", tail, Tracked(40, ()))
    assert [seg.key for _, seg in store.missing("job")] == ["tail|40-60|40@10,20"]
    assert set(store.read("job")[0].segments) == {lead.key}


def test_missing_puts_the_segment_nearest_the_last_edit_first(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.edit("job", (_subject("s1", PointKey(40, (10, 20))), _subject("s2", PointKey(250, (5, 5)))), "Title")
    store.edit("job", (_subject("s1", PointKey(40, (10, 20))), _subject("s2", PointKey(250, (5, 5)), PointKey(280, (6, 6)))), "Title")
    order = [(sid, seg.start) for sid, seg in store.missing("job")]
    assert order[0] == ("s2", 280)
    assert order[-2:] == [("s1", 40), ("s1", 0)]


@pytest.mark.parametrize(
    ("raw", "path"),
    [
        ([{"id": "s1", "name": "", "color": "#f5b800", "keyframes": [{"frame": 300, "hidden": True}]}], r"\$\.subjects\[0\]\.keyframes\[0\]\.frame"),
        ([{"id": "s1", "name": "", "color": "#f5b800", "keyframes": [{"frame": 3, "point": [640, 0]}]}], r"\.point\[0\]"),
        ([{"id": "s1", "name": "", "color": "#f5b800", "keyframes": [{"frame": 3, "point": [1, 1], "hidden": True}]}], r"exactly one of"),
        ([{"id": "s1", "name": "", "color": "#f5b800", "keyframes": [{"frame": 5, "hidden": True}, {"frame": 5, "point": [1, 1]}]}], r"sorted by frame"),
        ([{"id": "s1", "name": "", "color": "#f5b800", "keyframes": []}, {"id": "s1", "name": "", "color": "#000000", "keyframes": []}], r"duplicate"),
        ([{"id": "S 1", "name": "", "color": "#f5b800", "keyframes": []}], r"\.id: expected a slug"),
    ],
)
def test_parse_subjects_names_the_broken_path(raw: object, path: str) -> None:
    with pytest.raises(ValueError, match=path):
        parse_subjects(raw, CLIP)
