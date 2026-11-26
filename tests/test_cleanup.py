"""Tests for YYYY-MM-DD date parsing and range cleanup logic."""

import datetime
from pathlib import Path
import sys
import tempfile
import unittest

_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from ce_content_calc.cleanup import delete_reports_in_range, parse_cli_date


class CleanupTests(unittest.TestCase):
    def test_parse_cli_date_strips_quotes_and_rejects_invalid(self) -> None:
        self.assertEqual(parse_cli_date("'2026-11-15'", "--start"), datetime.date(2026, 11, 15))
        self.assertEqual(parse_cli_date('"2026-11-18"', "--end"), datetime.date(2026, 11, 18))

        with self.assertRaises(ValueError):
            parse_cli_date("20261115", "--start")
        with self.assertRaises(ValueError):
            parse_cli_date("2026-02-30", "--end")

    def test_delete_reports_in_range_dry_run_and_delete(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            reports_dir = Path(tmpdir)
            daily_dir = reports_dir / "Daily"
            for date_name in ("2026-11-14", "2026-11-15", "2026-11-17", "2026-11-18"):
                file_path = daily_dir / date_name / "MY.TTK.1" / "1_LIVE_Linked.xlsx"
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_bytes(b"test-bytes")

            # Monthly folder should never be touched
            monthly_file = reports_dir / "Monthly" / "2026-11" / "MY.TTK.1" / "1_LIVE_Linked.xlsx"
            monthly_file.parent.mkdir(parents=True, exist_ok=True)
            monthly_file.write_bytes(b"monthly")

            start = datetime.date(2026, 11, 15)
            end = datetime.date(2026, 11, 17)

            # Dry run leaves everything untouched
            count, files, size = delete_reports_in_range(reports_dir, start, end, dry_run=True)
            self.assertEqual((count, files, size), (2, 2, 20))
            self.assertTrue((daily_dir / "2026-11-15").exists())
            self.assertTrue((daily_dir / "2026-11-17").exists())

            # Real delete removes only [start, end] under Daily/
            count2, files2, size2 = delete_reports_in_range(reports_dir, start, end, dry_run=False)
            self.assertEqual((count2, files2, size2), (2, 2, 20))
            self.assertFalse((daily_dir / "2026-11-15").exists())
            self.assertFalse((daily_dir / "2026-11-17").exists())
            self.assertTrue((daily_dir / "2026-11-14").exists())
            self.assertTrue((daily_dir / "2026-11-18").exists())
            self.assertTrue(monthly_file.exists())

    def test_rejects_inverted_date_range(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with self.assertRaises(ValueError):
                delete_reports_in_range(
                    Path(tmpdir),
                    datetime.date(2026, 11, 18),
                    datetime.date(2026, 11, 15),
                )
