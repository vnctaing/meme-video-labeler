from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from labelmeme.track import Tracks

TrackId = str

LINK_MAX_GAP = 12
# ByteTrack id switches overlap by a frame or two: tos-lab s1-2 ends at 143 and s1-6 starts at 142.
LINK_MAX_OVERLAP = 4
LINK_MAX_JUMP = 0.5


@dataclass(frozen=True, slots=True)
class TrackCard:
    id: TrackId
    shot: int
    first: int
    last: int
    detections: int


@dataclass(frozen=True, slots=True)
class Person:
    name: str
    tracks: tuple[TrackId, ...]


@dataclass(frozen=True, slots=True)
class Draft:
    tracks_id: str
    people: tuple[Person, ...]


@dataclass(frozen=True, slots=True)
class Issue:
    person: int
    blocking: bool
    message: str


def _shot(track_id: TrackId) -> int:
    return int(track_id[1:].split("-")[0])


def cards(tracks: Tracks) -> list[TrackCard]:
    out = [TrackCard(tid, _shot(tid), dets[0]["frame"], dets[-1]["frame"], len(dets)) for tid, dets in tracks.items()]
    return sorted(out, key=lambda c: (c.shot, c.first, c.id))


def _centre(box: list[int]) -> tuple[float, float]:
    x, y, w, h = box
    return x + w / 2, y + h / 2


def _overlap(a: TrackCard, b: TrackCard) -> int:
    return min(a.last, b.last) - max(a.first, b.first) + 1


def _links(a: TrackCard, b: TrackCard, tracks: Tracks) -> bool:
    if a.shot != b.shot or not -LINK_MAX_OVERLAP <= b.first - a.last <= LINK_MAX_GAP:
        return False
    tail, head = tracks[a.id][-1]["box"], tracks[b.id][0]["box"]
    (ax, ay), (bx, by) = _centre(tail), _centre(head)
    return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 <= LINK_MAX_JUMP * tail[3]


def suggest(tracks: Tracks, tracks_id: str) -> Draft:
    chains: list[list[TrackCard]] = []
    for card in sorted(cards(tracks), key=lambda c: (c.first, c.id)):
        fits = [
            chain for chain in chains
            if _links(chain[-1], card, tracks) and all(_overlap(m, card) <= LINK_MAX_OVERLAP for m in chain)
        ]
        if fits:
            min(fits, key=lambda chain: abs(card.first - chain[-1].last)).append(card)
        else:
            chains.append([card])
    return Draft(tracks_id, tuple(Person("", tuple(c.id for c in chain)) for chain in chains))


def parse_draft(raw: object, known: set[TrackId], tracks_id: str) -> Draft:
    if not isinstance(raw, dict) or not isinstance(raw.get("subjects"), list):
        raise ValueError('subjects.json: expected {"subjects": [...]}')
    if raw.get("tracksId") != tracks_id:
        raise ValueError(f'subjects.json: written for tracksId {raw.get("tracksId")!r}, but the current tracks have {tracks_id!r}')
    people: list[Person] = []
    claimed: set[TrackId] = set()
    for i, s in enumerate(raw["subjects"]):
        path = f"subjects.json $.subjects[{i}]"
        if not isinstance(s, dict) or not isinstance(s.get("name"), str):
            raise ValueError(f"{path}: expected an object with a string name")
        ids = s.get("tracks")
        if not isinstance(ids, list) or not ids:
            raise ValueError(f"{path}.tracks: expected a non-empty list of track ids")
        for tid in ids:
            if tid not in known:
                raise ValueError(f"{path}.tracks: unknown track id {tid!r}")
            if tid in claimed:
                raise ValueError(f"{path}.tracks: {tid!r} is already claimed by another person")
            claimed.add(tid)
        people.append(Person(s["name"].strip(), tuple(ids)))
    return Draft(tracks_id, tuple(people))


def slug_for(index: int, name: str, taken: set[str]) -> str:
    if not name:
        return ""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    base = "-".join(re.findall(r"[a-z0-9]+", ascii_name)) or f"person-{index + 1}"
    slug, n = base, 2
    while slug in taken:
        slug, n = f"{base}-{n}", n + 1
    return slug


def to_subjects_json(draft: Draft) -> dict:
    taken: set[str] = set()
    subjects = []
    for i, p in enumerate(draft.people):
        sid = slug_for(i, p.name, taken)
        taken.add(sid)
        subjects.append({"id": sid, "name": p.name, "tracks": list(p.tracks)})
    return {"tracksId": draft.tracks_id, "subjects": subjects}


def issues(draft: Draft, tracks: Tracks) -> list[Issue]:
    if not draft.people:
        return [Issue(-1, True, "Every track is ignored. Move at least one track to a person.")]
    by_id = {c.id: c for c in cards(tracks)}
    out: list[Issue] = []
    seen: set[str] = set()
    for i, p in enumerate(draft.people):
        if not p.name:
            out.append(Issue(i, True, f"Person {i + 1} needs a name."))
        elif p.name.casefold() in seen:
            out.append(Issue(i, True, f'Two people are named "{p.name}".'))
        seen.add(p.name.casefold())
        members = [by_id[t] for t in p.tracks]
        for j, a in enumerate(members):
            for b in members[j + 1:]:
                if a.shot == b.shot and _overlap(a, b) > LINK_MAX_OVERLAP:
                    lo, hi = max(a.first, b.first), min(a.last, b.last)
                    out.append(Issue(i, False, f"{a.id} and {b.id} are on screen together in shot {a.shot}, frames {lo} to {hi}; build keeps the larger box."))
    return out
