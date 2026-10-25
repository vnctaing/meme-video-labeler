from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import TypedDict

SCENE_THRESHOLD = 0.3


class Cut(TypedDict):
    frame: int
    seconds: float
    score: float


def detect_cuts(video: Path, fps: int, threshold: float) -> list[Cut]:
    out = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", str(video), "-an",
            "-vf", f"select='gt(scene,{threshold})',metadata=print:file=-", "-f", "null", "-",
        ],
        check=True, capture_output=True, text=True,
    ).stdout
    pairs = re.findall(r"pts_time:([0-9.]+)\s+lavfi\.scene_score=([0-9.]+)", out)
    frames = [(round(float(t) * fps), float(s)) for t, s in pairs]
    return [{"frame": f, "seconds": round(f / fps, 3), "score": round(s, 3)} for f, s in frames]


def write_cuts(work: Path, fps: int) -> list[Cut]:
    cuts = detect_cuts(work / "video.mp4", fps, SCENE_THRESHOLD)
    (work / "cuts.json").write_text(json.dumps({"scene_threshold": SCENE_THRESHOLD, "cuts": cuts}, indent=2) + "\n", encoding="utf-8")
    return cuts


def read_cuts(work: Path, frame_count: int) -> list[int]:
    path = work / "cuts.json"
    cuts: list[int] = []
    for i, c in enumerate(json.loads(path.read_text(encoding="utf-8"))["cuts"]):
        f = c["frame"]
        valid = isinstance(f, int) and not isinstance(f, bool) and 0 < f < frame_count and (not cuts or cuts[-1] < f)
        if not valid:
            raise ValueError(f"{path}: cuts[{i}].frame must be an integer in (0, {frame_count}), sorted and unique, got {f!r}")
        cuts.append(f)
    return cuts
