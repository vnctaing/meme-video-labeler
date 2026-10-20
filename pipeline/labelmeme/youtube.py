from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from labelmeme.job import SourceFacts

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com"}
SHORT_HOSTS = {"youtu.be", "www.youtu.be"}

# H.264 + AAC so the Clip step's <video> plays it in Chromium and Safari without transcoding.
FORMAT = "bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4][vcodec^=avc1]"

KNOWN_ERRORS = (
    ("Private video", "This video is private."),
    ("video unavailable", "This video is unavailable."),
    ("video is unavailable", "This video is unavailable."),
    ("confirm your age", "This video is age-restricted, so it cannot be downloaded without signing in."),
    ("Requested format is not available", "This video has no H.264 version at 720p or below."),
)


class SourceError(Exception):
    pass


def canonical_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def parse_youtube_url(text: str) -> tuple[str, str]:
    bad = SourceError("Paste a YouTube video link, like https://www.youtube.com/watch?v=R6MlUcmOul8 or https://youtu.be/R6MlUcmOul8.")
    text = text.strip()
    if "://" not in text:
        text = f"https://{text}"
    parts = urlsplit(text)
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https"):
        raise bad
    candidate: str | None = None
    if host in SHORT_HOSTS:
        candidate = parts.path.strip("/")
    elif host in HOSTS:
        if parts.path == "/watch":
            candidate = (parse_qs(parts.query).get("v") or [None])[0]
        else:
            m = re.fullmatch(r"/(?:shorts|embed|live)/([^/]+)/?", parts.path)
            candidate = m.group(1) if m else None
    if candidate is None or VIDEO_ID.fullmatch(candidate) is None:
        raise bad
    return candidate, canonical_url(candidate)


def plain_error(message: str) -> str:
    for needle, plain in KNOWN_ERRORS:
        if needle.lower() in message.lower():
            return plain
    return "YouTube said: " + re.sub(r"^ERROR: (\[[^\]]+\] [^:]+: )?", "", message).strip()


def _ydl(extra: dict):
    from yt_dlp import YoutubeDL

    return YoutubeDL({"format": FORMAT, "noplaylist": True, "quiet": True, "noprogress": True, **extra})


def _facts(info: dict) -> SourceFacts:
    return SourceFacts(
        video_id=info["id"], url=canonical_url(info["id"]), title=info.get("title") or info["id"],
        channel=info.get("channel") or info.get("uploader") or "unknown channel",
        duration=float(info.get("duration") or 0), width=int(info.get("width") or 0), height=int(info.get("height") or 0),
    )


def probe(url: str) -> SourceFacts:
    from yt_dlp.utils import DownloadError

    try:
        with _ydl({}) as ydl:
            info = ydl.extract_info(url, download=False)
    except DownloadError as e:
        raise SourceError(plain_error(str(e))) from e
    if not info.get("duration"):
        raise SourceError("This looks like a live stream or a video without a known length.")
    return _facts(info)


def source_path(sources_dir: Path, video_id: str) -> Path:
    return sources_dir / video_id / "source.mp4"


def download(source: SourceFacts, sources_dir: Path, on_bytes: Callable[[int, int | None], None]) -> Path:
    """yt-dlp writes source.mp4 only once the merge finished, so its presence means done;
    a killed run leaves .part files that continuedl resumes."""
    from yt_dlp.utils import DownloadError

    target = source_path(sources_dir, source.video_id)
    if target.is_file():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    per_file: dict[str, int] = {}
    total: int | None = None

    def hook(d: dict) -> None:
        per_file[d["filename"]] = d.get("downloaded_bytes") or 0
        on_bytes(sum(per_file.values()), total)

    opts = {"outtmpl": str(target.parent / "source.%(ext)s"), "merge_output_format": "mp4",
            "continuedl": True, "progress_hooks": [hook]}
    try:
        with _ydl(opts) as ydl:
            info = ydl.extract_info(source.url, download=False)
            formats = info.get("requested_formats") or [info]
            sizes = [f.get("filesize") or f.get("filesize_approx") for f in formats]
            total = sum(sizes) if all(sizes) else None
            ydl.process_ie_result(info, download=True)
    except DownloadError as e:
        raise SourceError(plain_error(str(e))) from e
    if not target.is_file():
        raise SourceError(f"yt-dlp finished without writing {target.name}.")
    return target
