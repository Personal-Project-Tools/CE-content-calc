"""CLI entrypoint wrapper for deleting report folders by YYYY-MM-DD range."""

from __future__ import annotations

from pathlib import Path
import sys


_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from ce_content_calc.cli import main_delete  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main_delete())
