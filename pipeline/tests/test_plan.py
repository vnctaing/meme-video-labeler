import pytest

from labelmeme.plan import HiddenKey, Keyframe, PointKey, Segment, Subject, Tracked, boxes_by_frame, missing, plan, plan_subject

CUTS = [100, 200]
FRAMES = 300
BOX = (1, 2, 3, 4)


def p(frame: int, x: int = 10, y: int = 20) -> PointKey:
    return PointKey(frame, (x, y))


def keys(*keyframes: Keyframe) -> list[str]:
    return [s.key for s in plan_subject(keyframes, CUTS, FRAMES)]


def test_a_click_mid_shot_tracks_back_to_the_shot_start_and_on_to_the_cut() -> None:
    assert keys(p(40)) == ["lead|0-40|40@10,20", "tail|40-100|40@10,20"]


def test_a_click_on_the_first_frame_of_a_shot_has_no_lead() -> None:
    assert keys(p(100)) == ["tail|100-200|100@10,20"]


def test_clicks_in_shots_one_and_three_leave_shot_two_empty() -> None:
    segments = plan_subject([p(40), p(250)], CUTS, FRAMES)
    assert [(s.start, s.stop) for s in segments] == [(0, 40), (40, 100), (200, 250), (250, 300)]


def test_two_points_in_a_shot_make_one_bridge_conditioned_on_both() -> None:
    assert keys(p(40), p(70, 30, 40)) == ["lead|0-40|40@10,20", "bridge|40-70|40@10,20;70@30,40", "tail|70-100|70@30,40"]


def test_hide_stops_the_tail_and_the_next_point_gets_no_lead() -> None:
    assert keys(p(40), HiddenKey(60), p(80)) == ["lead|0-40|40@10,20", "tail|40-60|40@10,20", "tail|80-100|80@10,20"]


def test_a_hide_first_in_a_shot_plans_nothing() -> None:
    assert keys(HiddenKey(10), p(40)) == ["tail|40-100|40@10,20"]


def test_segments_never_overlap_and_never_cross_a_cut() -> None:
    segments = plan_subject([p(40), p(60), HiddenKey(80), p(90), p(150), p(299)], CUTS, FRAMES)
    covered = [f for s in segments for f in range(s.start, s.stop)]
    assert len(covered) == len(set(covered))
    assert all(not (s.start < c < s.stop) for s in segments for c in CUTS)


@pytest.mark.parametrize(
    ("edit", "before", "after", "retracked"),
    [
        ("add B between A and C", [p(20), p(80)], [p(20), p(50, 5, 5), p(80)],
         {"bridge|20-50|20@10,20;50@5,5", "bridge|50-80|50@5,5;80@10,20"}),
        ("move B's point", [p(20), p(50), p(80)], [p(20), p(50, 6, 5), p(80)],
         {"bridge|20-50|20@10,20;50@6,5", "bridge|50-80|50@6,5;80@10,20"}),
        ("move B's frame", [p(20), p(50), p(80)], [p(20), p(55), p(80)],
         {"bridge|20-55|20@10,20;55@10,20", "bridge|55-80|55@10,20;80@10,20"}),
        ("delete B", [p(20), p(50), p(80)], [p(20), p(80)], {"bridge|20-80|20@10,20;80@10,20"}),
        ("add H after A", [p(20)], [p(20), HiddenKey(60)], {"tail|20-60|20@10,20"}),
        ("delete H", [p(20), HiddenKey(60)], [p(20)], {"tail|20-100|20@10,20"}),
        ("add a click in another shot", [p(20)], [p(20), p(150)], {"lead|100-150|150@10,20", "tail|150-200|150@10,20"}),
    ],
)
def test_an_edit_retracks_exactly_the_segments_whose_inputs_changed(
    edit: str, before: list[Keyframe], after: list[Keyframe], retracked: set[str]
) -> None:
    cache = {s.key: Tracked(s.start, ()) for s in plan_subject(before, CUTS, FRAMES)}
    todo = missing(plan([Subject("s1", "A", "#ffffff", tuple(after))], CUTS, FRAMES), cache)
    assert {seg.key for _, seg in todo} == retracked, edit


def test_moving_a_click_by_one_pixel_changes_exactly_the_two_segments_that_contain_it() -> None:
    before = set(keys(p(20), p(50), p(80)))
    after = set(keys(p(20), p(50, 11, 20), p(80)))
    assert len(before - after) == 2
    assert len(after - before) == 2


def test_missing_lists_a_key_shared_by_two_subjects_once() -> None:
    same = (p(40),)
    planned = plan([Subject("s1", "", "#ffffff", same), Subject("s2", "", "#000000", same)], CUTS, FRAMES)
    assert [(sid, seg.kind) for sid, seg in missing(planned, {})] == [("s1", "lead"), ("s1", "tail")]


def test_boxes_by_frame_is_the_union_of_tracked_segments_without_lost_frames() -> None:
    lead, tail = Segment("lead", 0, 3, (p(3),)), Segment("tail", 3, 6, (p(3),))
    cache = {lead.key: Tracked(0, (BOX, None, BOX)), tail.key: Tracked(3, (BOX, BOX, BOX))}
    assert sorted(boxes_by_frame([lead, tail], cache)) == [0, 2, 3, 4, 5]
    assert sorted(boxes_by_frame([lead, tail], {tail.key: cache[tail.key]})) == [3, 4, 5]
