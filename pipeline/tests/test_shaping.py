from labelmeme.shaping import Run, ShapeParams, drop_short_runs, runs_from_frames, shape_subject, smooth_run

BOX = (100.0, 50.0, 40.0, 80.0)


def test_gap_inside_a_shot_is_interpolated_linearly() -> None:
    frames = {10: (0.0, 0.0, 10.0, 10.0), 14: (40.0, 8.0, 50.0, 30.0)}

    runs = runs_from_frames(frames, breaks=[], max_gap=3)

    assert runs == [
        Run(10, ((0.0, 0.0, 10.0, 10.0), (10.0, 2.0, 20.0, 15.0), (20.0, 4.0, 30.0, 20.0), (30.0, 6.0, 40.0, 25.0), (40.0, 8.0, 50.0, 30.0)))
    ]


def test_gap_longer_than_max_gap_splits_the_run() -> None:
    frames = {0: BOX, 5: BOX}

    assert runs_from_frames(frames, breaks=[], max_gap=3) == [Run(0, (BOX,)), Run(5, (BOX,))]


def test_gap_spanning_a_cut_is_not_interpolated() -> None:
    frames = {8: BOX, 11: BOX}

    runs = runs_from_frames(frames, breaks=[10], max_gap=6)

    assert runs == [Run(8, (BOX,)), Run(11, (BOX,))]


def test_contiguous_frames_split_at_a_cut() -> None:
    frames = {f: BOX for f in range(5, 15)}

    runs = runs_from_frames(frames, breaks=[10], max_gap=6)

    assert [(r.start, r.end) for r in runs] == [(5, 10), (10, 15)]


def test_runs_shorter_than_min_run_are_dropped() -> None:
    runs = [Run(0, (BOX,) * 7), Run(20, (BOX,) * 8), Run(40, (BOX,) * 3)]

    assert drop_short_runs(runs, min_len=8) == [Run(20, (BOX,) * 8)]


def test_smoothing_is_a_centered_mean_that_keeps_run_length() -> None:
    xs = [0.0, 0.0, 50.0, 0.0, 0.0, 0.0]
    run = Run(3, tuple((x, 0.0, 10.0, 10.0) for x in xs))

    smoothed = smooth_run(run, window=5)

    assert smoothed.start == 3
    assert [b[0] for b in smoothed.boxes] == [50 / 3, 12.5, 10.0, 10.0, 12.5, 0.0]


def test_shaped_runs_keep_their_length_and_stay_inside_the_frame() -> None:
    width, height = 200, 100
    jitter = [(-6.0, -3.0, 60.0, 50.0), (-2.0, -1.0, 60.0, 50.0)] * 3 + [(150.0, 60.0, 70.0, 50.0), (146.0, 58.0, 70.0, 50.0)] * 3
    track = {20 + i: box for i, box in enumerate(jitter)}

    runs = shape_subject(track, breaks=[], width=width, height=height, params=ShapeParams())

    assert [(r["from"], len(r["boxes"])) for r in runs] == [(20, 12)]
    for x, y, w, h in runs[0]["boxes"]:
        assert all(isinstance(v, int) for v in (x, y, w, h))
        assert x >= 0 and y >= 0 and w >= 1 and h >= 1 and x + w <= width and y + h <= height


def test_shape_subject_bridges_a_flicker_and_keeps_a_short_run_after_a_cut() -> None:
    track = {f: BOX for f in range(0, 30) if f not in (12, 13)} | {f: BOX for f in range(30, 33)} | {f: BOX for f in range(50, 70)}

    runs = shape_subject(track, breaks=[30], width=640, height=360, params=ShapeParams())

    assert [(r["from"], len(r["boxes"])) for r in runs] == [(0, 30), (30, 3), (50, 20)]
