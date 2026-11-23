"""Zero-dependency OpenXML (.xlsx) reader and multi-sheet workbook writer."""

from __future__ import annotations

from pathlib import Path
import re
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as xml_escape
import zipfile


_CTRL_CHARS_RE = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F]")
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
    letters: list[str] = []
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
        parts = [node.text or "" for node in child.iter() if _local_tag(node.tag) == "t"]
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
        return "".join(node.text or "" for node in is_node.iter() if _local_tag(node.tag) == "t")

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
                (
                    n
                    for n in sorted(names)
                    if n.lower().startswith("xl/worksheets/sheet") and n.lower().endswith(".xml")
                ),
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
            parsed_rows.append([cell_map.get(i, "") for i in range(max_col + 1)])

    return parsed_rows


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
    col_widths = [22, 42, 14, 24, 16, 20, 16]
    cols_xml = (
        "<cols>"
        + "".join(
            f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>'
            for i, w in enumerate(col_widths)
        )
        + "</cols>"
    )

    headers = [
        "Clients",
        "Seller ID",
        "Date",
        "Content Type",
        "revenue",
        "product_impression",
        "impression",
    ]
    header_cells = "".join(
        f'<c r="{_index_to_col_letters(c)}1" t="inlineStr" s="1"><is><t>{_clean_xml_text(h)}</t></is></c>'
        for c, h in enumerate(headers)
    )
    xml_rows = [f'<row r="1">{header_cells}</row>']

    for r_offset, item in enumerate(rows_data, start=2):
        cells = [
            f'<c r="A{r_offset}" t="inlineStr"><is><t>{_clean_xml_text(item["client"])}</t></is></c>',
            f'<c r="B{r_offset}" t="inlineStr"><is><t>{_clean_xml_text(item["seller_id"])}</t></is></c>',
            f'<c r="C{r_offset}" t="inlineStr"><is><t>{_clean_xml_text(item["date"])}</t></is></c>',
            f'<c r="D{r_offset}" t="inlineStr"><is><t>{_clean_xml_text(item["content_type"])}</t></is></c>',
            f'<c r="E{r_offset}" s="2"><v>{item["revenue"]}</v></c>',
            f'<c r="F{r_offset}" s="3"><v>{item["product_impression"]}</v></c>',
            f'<c r="G{r_offset}" s="3"><v>{item["impression"]}</v></c>',
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
