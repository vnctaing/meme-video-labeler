from __future__ import annotations

import hashlib
import os
import subprocess
import urllib.request
from bisect import bisect_right
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from labelmeme.plan import Box4, Segment, Tracked

if TYPE_CHECKING:
    import torch

STRIDE = 2
IMAGE_SIZE = 1024
WEIGHTS_URL = "https://github.com/facebookresearch/EdgeTAM/raw/7711e012a30a2402c4eaab637bdb00a521302c91/checkpoints/edgetam.pt"
WEIGHTS_SHA256 = "ed2d4850b8792c239689b043c47046ec239b6e808a3d9b6ae676c803fd8780df"
CONFIG_DIR = Path(__file__).resolve().parent
CONFIG = "edgetam.yaml"
IMG_MEAN = (0.485, 0.456, 0.406)
IMG_STD = (0.229, 0.224, 0.225)


class Cancelled(Exception):
    pass


@dataclass(frozen=True, slots=True)
class Clip:
    video: Path
    width: int
    height: int


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_weights(models_dir: Path, url: str = WEIGHTS_URL, sha256: str = WEIGHTS_SHA256) -> Path:
    path = models_dir / "edgetam.pt"
    if path.is_file() and _sha256(path) == sha256:
        return path
    models_dir.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(".pt.part")
    urllib.request.urlretrieve(url, part)
    got = _sha256(part)
    if got != sha256:
        part.unlink()
        raise ValueError(f"{url}: sha256 is {got}, expected {sha256}")
    os.replace(part, path)
    return path


def grid(seg: Segment) -> list[int]:
    """Frames the tracker sees. Even frames on an absolute grid, so neighbouring segments agree, plus ends and clicks."""
    lo, hi = seg.start, max(seg.stop - 1, seg.clicks[-1].frame)
    return sorted({lo, hi, *(c.frame for c in seg.clicks), *range(lo + lo % STRIDE, hi + 1, STRIDE)})


def fill(boxes: dict[int, Box4 | None], first: int, last: int) -> list[Box4 | None]:
    """Linear interpolation between tracked frames; no box where either neighbour lost the subject."""
    known = sorted(boxes)
    out: list[Box4 | None] = []
    for n in range(first, last + 1):
        if n in boxes:
            out.append(boxes[n])
            continue
        i = bisect_right(known, n)
        a, b = known[i - 1], known[i]
        pa, pb = boxes[a], boxes[b]
        if pa is None or pb is None:
            out.append(None)
            continue
        t = (n - a) / (b - a)
        out.append((round(pa[0] + (pb[0] - pa[0]) * t), round(pa[1] + (pb[1] - pa[1]) * t),
                    round(pa[2] + (pb[2] - pa[2]) * t), round(pa[3] + (pb[3] - pa[3]) * t)))
    return out


def decode(video: Path, frames: list[int]) -> np.ndarray:
    select = "+".join(f"eq(n\\,{n})" for n in frames)
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video), "-an", "-vf",
         f"select={select},scale={IMAGE_SIZE}:{IMAGE_SIZE}:flags=bicubic",
         "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True,
    )
    raw = np.frombuffer(proc.stdout, np.uint8)
    if raw.size != len(frames) * IMAGE_SIZE * IMAGE_SIZE * 3:
        raise ValueError(f"{video}: decoded {raw.size // (IMAGE_SIZE * IMAGE_SIZE * 3)} of {len(frames)} frames")
    return raw.reshape(len(frames), IMAGE_SIZE, IMAGE_SIZE, 3)


def _bbox(mask: torch.Tensor) -> Box4 | None:
    import torch

    ys, xs = torch.nonzero(mask[0] > 0, as_tuple=True)
    if ys.numel() == 0:
        return None
    x1, y1, x2, y2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    return (x1, y1, x2 - x1 + 1, y2 - y1 + 1)


class Tracker:
    """EdgeTAM on MPS (CPU when absent), tracking every STRIDE-th frame with memory attention in fp16."""

    def __init__(self, models_dir: Path) -> None:
        self._models_dir = models_dir
        self._predictor = None

    def _load(self):
        if self._predictor is not None:
            return self._predictor
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        import torch
        from hydra import initialize_config_dir
        from hydra.core.global_hydra import GlobalHydra
        from sam2.build_sam import build_sam2_video_predictor

        weights = ensure_weights(self._models_dir)
        device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
        GlobalHydra.instance().clear()
        with initialize_config_dir(config_dir=str(CONFIG_DIR), version_base="1.2"):
            predictor = build_sam2_video_predictor(
                CONFIG, str(weights), device=device,
                hydra_overrides_extra=["++model.add_all_frames_to_correct_as_cond=true"],
            )
        if device.type == "mps":
            attn = predictor.memory_attention
            attn.forward = torch.autocast("mps", dtype=torch.float16)(attn.forward)
        self._predictor = predictor
        return predictor

    def track(
        self, clip: Clip, seg: Segment, *, on_frame: Callable[[int, int], None], cancelled: Callable[[], bool]
    ) -> Tracked:
        import sam2.sam2_video_predictor as svp
        import torch

        predictor = self._load()
        frames = grid(seg)
        rgb = torch.from_numpy(decode(clip.video, frames)).permute(0, 3, 1, 2)
        mean, std = torch.tensor(IMG_MEAN)[:, None, None], torch.tensor(IMG_STD)[:, None, None]
        images = ((rgb.float() / 255.0 - mean) / std).half()
        del rgb

        original = svp.load_video_frames
        svp.load_video_frames = lambda **_: (images, clip.height, clip.width)
        try:
            state = predictor.init_state(video_path="<in-memory>", offload_video_to_cpu=True)
        finally:
            svp.load_video_frames = original
        try:
            boxes: dict[int, Box4 | None] = {}
            for c in seg.clicks:
                predictor.add_new_points_or_box(
                    state, frame_idx=frames.index(c.frame), obj_id=1,
                    points=np.array([c.point], np.float32), labels=np.array([1], np.int32),
                )
            reverse = seg.kind == "lead"
            start = frames.index(seg.clicks[-1].frame if reverse else seg.clicks[0].frame)
            for rel, _, masks in predictor.propagate_in_video(
                state, start_frame_idx=start, max_frame_num_to_track=len(frames) - 1, reverse=reverse
            ):
                boxes[frames[rel]] = _bbox(masks[0])
                on_frame(len(boxes), len(frames))
                if cancelled():
                    raise Cancelled(seg.key)
        finally:
            del state
            if torch.backends.mps.is_available():
                torch.mps.empty_cache()
        return Tracked(seg.start, tuple(fill(boxes, frames[0], frames[-1])[: seg.stop - seg.start]))
