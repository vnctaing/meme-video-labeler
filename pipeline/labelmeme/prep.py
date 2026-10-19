from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from labelmeme import media


@dataclass(frozen=True, slots=True)
class PrepSpec:
    source: Path
    start: float
    duration: float
    id: str
    title: str
    credit: str
    source_url: str
    license: str
    fps: int


@dataclass(frozen=True, slots=True)
class VideoFacts:
    id: str
    title: str
    credit: str
    width: int
    height: int
    fps: int
    frameCount: int


def read_facts(work: Path) -> VideoFacts:
    return VideoFacts(**json.loads((work / "video.json").read_text(encoding="utf-8")))


def prep(spec: PrepSpec, work: Path, command: str) -> VideoFacts:
    work.mkdir(parents=True, exist_ok=True)
    video = work / "video.mp4"
    info = media.encode(spec.source, video, spec.fps, spec.start, spec.duration)
    facts = VideoFacts(
        id=spec.id,
        title=spec.title,
        credit=spec.credit,
        width=info.width,
        height=info.height,
        fps=spec.fps,
        frameCount=media.count_frames_cv2(video),
    )
    media.thumbnail(video, work / "thumb.jpg")
    (work / "video.json").write_text(json.dumps(asdict(facts), indent=2) + "\n", encoding="utf-8")
    end = spec.start + spec.duration
    (work / "SOURCE.md").write_text(
        f"# {spec.id}\n\n"
        f"- Title: {spec.title}\n"
        f"- Source: {spec.source_url}\n"
        f"- License: {spec.license}\n"
        f"- Credit: {spec.credit}\n"
        f"- Range: {spec.start:g} s to {end:g} s of the source ({spec.duration:g} s), "
        f"re-encoded to {spec.fps} fps, {facts.frameCount} frames, {facts.width}x{facts.height}\n\n"
        f"Produced from `pipeline/` with:\n\n```sh\n{command}\n```\n",
        encoding="utf-8",
    )
    return facts
