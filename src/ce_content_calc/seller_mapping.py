"""Client <-> Seller ID mapping loader (Google Sheets via Service Account & local .xlsx fallback)."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
import re
from typing import Callable

from ce_content_calc.config import DEFAULT_SERVICE_ACCOUNT_FILE, PROJECT_ROOT
from ce_content_calc.xlsx_io import read_xlsx_rows


_SELLER_CODE_RE = re.compile(r"([A-Za-z]{2}\.[A-Za-z]{3}\.\d+)", re.IGNORECASE)
_SHORTHAND_RANGE_RE = re.compile(
    r"column\[\s*([A-Za-z]+)\s*\]\s*-\s*row\[\s*(\d+)\s*\]", re.IGNORECASE
)
READONLY_SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

SellerMapping = dict[str, list[tuple[str, str]]]
RangeBatchFetcher = Callable[[Path, str, str, list[str]], list[list[list[str]]]]


@dataclass(frozen=True)
class SheetMappingConfig:
    """Validated Google Sheets configuration for Seller ID lookup."""

    credentials_file: Path
    spreadsheet_id: str
    worksheet: str
    seller_full_match_range: str
    seller_used_id_range: str
    active_status_range: str | None = None
    client_range: str | None = None
    platform_filter: str = "TTK"
    active_only: bool = True


def normalize_a1_range(raw_range: str) -> str:
    """Normalize A1 range notation (also accepts legacy 'column[AW] - row[4]' syntax)."""
    cleaned = str(raw_range or "").split("#", 1)[0].strip()
    if not cleaned:
        raise ValueError("Sheet range cannot be empty.")

    shorthand = _SHORTHAND_RANGE_RE.search(cleaned)
    if shorthand:
        col = shorthand.group(1).upper()
        row = shorthand.group(2)
        return f"{col}{row}:{col}"

    return cleaned


def _resolve_project_path(raw_path: str | Path) -> Path:
    path = Path(raw_path)
    if path.is_absolute():
        return path
    return PROJECT_ROOT / path


def _parse_bool_flag(raw_value: object, default: bool = True) -> bool:
    if raw_value is None:
        return default
    if isinstance(raw_value, bool):
        return raw_value
    return str(raw_value).strip().lower() in ("true", "1", "yes")


def load_sheet_config(
    sheet_config_path: Path, credentials_override: Path | None = None
) -> SheetMappingConfig:
    """Parse and validate `config/sheet.yaml`."""
    if not sheet_config_path.exists():
        raise FileNotFoundError(
            f"Google Sheets config not found: {sheet_config_path}. "
            "Copy `config/sheet.example.yaml` to `config/sheet.yaml` and fill in your Spreadsheet ID."
        )

    import yaml

    raw_doc = yaml.safe_load(sheet_config_path.read_text(encoding="utf-8")) or {}
    if not isinstance(raw_doc, dict):
        raise ValueError(f"Invalid YAML root in {sheet_config_path}; expected a mapping.")

    section = raw_doc.get("sheet") or raw_doc.get("google_sheets") or raw_doc
    if not isinstance(section, dict):
        raise ValueError(f"Invalid 'sheet' section in {sheet_config_path}.")

    spreadsheet_id = str(
        section.get("spreadsheet_id") or section.get("root_spreadsheet") or ""
    ).strip()
    if not spreadsheet_id or spreadsheet_id.startswith("<"):
        raise ValueError(f"Missing valid 'spreadsheet_id' in {sheet_config_path}.")

    worksheet = str(section.get("worksheet") or section.get("tab_sheet") or "").strip()
    if not worksheet:
        raise ValueError(f"Missing 'worksheet' name in {sheet_config_path}.")

    ranges = section.get("ranges") if isinstance(section.get("ranges"), dict) else {}
    filters = section.get("filters") if isinstance(section.get("filters"), dict) else {}

    raw_full_range = ranges.get("seller_full_match") or section.get("seller_full_match")
    raw_id_range = ranges.get("seller_used_id") or section.get("seller_id_range")
    raw_status_range = (
        ranges.get("active_status")
        or ranges.get("status")
        or section.get("active_status_range")
        or section.get("status_range")
    )
    raw_client_range = ranges.get("client") or section.get("client_range")

    if not raw_full_range or not raw_id_range:
        raise ValueError(
            f"Missing 'ranges.seller_full_match' or 'ranges.seller_used_id' in {sheet_config_path}."
        )

    if credentials_override is not None:
        creds_path = credentials_override
    elif section.get("credentials_file"):
        creds_path = _resolve_project_path(str(section["credentials_file"]))
    elif raw_doc.get("service_account_file"):
        creds_path = _resolve_project_path(str(raw_doc["service_account_file"]))
    else:
        creds_path = DEFAULT_SERVICE_ACCOUNT_FILE

    raw_platform = filters.get("platform")
    if raw_platform is None:
        raw_platform = section.get("platform_filter", "TTK")
    platform_filter = str(raw_platform or "").strip().upper()

    raw_active_only = (
        filters.get("active_only")
        if "active_only" in filters
        else section.get("active_only")
    )
    active_only = _parse_bool_flag(raw_active_only, default=bool(raw_status_range))

    return SheetMappingConfig(
        credentials_file=creds_path,
        spreadsheet_id=spreadsheet_id,
        worksheet=worksheet,
        seller_full_match_range=normalize_a1_range(str(raw_full_range)),
        seller_used_id_range=normalize_a1_range(str(raw_id_range)),
        active_status_range=(
            normalize_a1_range(str(raw_status_range)) if raw_status_range else None
        ),
        client_range=normalize_a1_range(str(raw_client_range)) if raw_client_range else None,
        platform_filter=platform_filter,
        active_only=active_only,
    )


def _extract_client_from_full_seller_id(full_seller_id: str) -> str:
    """Extract `<company>` prefix from `<company> - <COUNTRY>.TTK.<SELLER_ID>`."""
    if " - " in full_seller_id:
        prefix = full_seller_id.split(" - ", 1)[0].strip()
        if prefix:
            return prefix
    return "Unmapped"


def _is_active_status(raw_status: str) -> bool:
    """Check if Google Sheet status cell evaluates to TRUE."""
    return str(raw_status or "").strip().upper() == "TRUE"


def _register_mapping_entry(
    mapping: dict[str, list[tuple[str, str]]],
    client_name: str,
    full_seller_id: str,
    seller_used_id: str = "",
) -> None:
    full_cleaned = str(full_seller_id or "").strip()
    id_cleaned = str(seller_used_id or "").strip()
    effective_full = full_cleaned or id_cleaned
    if not effective_full:
        return

    client_label = str(client_name or "").strip() or _extract_client_from_full_seller_id(
        effective_full
    )
    pair = (client_label, effective_full)

    full_key = f"full:{effective_full.lower()}"
    if pair not in mapping[full_key]:
        mapping[full_key].append(pair)

    if id_cleaned:
        code_key = id_cleaned.upper()
        if pair not in mapping[code_key]:
            mapping[code_key].append(pair)

    code_match = _SELLER_CODE_RE.search(id_cleaned or effective_full)
    if code_match:
        regex_key = code_match.group(1).upper()
        if pair not in mapping[regex_key]:
            mapping[regex_key].append(pair)


def _fetch_google_sheet_ranges(
    credentials_file: Path,
    spreadsheet_id: str,
    worksheet_name: str,
    ranges: list[str],
    max_attempts: int = 3,
) -> list[list[list[str]]]:
    """Fetch column ranges in a single Google Sheets API batch_get request with retry."""
    if not credentials_file.exists():
        raise FileNotFoundError(
            f"Service Account credentials file not found: {credentials_file}."
        )

    import time
    import gspread

    last_err: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            client = gspread.service_account(
                filename=str(credentials_file), scopes=READONLY_SHEETS_SCOPES
            )
            spreadsheet = client.open_by_key(spreadsheet_id)
            worksheet = spreadsheet.worksheet(worksheet_name)
            return worksheet.batch_get(ranges)
        except Exception as err:
            last_err = err
            if attempt >= max_attempts:
                break
            time.sleep(0.8 * attempt)

    assert last_err is not None
    raise RuntimeError(f"Failed to fetch Google Sheet mapping after {max_attempts} attempts: {last_err}") from last_err


def _cell_at(column_rows: list[list[str]], row_idx: int) -> str:
    if row_idx >= len(column_rows) or not column_rows[row_idx]:
        return ""
    return str(column_rows[row_idx][0] or "").strip()


def load_seller_mapping_from_sheet(
    sheet_config_path: Path,
    credentials_override: Path | None = None,
    fetcher: RangeBatchFetcher | None = None,
) -> SellerMapping:
    """Load Seller ID -> [(Clients, full Seller ID)] mapping directly from Google Sheets."""
    cfg = load_sheet_config(sheet_config_path, credentials_override=credentials_override)
    requested_ranges = [cfg.seller_full_match_range, cfg.seller_used_id_range]

    status_batch_idx: int | None = None
    if cfg.active_status_range:
        status_batch_idx = len(requested_ranges)
        requested_ranges.append(cfg.active_status_range)

    client_batch_idx: int | None = None
    if cfg.client_range:
        client_batch_idx = len(requested_ranges)
        requested_ranges.append(cfg.client_range)

    batch_fn = fetcher or _fetch_google_sheet_ranges
    batch_values = batch_fn(
        cfg.credentials_file, cfg.spreadsheet_id, cfg.worksheet, requested_ranges
    )

    full_col = batch_values[0] if len(batch_values) > 0 else []
    id_col = batch_values[1] if len(batch_values) > 1 else []
    status_col = (
        batch_values[status_batch_idx]
        if status_batch_idx is not None and status_batch_idx < len(batch_values)
        else []
    )
    client_col = (
        batch_values[client_batch_idx]
        if client_batch_idx is not None and client_batch_idx < len(batch_values)
        else []
    )

    total_rows = max(len(full_col), len(id_col), len(status_col), len(client_col))
    mapping: dict[str, list[tuple[str, str]]] = defaultdict(list)
    platform_token = f".{cfg.platform_filter.upper()}." if cfg.platform_filter else ""

    for idx in range(total_rows):
        full_val = _cell_at(full_col, idx)
        id_val = _cell_at(id_col, idx)
        if not full_val and not id_val:
            continue

        if cfg.active_status_range and cfg.active_only:
            status_val = _cell_at(status_col, idx)
            if not _is_active_status(status_val):
                continue

        candidate = f"{id_val} {full_val}".upper()
        if platform_token and platform_token not in candidate:
            continue
        if id_val.upper().endswith(".TBD") or full_val.upper().endswith(".TBD"):
            continue

        explicit_client = _cell_at(client_col, idx) if client_batch_idx is not None else ""
        _register_mapping_entry(mapping, explicit_client, full_val, id_val)

    return dict(mapping)


def load_seller_mapping_from_xlsx(seller_list_path: Path) -> SellerMapping:
    """Load Seller ID -> [(Clients, full Seller ID)] mapping from a local .xlsx file.

    Forward-fills the Clients column when vertically merged cells are used.
    """
    if not seller_list_path.exists():
        return {}

    rows = read_xlsx_rows(seller_list_path)
    if not rows:
        return {}

    header = [str(cell or "").strip().lower() for cell in rows[0]]
    client_col = next((i for i, h in enumerate(header) if "client" in h or "company" in h), 0)
    seller_col = next((i for i, h in enumerate(header) if "seller" in h), 1)
    start_row = (
        1
        if any(kw in " ".join(header) for kw in ("client", "company", "seller"))
        else 0
    )

    mapping: dict[str, list[tuple[str, str]]] = defaultdict(list)
    current_client = ""

    for row in rows[start_row:]:
        raw_client = str(row[client_col]).strip() if client_col < len(row) else ""
        if raw_client:
            current_client = raw_client

        full_seller_id = str(row[seller_col]).strip() if seller_col < len(row) else ""
        if not full_seller_id:
            continue

        _register_mapping_entry(mapping, current_client, full_seller_id)

    return dict(mapping)


def load_seller_mapping(
    source_path: Path,
    credentials_override: Path | None = None,
    fetcher: RangeBatchFetcher | None = None,
) -> SellerMapping:
    """Load Seller ID mapping from either `sheet.yaml` (Google Sheets) or a local `.xlsx` file."""
    suffix = source_path.suffix.lower()
    if suffix in (".yaml", ".yml"):
        return load_seller_mapping_from_sheet(
            source_path, credentials_override=credentials_override, fetcher=fetcher
        )
    return load_seller_mapping_from_xlsx(source_path)


def resolve_seller_matches(
    raw_seller_id: str, seller_mapping: SellerMapping
) -> list[tuple[str, str]]:
    """Resolve a folder's seller ID into matching (Clients, full Seller ID) pairs."""
    cleaned = str(raw_seller_id or "").strip()
    if not seller_mapping:
        return [("Unmapped", cleaned)]

    full_matches = seller_mapping.get(f"full:{cleaned.lower()}")
    if full_matches:
        return full_matches

    direct_matches = seller_mapping.get(cleaned.upper())
    if direct_matches:
        return direct_matches

    code_match = _SELLER_CODE_RE.search(cleaned)
    if code_match:
        code_matches = seller_mapping.get(code_match.group(1).upper())
        if code_matches:
            return code_matches

    return [("Unmapped", cleaned)]
