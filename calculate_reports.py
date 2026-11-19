"""Calculate TikTok Content Live and TikTok Content Video metrics per Seller ID and date.

Scans Reports/{seller_id}_{date}/*.xlsx, aggregates revenue, product_impression, and impression
for every Seller ID grouped by report date, and writes one consolidated workbook in results/
where each worksheet corresponds to a date and contains all sellers for that date.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as xml_escape
import zipfile


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_REPORTS_DIR = BASE_DIR / "Reports"
DEFAULT_OUTPUT_FILE = BASE_DIR / "results" / "tiktok_content_metrics.xlsx"

CONTENT_TYPES = {
    "live": "TikTok Content Live",
    "video": "TikTok Content Video",
}

METRIC_RULES = {
    "live": {
        "revenue": {
            "headers": ("LIVE-attributed GMV",),
            "fallback_index": 5,  # 1-based col 6 -> 0-based 5
        },
        "product_impression": {
            "headers": ("Product Impressions",),
            "fallback_index": 25,  # 1-based col 26 -> 0-based 25
        },
        "impression": {
            "headers": ("Views",),
            "fallback_index": 19,  # 1-based col 20 -> 0-based 19
        },
    },
    "video": {
        "revenue": {
            "headers": ("Video-attributed GMV",),
            "fallback_index": 22,  # 0-based col 22
        },
        "product_impression": {
            "headers": ("Product Impressions",),
            "fallback_index": 13,  # 0-based col 13
        },
        "impression": {
            "headers": ("Video Views", "Video views", "VV"),
            "fallback_index": 7,  # 0-based col 7
        },
    },
}

_CTRL_CHARS_RE = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F]")
_TRAILING_UNIT_RE = re.compile(r"\s*\([^)]*\)\s*$")
_NON_NUMERIC_RE = re.compile(r"[^0-9.\-]")
_INVALID_SHEET_CHARS_RE = re.compile(r"[:\\/?*\[\]]")


def _local_tag(tag: str) -> str:
    """Strip XML namespace prefix from an ElementTree tag."""
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def _col_ref_to_index(cell_ref: str) -> int:
    """Convert an Excel cell reference such as 'AA4' to a 0-based column index."""
    letters = "".join(ch for ch in cell_ref.upper() if ch.isalpha())
    if not letters:
        return -1
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch) - 64)
    return idx - 1


def _index_to_col_letters(index: int) -> str:
    """Convert a 0-based column index to Excel column letters (0 -> 'A')."""
    n = index + 1
    letters = []
    while n > 0:
        rem = (n - 1) % 26
        letters.append(chr(65 + rem))
        n = (n - 1) // 26
    return "".join(reversed(letters))


def _load_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    """Read xl/sharedStrings.xml if present in the workbook archive."""
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    strings: list[str] = []
    for child in root:
        if _local_tag(child.tag) != "si":
            continue
        parts = [
            node.text or ""
            for node in child.iter()
            if _local_tag(node.tag) == "t"
        ]
        strings.append("".join(parts))
    return strings


def _extract_cell_text(cell_el: ET.Element, shared_strings: list[str]) -> str:
    """Extract string or numeric representation from a worksheet <c> element."""
    cell_type = cell_el.attrib.get("t", "")
    if cell_type == "e":
        return ""

    if cell_type == "inlineStr":
        is_node = next((ch for ch in cell_el if _local_tag(ch.tag) == "is"), None)
        if is_node is None:
            return ""
        return "".join(
            node.text or ""
            for node in is_node.iter()
            if _local_tag(node.tag) == "t"
        )

    v_node = next((ch for ch in cell_el if _local_tag(ch.tag) == "v"), None)
    if v_node is None or v_node.text is None:
        return ""

    raw_val = v_node.text
    if cell_type == "s":
        try:
            idx = int(raw_val)
            return shared_strings[idx] if 0 <= idx < len(shared_strings) else ""
        except ValueError:
            return ""
    return raw_val


def read_xlsx_rows(file_path: Path) -> list[list[str]]:
    """Parse rows of cell strings from the first worksheet of an .xlsx file."""
    with zipfile.ZipFile(file_path, "r") as zf:
        shared_strings = _load_shared_strings(zf)
        names = zf.namelist()
        if "xl/worksheets/sheet1.xml" in names:
            sheet_name = "xl/worksheets/sheet1.xml"
        else:
            sheet_name = next(
                (n for n in sorted(names) if n.lower().startswith("xl/worksheets/sheet") and n.lower().endswith(".xml")),
                "",
            )
        if not sheet_name:
            raise ValueError(f"No worksheet XML found in {file_path}")
        root = ET.fromstring(zf.read(sheet_name))

    sheet_data = next((ch for ch in root if _local_tag(ch.tag) == "sheetData"), None)
    if sheet_data is None:
        return []

    parsed_rows: list[list[str]] = []
    for row_el in sheet_data:
        if _local_tag(row_el.tag) != "row":
            continue
        cell_map: dict[int, str] = {}
        max_col = -1
        next_col = 0
        for cell_el in row_el:
            if _local_tag(cell_el.tag) != "c":
                continue
            col_idx = _col_ref_to_index(cell_el.attrib.get("r", ""))
            if col_idx < 0:
                col_idx = next_col
            next_col = col_idx + 1
            if col_idx > max_col:
                max_col = col_idx
            cell_map[col_idx] = _extract_cell_text(cell_el, shared_strings)

        if max_col >= 0:
            row_vals = [cell_map.get(i, "") for i in range(max_col + 1)]
            parsed_rows.append(row_vals)

    return parsed_rows


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
        headers, rules["product_impression"]["headers"], rules["product_impression"]["fallback_index"]
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
    """Split '{seller_id}_{date}' folder name into (seller_id, date_str)."""
    if "_" not in folder_name:
        return folder_name, "unknown"
    seller_id, date_str = folder_name.rsplit("_", 1)
    return seller_id, date_str


def collect_metrics_by_date(reports_dir: Path) -> dict[str, list[dict[str, object]]]:
    """Scan Reports/ subdirectories and return calculated metric rows grouped by date."""
    if not reports_dir.exists():
        raise FileNotFoundError(f"Reports directory does not exist: {reports_dir}")

    grouped: dict[str, dict[str, dict[str, dict[str, float]]]] = defaultdict(dict)

    for entry in sorted(reports_dir.iterdir()):
        if not entry.is_dir():
            continue

        xlsx_files = sorted(
            f for f in entry.iterdir() if f.is_file() and classify_report_filename(f.name) is not None
        )
        if not xlsx_files:
            continue

        seller_id, date_str = parse_folder_name(entry.name)
        seller_acc = grouped[date_str].setdefault(
            seller_id,
            {
                "live": {"revenue": 0.0, "product_impression": 0.0, "impression": 0.0},
                "video": {"revenue": 0.0, "product_impression": 0.0, "impression": 0.0},
            },
        )

        for file_path in xlsx_files:
            content_key = classify_report_filename(file_path.name)
            if content_key is None:
                continue
            rows = read_xlsx_rows(file_path)
            metrics = compute_file_metrics(rows, content_key)
            seller_acc[content_key]["revenue"] += metrics["revenue"]
            seller_acc[content_key]["product_impression"] += metrics["product_impression"]
            seller_acc[content_key]["impression"] += metrics["impression"]

    results_by_date: dict[str, list[dict[str, object]]] = {}
    for date_str in sorted(grouped.keys()):
        date_rows: list[dict[str, object]] = []
        for seller_id in sorted(grouped[date_str].keys()):
            acc = grouped[date_str][seller_id]
            for content_key in ("live", "video"):
                totals = acc[content_key]
                date_rows.append(
                    {
                        "seller_id": seller_id,
                        "date": date_str,
                        "content_type": CONTENT_TYPES[content_key],
                        "revenue": round(totals["revenue"], 2),
                        "product_impression": int(round(totals["product_impression"])),
                        "impression": int(round(totals["impression"])),
                    }
                )
        results_by_date[date_str] = date_rows

    return results_by_date


# --- Zero-Dependency Multi-Sheet OpenXML Writer ---


def _clean_xml_text(value: object) -> str:
    cleaned = _CTRL_CHARS_RE.sub("", str(value if value is not None else ""))
    return xml_escape(cleaned, {'"': "&quot;", "'": "&apos;"})


def _sanitize_sheet_name(raw_name: str, used_names: set[str]) -> str:
    cleaned = _INVALID_SHEET_CHARS_RE.sub("_", raw_name).strip() or "Sheet"
    base = cleaned[:31]
    candidate = base
    suffix = 1
    while candidate.lower() in used_names:
        suffix_str = f"_{suffix}"
        candidate = f"{base[: 31 - len(suffix_str)]}{suffix_str}"
        suffix += 1
    used_names.add(candidate.lower())
    return candidate


def _build_worksheet_xml(rows_data: list[dict[str, object]]) -> str:
    col_widths = [30, 14, 24, 16, 20, 16]
    cols_xml = (
        "<cols>"
        + "".join(
            f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>'
            for i, w in enumerate(col_widths)
        )
        + "</cols>"
    )

    headers = ["Seller ID", "Date", "Content Type", "revenue", "product_impression", "impression"]
    header_cells = "".join(
        f'<c r="{_index_to_col_letters(c)}1" t="inlineStr" s="1"><is><t>{_clean_xml_text(h)}</t></is></c>'
        for c, h in enumerate(headers)
    )
    xml_rows = [f'<row r="1">{header_cells}</row>']

    for r_offset, item in enumerate(rows_data, start=2):
        cells = [
            f'<c r="A{r_offset}" t="inlineStr"><is><t>{_clean_xml_text(item["seller_id"])}</t></is></c>',
            f'<c r="B{r_offset}" t="inlineStr"><is><t>{_clean_xml_text(item["date"])}</t></is></c>',
            f'<c r="C{r_offset}" t="inlineStr"><is><t>{_clean_xml_text(item["content_type"])}</t></is></c>',
            f'<c r="D{r_offset}" s="2"><v>{item["revenue"]}</v></c>',
            f'<c r="E{r_offset}" s="3"><v>{item["product_impression"]}</v></c>',
            f'<c r="F{r_offset}" s="3"><v>{item["impression"]}</v></c>',
        ]
        xml_rows.append(f'<row r="{r_offset}">{"".join(cells)}</row>')

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"{cols_xml}<sheetData>{''.join(xml_rows)}</sheetData></worksheet>"
    )


def write_results_xlsx(output_path: Path, results_by_date: dict[str, list[dict[str, object]]]) -> None:
    """Write a multi-sheet .xlsx workbook with one sheet per date containing all sellers."""
    if not results_by_date:
        raise ValueError("No report data found to export.")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    used_sheet_names: set[str] = set()
    sheets = [
        {
            "name": _sanitize_sheet_name(date_str, used_sheet_names),
            "xml": _build_worksheet_xml(rows),
        }
        for date_str, rows in results_by_date.items()
    ]

    overrides = "".join(
        f'<Override PartName="/xl/worksheets/sheet{i}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for i in range(1, len(sheets) + 1)
    )
    content_types_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        f"{overrides}</Types>"
    )

    root_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/>'
        "</Relationships>"
    )

    sheet_tags = "".join(
        f'<sheet name="{_clean_xml_text(s["name"])}" sheetId="{i}" r:id="rId{i}"/>'
        for i, s in enumerate(sheets, start=1)
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<sheets>{sheet_tags}</sheets></workbook>"
    )

    sheet_rels = "".join(
        f'<Relationship Id="rId{i}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet{i}.xml"/>'
        for i in range(1, len(sheets) + 1)
    )
    styles_rel_id = f"rId{len(sheets) + 1}"
    workbook_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f"{sheet_rels}"
        f'<Relationship Id="{styles_rel_id}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/></Relationships>'
    )

    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2">'
        '<font><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><sz val="11"/><name val="Calibri"/></font>'
        "</fonts>"
        '<fills count="3">'
        '<fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF5"/></patternFill></fill>'
        "</fills>"
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="4">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
        '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        "</cellXfs>"
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types_xml)
        zf.writestr("_rels/.rels", root_rels_xml)
        zf.writestr("xl/workbook.xml", workbook_xml)
        zf.writestr("xl/_rels/workbook.xml.rels", workbook_rels_xml)
        zf.writestr("xl/styles.xml", styles_xml)
        for i, sheet in enumerate(sheets, start=1):
            zf.writestr(f"xl/worksheets/sheet{i}.xml", sheet["xml"])


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Aggregate TikTok Shop LIVE & Video metrics per Seller ID and date."
    )
    parser.add_argument(
        "--reports-dir",
        type=Path,
        default=DEFAULT_REPORTS_DIR,
        help="Input Reports directory containing {seller_id}_{date} folders.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_FILE,
        help="Output .xlsx file path inside results/.",
    )
    args = parser.parse_args()

    results_by_date = collect_metrics_by_date(args.reports_dir)
    if not results_by_date:
        print(f"No valid report files found under: {args.reports_dir}")
        return

    write_results_xlsx(args.output, results_by_date)

    for date_str, rows in results_by_date.items():
        print(f"\n=== Sheet: {date_str} ===")
        for row in rows:
            print(
                f"  {row['seller_id']} | {str(row['content_type']):<22} | "
                f"revenue={row['revenue']:>10.2f} | "
                f"product_impression={row['product_impression']:>10,} | "
                f"impression={row['impression']:>10,}"
            )
    print(f"\nExported workbook: {args.output}")


if __name__ == "__main__":
    main()
