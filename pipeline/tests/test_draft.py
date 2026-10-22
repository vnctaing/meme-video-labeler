import json
from pathlib import Path

import pytest

from labelmeme.draft import ClipFacts, dump_draft, parse_draft, read_draft

CLIP = ClipFacts(fps=24, frame_count=4, width=640, height=360, cuts=(2,))


def _draft(**changes: object) -> dict:
    subject = {"id": "s1", "name": " Thom ", "color": "#f5a524", "track": [None, "hidden", [10.5, 20, 30.2, 0.5], None]}
    return {"version": 1, "title": "T", "tuning": {"lagMs": 150, "smoothRadius": 4}, "subjects": [subject]} | changes


def _with_track(track: list) -> dict:
    d = _draft()
    d["subjects"][0]["track"] = track
    return d


def test_a_missing_file_reads_as_an_empty_draft_with_the_clip_title(tmp_path: Path) -> None:
    assert read_draft(tmp_path, "Clip title", CLIP) == {
        "version": 1, "title": "Clip title", "tuning": {"lagMs": 150, "smoothRadius": 4}, "subjects": [],
    }


def test_parse_accepts_null_hidden_and_a_sample_and_strips_the_name() -> None:
    parsed = parse_draft(_draft(), CLIP)
    assert parsed["subjects"][0]["track"] == [None, "hidden", [10.5, 20, 30.2, 0.5], None]
    assert parsed["subjects"][0]["name"] == "Thom"


@pytest.mark.parametrize(("draft", "path"), [
    (_with_track([None, None, None]), "$.subjects[0].track"),
    (_with_track([None, [1, 2], None, None]), "$.subjects[0].track[1]"),
    (_with_track([None, [True, 1, 1, 1], None, None]), "$.subjects[0].track[1][0]"),
    (_with_track([None, [641, 1, 1, 1], None, None]), "$.subjects[0].track[1][0]"),
    (_with_track([None, [1, 1, 1, 0.3], None, None]), "$.subjects[0].track[1][3]"),
    (_with_track([None, [1, 1, 0, 1], None, None]), "$.subjects[0].track[1][2]"),
    (_draft(tuning={"lagMs": 401, "smoothRadius": 4}), "$.tuning.lagMs"),
    (_draft(subjects=[_draft()["subjects"][0], _draft()["subjects"][0]]), "$.subjects[1].id"),
])
def test_parse_rejects_and_names_the_path(draft: dict, path: str) -> None:
    with pytest.raises(ValueError) as e:
        parse_draft(draft, CLIP)
    assert str(e.value).split(":", 1)[0] == path


def test_dump_and_parse_round_trip() -> None:
    once = dump_draft(parse_draft(_draft(), CLIP))
    assert dump_draft(parse_draft(json.loads(once), CLIP)) == once


@pytest.mark.parametrize("title", ["", "   "])
def test_a_blank_title_is_still_a_draft(title: str) -> None:
    assert parse_draft(_draft(title=title), CLIP)["title"] == title


def test_a_title_over_the_limit_is_rejected() -> None:
    with pytest.raises(ValueError, match=r"^\$\.title: "):
        parse_draft(_draft(title="x" * 201), CLIP)
