from __future__ import annotations

import argparse
import shlex
import sys
from pathlib import Path

from labelmeme.fixture import make_fixture
from labelmeme.prep import PrepSpec, prep
from labelmeme.schema import SLUG

PIPELINE_DIR = Path(__file__).resolve().parents[1]
WORK_DIR = PIPELINE_DIR / "work"
TEMPLATES_DIR = PIPELINE_DIR.parent / "web" / "public" / "templates"


def _slug(value: str) -> str:
    if SLUG.fullmatch(value) is None:
        raise argparse.ArgumentTypeError(f"expected a slug [a-z0-9-]+, got {value!r}")
    return value


def _existing_file(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise argparse.ArgumentTypeError(f"no such file: {value}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(prog="labelmeme")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("fixture", help="generate web/public/templates/fixture/")

    p = commands.add_parser("prep", help="trim and re-encode a source clip into work/<id>/")
    p.add_argument("source", type=_existing_file)
    p.add_argument("--start", type=float, required=True, help="seconds into the source")
    p.add_argument("--duration", type=float, required=True, help="seconds")
    p.add_argument("--id", type=_slug, required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--credit", required=True)
    p.add_argument("--source-url", required=True, help="where the source file came from, for SOURCE.md")
    p.add_argument("--license", required=True, help="license of the source, for SOURCE.md")
    p.add_argument("--fps", type=int, default=24)

    s = commands.add_parser("serve", help="run the authoring API that `npm run dev:author` starts")
    s.add_argument("--port", type=int, default=8787)
    s.add_argument("--web-port", type=int, default=5174, help="the Vite port whose pages may call the API")

    args = parser.parse_args()
    match args.command:
        case "fixture":
            print(make_fixture(TEMPLATES_DIR))
        case "prep":
            spec = PrepSpec(
                source=args.source, start=args.start, duration=args.duration, id=args.id, title=args.title,
                credit=args.credit, source_url=args.source_url, license=args.license, fps=args.fps,
            )
            command = shlex.join(["uv", "run", "python", "-m", "labelmeme", *sys.argv[1:]])
            print(prep(spec, WORK_DIR / spec.id, command))
        case "serve":
            from labelmeme.server import serve
            from labelmeme.worker import Paths

            serve(Paths(WORK_DIR, TEMPLATES_DIR), args.port, args.web_port)


if __name__ == "__main__":
    main()
