"""Command-line entrypoints for report metrics calculation and date cleanup."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
from typing import Sequence

from ce_content_calc.calculator import collect_metrics_by_date
from ce_content_calc.cleanup import delete_reports_in_range, parse_cli_date
from ce_content_calc.config import (
    DEFAULT_OUTPUT_FILE,
    DEFAULT_REPORTS_DIR,
    DEFAULT_SELLER_LIST_FILE,
)
from ce_content_calc.seller_mapping import load_seller_mapping
from ce_content_calc.xlsx_io import write_results_xlsx


def _build_calculate_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Aggregate TikTok Shop LIVE & Video metrics per Client, Seller ID, and date."
    )
    parser.add_argument(
        "--reports-dir",
        type=Path,
        default=DEFAULT_REPORTS_DIR,
        help="Input reports directory containing {date}/{seller_id}/ folders.",
    )
    parser.add_argument(
        "--seller-list",
        type=Path,
        default=DEFAULT_SELLER_LIST_FILE,
        help="Path to seller_list.xlsx mapping Clients and full Seller IDs.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_FILE,
        help="Output .xlsx file path.",
    )
    return parser


def _build_delete_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Delete downloaded TikTok report folders inside data/reports/ for a YYYY-MM-DD date range."
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
        help="Target reports directory containing YYYY-MM-DD folders.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview matching folders without deleting anything.",
    )
    return parser


def main_calculate(argv: Sequence[str] | None = None) -> int:
    """Execute the report aggregation CLI."""
    args = _build_calculate_parser().parse_args(argv)
    seller_mapping = load_seller_mapping(args.seller_list)
    results_by_date = collect_metrics_by_date(args.reports_dir, seller_mapping)

    if not results_by_date:
        print(f"No valid report files found under: {args.reports_dir}")
        return 0

    write_results_xlsx(args.output, results_by_date)

    for date_str, rows in results_by_date.items():
        print(f"\n=== Sheet: {date_str} ===")
        for row in rows:
            print(
                f"  {str(row['client']):<16} | {row['seller_id']} | {str(row['content_type']):<22} | "
                f"revenue={row['revenue']:>10.2f} | "
                f"product_impression={row['product_impression']:>10,} | "
                f"impression={row['impression']:>10,}"
            )
    print(f"\nExported workbook: {args.output}")
    return 0


def main_delete(argv: Sequence[str] | None = None) -> int:
    """Execute the date-range deletion CLI."""
    args = _build_delete_parser().parse_args(argv)
    try:
        start_date = parse_cli_date(args.start, "--start")
        end_date = parse_cli_date(args.end, "--end")
        if start_date > end_date:
            raise ValueError(f"--start ({start_date}) cannot be after --end ({end_date}).")
    except ValueError as err:
        print(f"Error: {err}", file=sys.stderr)
        return 2

    delete_reports_in_range(args.reports_dir, start_date, end_date, dry_run=args.dry_run)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Unified CLI dispatcher: python -m ce_content_calc <calculate|delete> [args]."""
    args_list = list(sys.argv[1:] if argv is None else argv)
    if not args_list or args_list[0] in ("-h", "--help"):
        print("Usage: python -m ce_content_calc <calculate|delete> [options]")
        print("\nSubcommands:")
        print("  calculate   Aggregate metrics from data/reports/ into data/results/")
        print("  delete      Delete YYYY-MM-DD folders inside data/reports/ in a date range")
        return 0

    cmd, rest = args_list[0], args_list[1:]
    if cmd == "calculate":
        return main_calculate(rest)
    if cmd == "delete":
        return main_delete(rest)

    print(f"Error: Unknown subcommand '{cmd}'. Use 'calculate' or 'delete'.", file=sys.stderr)
    return 2
