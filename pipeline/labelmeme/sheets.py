from __future__ import annotations

from collections.abc import Iterable, Sequence
from pathlib import Path

import cv2
import numpy as np

CAPTION_H = 22
BACKGROUND = (32, 32, 32)


def read_frames(video: Path, wanted: Iterable[int]) -> dict[int, np.ndarray]:
    wanted = set(wanted)
    frames: dict[int, np.ndarray] = {}
    cap = cv2.VideoCapture(str(video))
    try:
        index = 0
        while len(frames) < len(wanted):
            ok, frame = cap.read()
            if not ok:
                break
            if index in wanted:
                frames[index] = frame
            index += 1
    finally:
        cap.release()
    missing = wanted - frames.keys()
    if missing:
        raise ValueError(f"{video}: frames {sorted(missing)[:5]} not found")
    return frames


def tile(image: np.ndarray, caption: str, cell_w: int, cell_h: int) -> np.ndarray:
    out = np.full((cell_h + CAPTION_H, cell_w, 3), BACKGROUND, dtype=np.uint8)
    ih, iw = image.shape[:2]
    scale = min(cell_w / iw, cell_h / ih)
    w, h = max(1, round(iw * scale)), max(1, round(ih * scale))
    x, y = (cell_w - w) // 2, (cell_h - h) // 2
    out[y : y + h, x : x + w] = cv2.resize(image, (w, h), interpolation=cv2.INTER_AREA)
    cv2.putText(out, caption, (4, cell_h + 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def grid(tiles: Sequence[np.ndarray], cols: int) -> np.ndarray:
    th, tw = tiles[0].shape[:2]
    rows = -(-len(tiles) // cols)
    out = np.full((rows * th, min(cols, len(tiles)) * tw, 3), BACKGROUND, dtype=np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        out[r * th : (r + 1) * th, c * tw : (c + 1) * tw] = t
    return out


def write_jpg(path: Path, image: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), image, [cv2.IMWRITE_JPEG_QUALITY, 88]):
        raise OSError(f"could not write {path}")
