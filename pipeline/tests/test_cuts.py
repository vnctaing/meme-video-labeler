import json
from pathlib import Path

import pytest

from labelmeme.cuts import read_cuts


def _write_cuts(work: Path, frames: list[object]) -> None:
    (work / "cuts.json").write_text(json.dumps({"cuts": [{"frame": f} for f in frames]}), encoding="utf-8")


def test_reads_valid_cuts(tmp_path: Path) -> None:
    _write_cuts(tmp_path, [24, 40])
    assert read_cuts(tmp_path, 48) == [24, 40]


@pytest.mark.parametrize(
    ("frames", "bad"),
    [([0], "0"), ([48], "48"), ([30, 24], "24"), ([24, 24], "24"), ([24.5], "24.5"), (["24"], "'24'"), ([True], "True")],
)
def test_rejects_a_cut_the_tracker_cannot_start_a_shot_at(tmp_path: Path, frames: list[object], bad: str) -> None:
    _write_cuts(tmp_path, frames)
    with pytest.raises(ValueError, match=rf"cuts\.json: .*, got {bad}$"):
        read_cuts(tmp_path, 48)
