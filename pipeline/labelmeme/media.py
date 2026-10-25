from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cv2


@dataclass(frozen=True, slots=True)
class VideoInfo:
    width: int
    height: int
    r_frame_rate: str
    avg_frame_rate: str
    start_time: float
    nb_read_frames: int
    audio_codec: str | None


def _run(args: list[str]) -> str:
    return subprocess.run(args, start_new_session=True, check=True, capture_output=True, text=True).stdout


def probe(path: Path) -> VideoInfo:
    out = _run(
        [
            "ffprobe", "-v", "error", "-count_frames",
            "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,start_time,nb_read_frames",
            "-of", "json", str(path),
        ]
    )
    streams = json.loads(out)["streams"]
    video = next((s for s in streams if s["codec_type"] == "video"), None)
    if video is None:
        raise ValueError(f"{path}: no video stream")
    audio = next((s for s in streams if s["codec_type"] == "audio"), None)
    return VideoInfo(
        width=int(video["width"]),
        height=int(video["height"]),
        r_frame_rate=video["r_frame_rate"],
        avg_frame_rate=video["avg_frame_rate"],
        start_time=float(video.get("start_time", "0")),
        nb_read_frames=int(video["nb_read_frames"]),
        audio_codec=audio["codec_name"] if audio else None,
    )


def encode(src: Path, dst: Path, fps: int, start: float = 0.0, duration: float | None = None) -> VideoInfo:
    has_audio = probe(src).audio_codec is not None
    args = ["ffmpeg", "-v", "error", "-y", "-ss", f"{start}", "-i", str(src)]
    if has_audio:
        args += ["-map", "0:v:0", "-map", "0:a:0"]
    else:
        args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0", "-shortest"]
    if duration is not None:
        args += ["-t", f"{duration}"]
    args += [
        # A start between two source frames would otherwise put the first output frame after t=0.
        "-vf", f"fps={fps}:start_time=0",
        "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-bf", "0",
        "-video_track_timescale", str(fps * 1000),
        "-c:a", "aac", "-b:a", "128k",
        "-map_metadata", "-1", "-fflags", "+bitexact",
        "-movflags", "+faststart",
        str(dst),
    ]
    _run(args)
    return assert_grid(dst, fps)


def thumbnail(src: Path, dst: Path) -> None:
    _run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-frames:v", "1", "-q:v", "3", "-fflags", "+bitexact", str(dst)])


def assert_grid(path: Path, fps: int) -> VideoInfo:
    info = probe(path)
    expected = f"{fps}/1"
    if not (info.r_frame_rate == info.avg_frame_rate == expected):
        raise ValueError(f"{path}: frame rate r={info.r_frame_rate} avg={info.avg_frame_rate}, expected {expected}")
    if info.start_time != 0:
        raise ValueError(f"{path}: start_time {info.start_time}, expected 0")
    return info


def count_frames_cv2(path: Path) -> int:
    cap = cv2.VideoCapture(str(path))
    try:
        count = 0
        while cap.read()[0]:
            count += 1
    finally:
        cap.release()
    expected = probe(path).nb_read_frames
    if count != expected:
        raise ValueError(f"{path}: OpenCV decoded {count} frames, ffprobe counted {expected}")
    return count
