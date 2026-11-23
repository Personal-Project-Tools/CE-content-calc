"""Module entrypoint supporting `python -m ce_content_calc`."""

from __future__ import annotations

import sys

from ce_content_calc.cli import main


if __name__ == "__main__":
    sys.exit(main())
