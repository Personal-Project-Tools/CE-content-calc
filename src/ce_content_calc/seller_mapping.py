"""Client <-> Seller ID mapping loader and lookup helpers."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
import re

from ce_content_calc.xlsx_io import read_xlsx_rows


_SELLER_CODE_RE = re.compile(r"([A-Za-z]{2}\.TTK\.\d+)", re.IGNORECASE)


def load_seller_mapping(seller_list_path: Path) -> dict[str, list[tuple[str, str]]]:
    """Load Seller ID -> [(Clients, full Seller ID)] mapping from seller_list.xlsx.

    Forward-fills the Clients column because seller_list.xlsx uses vertically merged cells.
    """
    if not seller_list_path.exists():
        return {}

    rows = read_xlsx_rows(seller_list_path)
    if not rows:
        return {}

    header = [str(cell or "").strip().lower() for cell in rows[0]]
    client_col = next((i for i, h in enumerate(header) if "client" in h), 0)
    seller_col = next((i for i, h in enumerate(header) if "seller" in h), 1)
    start_row = 1 if ("client" in " ".join(header) or "seller" in " ".join(header)) else 0

    mapping: dict[str, list[tuple[str, str]]] = defaultdict(list)
    current_client = ""

    for row in rows[start_row:]:
        raw_client = str(row[client_col]).strip() if client_col < len(row) else ""
        if raw_client:
            current_client = raw_client

        full_seller_id = str(row[seller_col]).strip() if seller_col < len(row) else ""
        if not full_seller_id:
            continue

        client_label = current_client or "Unmapped"
        pair = (client_label, full_seller_id)

        full_key = f"full:{full_seller_id.lower()}"
        if pair not in mapping[full_key]:
            mapping[full_key].append(pair)

        code_match = _SELLER_CODE_RE.search(full_seller_id)
        if code_match:
            code_key = code_match.group(1).upper()
            if pair not in mapping[code_key]:
                mapping[code_key].append(pair)

    return dict(mapping)


def resolve_seller_matches(
    raw_seller_id: str, seller_mapping: dict[str, list[tuple[str, str]]]
) -> list[tuple[str, str]]:
    """Resolve a folder's seller ID into matching (Clients, full Seller ID) pairs."""
    cleaned = str(raw_seller_id or "").strip()
    if not seller_mapping:
        return [("Unmapped", cleaned)]

    full_matches = seller_mapping.get(f"full:{cleaned.lower()}")
    if full_matches:
        return full_matches

    code_match = _SELLER_CODE_RE.search(cleaned)
    if code_match:
        code_matches = seller_mapping.get(code_match.group(1).upper())
        if code_matches:
            return code_matches

    return [("Unmapped", cleaned)]
