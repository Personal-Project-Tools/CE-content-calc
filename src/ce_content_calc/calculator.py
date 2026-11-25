"""TikTok Shop Content Live & Video metric extraction and aggregation."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
import re

from ce_content_calc.config import CONTENT_TYPES, METRIC_RULES
from ce_content_calc.seller_mapping import resolve_seller_matches
from ce_content_calc.xlsx_io import read_xlsx_rows


_TRAILING_UNIT_RE = re.compile(r"\s*\([^)]*\)\s*$")
_NON_NUMERIC_RE = re.compile(r"[^0-9.\-]")


def _normalize_header(raw: str) -> str:
    """Normalize column title by stripping currency suffix like (RM) or (₱) and lowercasing."""
    stripped = _TRAILING_UNIT_RE.sub("", str(raw or "")).strip()
    return " ".join(stripped.split()).lower()


def resolve_column_index(
    headers: list[str], target_names: tuple[str, ...], fallback_index: int
) -> int:
    """Resolve column index by exact normalized header, prefix match, or numeric fallback."""
    targets = [_normalize_header(name) for name in target_names]

    for idx, hdr in enumerate(headers):
        norm = _normalize_header(hdr)
        if norm and norm in targets:
            return idx

    for idx, hdr in enumerate(headers):
        norm = _normalize_header(hdr)
        if norm and any(len(t) >= 5 and norm.startswith(t) for t in targets):
            return idx

    return fallback_index


def parse_numeric(raw: str) -> float:
    """Parse cell text into a float, defaulting to 0.0 for empty or non-numeric cells."""
    text = str(raw or "").strip()
    if not text:
        return 0.0
    cleaned = _NON_NUMERIC_RE.sub("", text)
    if not cleaned or cleaned in ("-", "."):
        return 0.0
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def compute_file_metrics(rows: list[list[str]], content_key: str) -> dict[str, float]:
    """Compute revenue, product_impression, and impression totals for one report sheet."""
    rules = METRIC_RULES[content_key]
    header_idx = next(
        (i for i, row in enumerate(rows) if sum(1 for cell in row if str(cell).strip()) >= 5),
        -1,
    )
    if header_idx < 0:
        return {"revenue": 0.0, "product_impression": 0.0, "impression": 0.0}

    headers = rows[header_idx]
    rev_idx = resolve_column_index(
        headers, rules["revenue"]["headers"], rules["revenue"]["fallback_index"]
    )
    pi_idx = resolve_column_index(
        headers,
        rules["product_impression"]["headers"],
        rules["product_impression"]["fallback_index"],
    )
    imp_idx = resolve_column_index(
        headers, rules["impression"]["headers"], rules["impression"]["fallback_index"]
    )

    rev_sum = 0.0
    pi_sum = 0.0
    imp_sum = 0.0

    for row in rows[header_idx + 1 :]:
        if not row or not any(str(cell).strip() for cell in row):
            continue
        if rev_idx < len(row):
            rev_sum += parse_numeric(row[rev_idx])
        if pi_idx < len(row):
            pi_sum += parse_numeric(row[pi_idx])
        if imp_idx < len(row):
            imp_sum += parse_numeric(row[imp_idx])

    return {
        "revenue": rev_sum,
        "product_impression": pi_sum,
        "impression": imp_sum,
    }


def classify_report_filename(file_name: str) -> str | None:
    """Map report filename prefix/keywords to 'live' or 'video', ignoring non-report files."""
    lower = file_name.lower()
    if lower.startswith("~$") or lower.startswith("summary") or not lower.endswith(".xlsx"):
        return None
    if lower.startswith("1_") or lower.startswith("2_") or "live" in lower:
        return "live"
    if lower.startswith("3_") or lower.startswith("4_") or "video" in lower:
        return "video"
    return None


def parse_folder_name(folder_name: str) -> tuple[str, str]:
    """Split legacy '{seller_id}_{date}' folder name into (seller_id, date_str)."""
    if "_" not in folder_name:
        return folder_name, "unknown"
    seller_id, date_str = folder_name.rsplit("_", 1)
    return seller_id, date_str


def _accumulate_seller_folder(
    date_str: str,
    raw_seller_id: str,
    xlsx_files: list[Path],
    seller_mapping: dict[str, list[tuple[str, str]]],
    grouped: dict[str, dict[tuple[str, str], dict[str, dict[str, float]]]],
) -> None:
    """Compute metrics across all report files in one Seller ID folder and add to grouped totals."""
    if not xlsx_files:
        return

    folder_totals = {
        "live": {"revenue": 0.0, "product_impression": 0.0, "impression": 0.0},
        "video": {"revenue": 0.0, "product_impression": 0.0, "impression": 0.0},
    }

    for file_path in xlsx_files:
        content_key = classify_report_filename(file_path.name)
        if content_key is None:
            continue
        rows = read_xlsx_rows(file_path)
        metrics = compute_file_metrics(rows, content_key)
        folder_totals[content_key]["revenue"] += metrics["revenue"]
        folder_totals[content_key]["product_impression"] += metrics["product_impression"]
        folder_totals[content_key]["impression"] += metrics["impression"]

    for client_name, full_seller_id in resolve_seller_matches(raw_seller_id, seller_mapping):
        seller_key = (client_name, full_seller_id)
        seller_acc = grouped[date_str].setdefault(
            seller_key,
            {
                "live": {"revenue": 0.0, "product_impression": 0.0, "impression": 0.0},
                "video": {"revenue": 0.0, "product_impression": 0.0, "impression": 0.0},
            },
        )
        for content_key in ("live", "video"):
            seller_acc[content_key]["revenue"] += folder_totals[content_key]["revenue"]
            seller_acc[content_key]["product_impression"] += folder_totals[content_key][
                "product_impression"
            ]
            seller_acc[content_key]["impression"] += folder_totals[content_key]["impression"]


def collect_metrics_by_date(
    reports_dir: Path,
    seller_mapping: dict[str, list[tuple[str, str]]] | None = None,
) -> dict[str, list[dict[str, object]]]:
    """Scan data/raw_file/{date}/{seller_id}/*.xlsx (and legacy flat folders) grouped by date."""
    if not reports_dir.exists():
        raise FileNotFoundError(f"Reports directory does not exist: {reports_dir}")

    mapping = seller_mapping if seller_mapping is not None else {}
    grouped: dict[str, dict[tuple[str, str], dict[str, dict[str, float]]]] = defaultdict(dict)

    for entry in sorted(reports_dir.iterdir()):
        if not entry.is_dir():
            continue

        # 3-level structure: data/raw_file/{date}/{seller_id}/*.xlsx
        for seller_dir in sorted(sub for sub in entry.iterdir() if sub.is_dir()):
            sub_xlsx = sorted(
                f
                for f in seller_dir.iterdir()
                if f.is_file() and classify_report_filename(f.name) is not None
            )
            _accumulate_seller_folder(entry.name, seller_dir.name, sub_xlsx, mapping, grouped)

        # Backward compatibility: legacy 2-level {seller_id}_{date}/*.xlsx
        direct_xlsx = sorted(
            f for f in entry.iterdir() if f.is_file() and classify_report_filename(f.name) is not None
        )
        if direct_xlsx:
            raw_seller_id, date_str = parse_folder_name(entry.name)
            _accumulate_seller_folder(date_str, raw_seller_id, direct_xlsx, mapping, grouped)

    results_by_date: dict[str, list[dict[str, object]]] = {}
    for date_str in sorted(grouped.keys()):
        date_rows: list[dict[str, object]] = []
        sorted_sellers = sorted(
            grouped[date_str].keys(), key=lambda pair: (pair[0].lower(), pair[1].lower())
        )
        for client_name, full_seller_id in sorted_sellers:
            acc = grouped[date_str][(client_name, full_seller_id)]
            for content_key in ("live", "video"):
                totals = acc[content_key]
                date_rows.append(
                    {
                        "client": client_name,
                        "seller_id": full_seller_id,
                        "date": date_str,
                        "content_type": CONTENT_TYPES[content_key],
                        "revenue": round(totals["revenue"], 2),
                        "product_impression": int(round(totals["product_impression"])),
                        "impression": int(round(totals["impression"])),
                    }
                )
        results_by_date[date_str] = date_rows

    return results_by_date
