from __future__ import annotations

import argparse
from pathlib import Path

from labelmeme.fixture import make_fixture

TEMPLATES_DIR = Path(__file__).resolve().parents[2] / "web" / "public" / "templates"


def main() -> None:
    parser = argparse.ArgumentParser(prog="labelmeme")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("fixture", help="generate web/public/templates/fixture/")
    args = parser.parse_args()
    match args.command:
        case "fixture":
            print(make_fixture(TEMPLATES_DIR))


if __name__ == "__main__":
    main()
