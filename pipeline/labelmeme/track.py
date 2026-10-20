from __future__ import annotations

import hashlib
import json
import re
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import TypedDict

import cv2
import torch
from ultralytics import YOLO

from labelmeme import sheets
from labelmeme.prep import read_facts

SCENE_THRESHOLD = 0.3
MODEL = "yolo11m.pt"
IMGSZ = 1280
PERSON = 0
TRACKER_YAML = Path(__file__).resolve().parents[1] / "bytetrack_labelmeme.yaml"
SHEET_SAMPLES = 8


class Detection(TypedDict):
    frame: int
    box: list[int]
    conf: float


class Cut(TypedDict):
    frame: int
    seconds: float
    score: float


Tracks = dict[str, list[Detection]]


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


def tracks_id(cuts: list[int], tracks_json: bytes) -> str:
    return hashlib.sha256(json.dumps(cuts).encode() + b"\n" + tracks_json).hexdigest()[:16]


def write_subjects_stub(path: Path, track_ids: list[str], current_id: str) -> None:
    stub = {"tracksId": current_id, "subjects": [{"id": "", "name": "", "tracks": [t]} for t in track_ids]}
    path.write_text(json.dumps(stub, indent=2) + "\n", encoding="utf-8")


def _device() -> str:
    return "mps" if torch.backends.mps.is_available() else "cpu"


def run_tracker(video: Path, cuts: list[int], model_path: Path, on_frame: Callable[[int], None]) -> tuple[Tracks, int]:
    model = YOLO(str(model_path))
    device = _device()
    print(f"tracking on {device}")
    by_shot: dict[tuple[int, int], list[Detection]] = {}
    shot = 1
    cap = cv2.VideoCapture(str(video))
    try:
        frame_index = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_index in cuts:
                shot += 1
                model.predictor.trackers[0].reset()
            result = model.track(
                frame, persist=True, tracker=str(TRACKER_YAML), classes=[PERSON],
                imgsz=IMGSZ, device=device, verbose=False,
            )[0]
            if result.boxes.is_track:
                ids = result.boxes.id.int().cpu().tolist()
                xyxy = result.boxes.xyxy.cpu().numpy()
                confs = result.boxes.conf.cpu().tolist()
                for raw_id, (x1, y1, x2, y2), conf in zip(ids, xyxy, confs):
                    x, y = round(float(x1)), round(float(y1))
                    box = [x, y, round(float(x2)) - x, round(float(y2)) - y]
                    by_shot.setdefault((shot, raw_id), []).append(
                        {"frame": frame_index, "box": box, "conf": round(float(conf), 3)}
                    )
            frame_index += 1
            on_frame(frame_index)
    finally:
        cap.release()
    return {f"s{shot}-{n}": by_shot[(shot, n)] for shot, n in sorted(by_shot)}, frame_index


def _caption(track_id: str, dets: list[Detection]) -> str:
    return f"{track_id} f{dets[0]['frame']}-{dets[-1]['frame']}"


def _spread(dets: list[Detection], n: int) -> list[Detection]:
    if len(dets) <= n:
        return dets
    return [dets[round(i * (len(dets) - 1) / (n - 1))] for i in range(n)]


def write_track_sheets(video: Path, tracks: Tracks, sheets_dir: Path) -> None:
    ids = list(tracks)
    medians = {tid: tracks[tid][len(tracks[tid]) // 2] for tid in ids}
    samples = {tid: _spread(tracks[tid], SHEET_SAMPLES) for tid in ids}
    wanted = {d["frame"] for d in medians.values()} | {d["frame"] for s in samples.values() for d in s}
    frames = sheets.read_frames(video, wanted)

    overview = [
        sheets.tile(sheets.crop(frames[medians[tid]["frame"]], medians[tid]["box"]), _caption(tid, tracks[tid]), 150, 220)
        for tid in ids
    ]
    sheets.write_jpg(sheets_dir / "overview.jpg", sheets.grid(overview, cols=8))
    for tid in ids:
        crops = [sheets.tile(sheets.crop(frames[d["frame"]], d["box"]), f"{tid} f{d['frame']}", 150, 220) for d in samples[tid]]
        sheets.write_jpg(sheets_dir / f"track_{tid}.jpg", sheets.grid(crops, cols=SHEET_SAMPLES))


def track(work: Path, models_dir: Path, on_frame: Callable[[int], None] = lambda _: None) -> Tracks:
    facts = read_facts(work)
    video = work / "video.mp4"
    cuts_path = work / "cuts.json"
    if cuts_path.exists():
        print(f"keeping hand-editable {cuts_path}")
    else:
        cuts = detect_cuts(video, facts.fps, SCENE_THRESHOLD)
        cuts_path.write_text(json.dumps({"scene_threshold": SCENE_THRESHOLD, "cuts": cuts}, indent=2) + "\n", encoding="utf-8")
    cuts = read_cuts(work, facts.frameCount)
    print(f"cuts at frames {cuts}")

    models_dir.mkdir(parents=True, exist_ok=True)
    tracks, decoded = run_tracker(video, cuts, models_dir / MODEL, on_frame)
    if decoded != facts.frameCount:
        raise ValueError(f"{video}: tracked {decoded} frames, video.json says {facts.frameCount}")
    tracks_json = (json.dumps(tracks, separators=(",", ":")) + "\n").encode()
    (work / "tracks.json").write_bytes(tracks_json)
    current_id = tracks_id(cuts, tracks_json)

    sheets_dir = work / "sheets"
    for old in sheets_dir.glob("track_*.jpg"):
        old.unlink()
    write_track_sheets(video, tracks, sheets_dir)

    subjects_path = work / "subjects.json"
    if subjects_path.exists():
        print(f"keeping existing {subjects_path}, these tracks have tracksId {current_id!r}")
    else:
        write_subjects_stub(subjects_path, list(tracks), current_id)
    for tid, dets in tracks.items():
        print(f"{_caption(tid, dets)} ({len(dets)} detections)")
    return tracks
