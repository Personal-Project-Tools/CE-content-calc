"""Tests for Client <-> Seller ID mapping (including merged cells)."""

from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from ce_content_calc.seller_mapping import load_seller_mapping, resolve_seller_matches


def _write_seller_list_fixture(path: Path, rows: list[tuple[str, str]]) -> None:
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/></Relationships>'
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="List" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/></Relationships>'
    )
    xml_rows = []
    for r_idx, (c_val, s_val) in enumerate(rows, start=1):
        xml_rows.append(
            f'<row r="{r_idx}">'
            f'<c r="A{r_idx}" t="inlineStr"><is><t>{c_val}</t></is></c>'
            f'<c r="B{r_idx}" t="inlineStr"><is><t>{s_val}</t></is></c>'
            "</row>"
        )
    sheet1 = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(xml_rows)}</sheetData></worksheet>'
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("xl/workbook.xml", workbook)
        zf.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        zf.writestr("xl/worksheets/sheet1.xml", sheet1)


class SellerMappingTests(unittest.TestCase):
    def test_forward_fills_merged_client_and_handles_shared_seller_code(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            seller_xlsx = Path(tmpdir) / "seller_list.xlsx"
            _write_seller_list_fixture(
                seller_xlsx,
                [
                    ("Clients", "Seller ID"),
                    ("Abbott", "abbott - MY.TTK.111"),
                    ("", "abbott - PH.TTK.222"),
                    ("ADA", "ada - MY.TTK.333"),
                    ("Blackmores", "ada - MY.TTK.333"),
                ],
            )

            mapping = load_seller_mapping(seller_xlsx)

            self.assertEqual(
                resolve_seller_matches("PH.TTK.222", mapping),
                [("Abbott", "abbott - PH.TTK.222")],
            )
            self.assertEqual(
                resolve_seller_matches("MY.TTK.333", mapping),
                [("ADA", "ada - MY.TTK.333"), ("Blackmores", "ada - MY.TTK.333")],
            )
            self.assertEqual(
                resolve_seller_matches("VN.TTK.999", mapping),
                [("Unmapped", "VN.TTK.999")],
            )

    def test_missing_seller_list_returns_empty_mapping(self) -> None:
        mapping = load_seller_mapping(Path("nonexistent_seller_list.xlsx"))
        self.assertEqual(mapping, {})
        self.assertEqual(
            resolve_seller_matches("MY.TTK.111", mapping),
            [("Unmapped", "MY.TTK.111")],
        )
