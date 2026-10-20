import pytest

from labelmeme.build import parse_subjects
from labelmeme.people import Draft, Person, cards, issues, parse_draft, suggest, to_subjects_json


def _track(first: int, last: int, x: int = 100, step: int = 0) -> list:
    return [{"frame": f, "box": [x + step * (f - first), 50, 40, 100], "conf": 0.9} for f in range(first, last + 1)]


TRACKS = {
    "s1-1": _track(0, 99, x=600),
    "s1-2": _track(0, 143, x=100),
    "s1-3": _track(10, 60, x=300),
    "s1-6": _track(142, 227, x=102),
    "s1-7": _track(150, 227, x=900),
    "s2-1": _track(228, 300, x=100),
}


def test_cards_sorted_by_shot_then_first_frame() -> None:
    got = [(c.id, c.shot, c.first, c.last, c.detections) for c in cards(TRACKS)]
    assert got == [
        ("s1-1", 1, 0, 99, 100), ("s1-2", 1, 0, 143, 144), ("s1-3", 1, 10, 60, 51),
        ("s1-6", 1, 142, 227, 86), ("s1-7", 1, 150, 227, 78), ("s2-1", 2, 228, 300, 73),
    ]


def test_suggest_chains_an_id_switch_in_one_shot_and_nothing_else() -> None:
    draft = suggest(TRACKS, "abc")
    assert draft.tracks_id == "abc"
    assert [p.tracks for p in draft.people] == [("s1-1",), ("s1-2", "s1-6"), ("s1-3",), ("s1-7",), ("s2-1",)]
    assert all(p.name == "" for p in draft.people)


def test_suggest_does_not_chain_a_far_away_box() -> None:
    tracks = {"s1-1": _track(0, 50, x=100), "s1-2": _track(52, 90, x=700)}
    assert [p.tracks for p in suggest(tracks, "abc").people] == [("s1-1",), ("s1-2",)]


def test_suggest_never_chains_across_a_cut() -> None:
    tracks = {"s1-1": _track(0, 50, x=100), "s2-1": _track(51, 90, x=100)}
    assert [p.tracks for p in suggest(tracks, "abc").people] == [("s1-1",), ("s2-1",)]


def test_subjects_json_derives_ids_from_names_and_build_accepts_it() -> None:
    draft = Draft("abc", (Person("Thom", ("s1-1", "s2-1")), Person("Dr. Celia", ("s1-2",)), Person("Thom", ("s1-3",))))
    raw = to_subjects_json(draft)
    assert raw == {"tracksId": "abc", "subjects": [
        {"id": "thom", "name": "Thom", "tracks": ["s1-1", "s2-1"]},
        {"id": "dr-celia", "name": "Dr. Celia", "tracks": ["s1-2"]},
        {"id": "thom-2", "name": "Thom", "tracks": ["s1-3"]},
    ]}
    assert [s.id for s in parse_subjects(raw, set(TRACKS), "abc")] == ["thom", "dr-celia", "thom-2"]


def test_unnamed_and_non_latin_names() -> None:
    raw = to_subjects_json(Draft("abc", (Person("", ("s1-1",)), Person("日本", ("s1-2",)))))
    assert [(s["id"], s["name"]) for s in raw["subjects"]] == [("", ""), ("person-2", "日本")]


def test_parse_draft_round_trips_and_is_lenient_about_names() -> None:
    draft = Draft("abc", (Person("", ("s1-1",)), Person("Thom", ("s1-2", "s1-6"))))
    assert parse_draft(to_subjects_json(draft), set(TRACKS), "abc") == draft


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ({"tracksId": "old", "subjects": []}, "written for tracksId"),
        ({"subjects": []}, "written for tracksId"),
        ({"tracksId": "abc", "subjects": [{"id": "", "name": "", "tracks": ["s9-9"]}]}, "unknown track id 's9-9'"),
        ({"tracksId": "abc", "subjects": [{"id": "", "name": "", "tracks": ["s1-1"]}, {"id": "", "name": "", "tracks": ["s1-1"]}]}, "already claimed"),
        ({"tracksId": "abc", "subjects": [{"id": "", "name": "", "tracks": []}]}, "non-empty list"),
    ],
)
def test_parse_draft_rejects(raw: object, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        parse_draft(raw, set(TRACKS), "abc")


def test_issues_block_unnamed_duplicate_and_empty() -> None:
    assert [(i.person, i.blocking) for i in issues(Draft("abc", ()), TRACKS)] == [(-1, True)]
    got = issues(Draft("abc", (Person("", ("s1-1",)), Person("Thom", ("s1-2",)), Person("thom", ("s2-1",)))), TRACKS)
    assert [(i.person, i.blocking, i.message) for i in got] == [
        (0, True, "Person 1 needs a name."),
        (2, True, 'Two people are named "thom".'),
    ]


def test_overlap_in_one_shot_is_a_warning_not_a_block() -> None:
    got = issues(Draft("abc", (Person("Celia", ("s1-1", "s1-3")),)), TRACKS)
    assert [(i.person, i.blocking) for i in got] == [(0, False)]
    assert "s1-1 and s1-3 are on screen together in shot 1, frames 10 to 60" in got[0].message
