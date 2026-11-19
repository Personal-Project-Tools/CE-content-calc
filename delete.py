"""Delete date folders inside Reports/ within an inclusive YYYY-MM-DD range.

Usage:
    .venv\\Scripts\\python.exe delete.py --start '2026-11-15' --end '2026-11-18'
    .venv\\Scripts\\python.exe delete.py --start '2026-11-15' --end '2026-11-18' --dry-run
"""

from __future__ import annotations

import argparse
import datetime
from pathlib import Path
import re
import shutil
import sys


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_REPORTS_DIR = BASE_DIR / "Reports"
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_cli_date(raw_value: str, flag_name: str) -> datetime.date:
    """Strip surrounding quotes and parse a strict YYYY-MM-DD date string."""
    cleaned = str(raw_value or "").strip().strip("'\"")
    if not _ISO_DATE_RE.fullmatch(cleaned):
        raise ValueError(f"Invalid {flag_name} '{raw_value}': expected YYYY-MM-DD format.")
    try:
        return datetime.date.fromisoformat(cleaned)
    except ValueError as exc:
        raise ValueError(f"Invalid {flag_name} '{cleaned}': {exc}") from exc


def measure_directory(dir_path: Path) -> tuple[int, int]:
    """Return (file_count, total_bytes) recursively under dir_path."""
    file_count = 0
    total_bytes = 0
    for item in dir_path.rglob("*"):
        if item.is_file():
            file_count += 1
            total_bytes += item.stat().st_size
    return file_count, total_bytes


def format_size(num_bytes: int) -> str:
    """Format byte size into a human-readable string."""
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.2f} KB"
    return f"{num_bytes / (1024 * 1024):.2f} MB"


def delete_reports_in_range(
    reports_dir: Path,
    start_date: datetime.date,
    end_date: datetime.date,
    dry_run: bool = False,
) -> tuple[int, int, int]:
    """Delete YYYY-MM-DD date directories in [start_date, end_date].

    Returns (deleted_folders, total_files_removed, total_bytes_freed).
    """
    if not reports_dir.exists():
        print(f"Reports directory not found: {reports_dir}")
        return 0, 0, 0

    matched_folders: list[tuple[datetime.date, Path]] = []
    for entry in sorted(reports_dir.iterdir()):
        if not entry.is_dir() or not _ISO_DATE_RE.fullmatch(entry.name):
            continue
        try:
            folder_date = datetime.date.fromisoformat(entry.name)
        except ValueError:
            continue
        if start_date <= folder_date <= end_date:
            matched_folders.append((folder_date, entry))

    if not matched_folders:
        print(f"No date folders found between {start_date} and {end_date} in {reports_dir}")
        return 0, 0, 0

    deleted_folders = 0
    total_files = 0
    total_bytes = 0

    for _, folder_path in matched_folders:
        file_count, byte_count = measure_directory(folder_path)
        if dry_run:
            print(
                f"[DRY RUN] Would delete: {folder_path} ({file_count} files, {format_size(byte_count)})"
            )
        else:
            shutil.rmtree(folder_path)
            print(
                f"[DELETED] {folder_path} ({file_count} files, {format_size(byte_count)})"
            )
        deleted_folders += 1
        total_files += file_count
        total_bytes += byte_count

    action_label = "Matched" if dry_run else "Deleted"
    print(
        f"\n{action_label} {deleted_folders} date folder(s), "
        f"{total_files} file(s), {format_size(total_bytes)} freed."
    )
    return deleted_folders, total_files, total_bytes


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Delete downloaded TikTok report folders inside Reports/ for a YYYY-MM-DD date range."
    )
    parser.add_argument(
        "--start",
        required=True,
        help="Start date (inclusive) in YYYY-MM-DD format.",
    )
    parser.add_argument(
        "--end",
        required=True,
        help="End date (inclusive) in YYYY-MM-DD format.",
    )
    parser.add_argument(
        "--reports-dir",
        type=Path,
        default=DEFAULT_REPORTS_DIR,
        help="Target Reports directory containing YYYY-MM-DD folders.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview matching folders without deleting anything.",
    )
    args = parser.parse_args()

    try:
        start_date = parse_cli_date(args.start, "--start")
        end_date = parse_cli_date(args.end, "--end")
    except ValueError as err:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(2)

    if start_date > end_date:
        print(
            f"Error: --start ({start_date}) cannot be after --end ({end_date}).",
            file=sys.stderr,
        )
        sys.exit(2)

    delete_reports_in_range(args.reports_dir, start_date, end_date, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
