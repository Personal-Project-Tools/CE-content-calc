"""Tests for zero-dependency OpenXML xlsx reading and multi-sheet writing."""

from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from ce_content_calc.xlsx_io import read_xlsx_rows, write_results_xlsx


def _build_minimal_shared_strings_xlsx(path: Path) -> None:
    """Create a valid .xlsx fixture using xl/sharedStrings.xml."""
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/sharedStrings.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
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
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" '
        'Target="sharedStrings.xml"/></Relationships>'
    )
    shared_strings = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">'
        "<si><t>Clients</t></si>"
        "<si><t>Seller ID</t></si>"
        "</sst>"
    )
    sheet1 = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
        '<row r="2"><c r="A2" t="inlineStr"><is><t>Abbott</t></is></c>'
        '<c r="B2" t="inlineStr"><is><t>abbott - MY.TTK.123</t></is></c></row>'
        "</sheetData></worksheet>"
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("xl/workbook.xml", workbook)
        zf.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        zf.writestr("xl/sharedStrings.xml", shared_strings)
        zf.writestr("xl/worksheets/sheet1.xml", sheet1)


class XlsxIoTests(unittest.TestCase):
    def test_read_xlsx_rows_with_shared_strings(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            xlsx_path = Path(tmpdir) / "shared.xlsx"
            _build_minimal_shared_strings_xlsx(xlsx_path)

            rows = read_xlsx_rows(xlsx_path)
            self.assertEqual(rows[0], ["Clients", "Seller ID"])
            self.assertEqual(rows[1], ["Abbott", "abbott - MY.TTK.123"])

    def test_write_results_xlsx_creates_date_sheets(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            out_path = Path(tmpdir) / "nested" / "metrics.xlsx"
            results_by_date = {
                "2026-11-15": [
                    {
                        "client": "Abbott",
                        "seller_id": "abbott - MY.TTK.1",
                        "date": "2026-11-15",
                        "content_type": "TikTok Content Live",
                        "revenue": 120.5,
                        "product_impression": 500,
                        "impression": 200,
                    }
                ],
                "2026-11-16": [
                    {
                        "client": "Golden ABC",
                        "seller_id": "golden_abc - PH.TTK.2",
                        "date": "2026-11-16",
                        "content_type": "TikTok Content Video",
                        "revenue": 0.0,
                        "product_impression": 190,
                        "impression": 85,
                    }
                ],
            }
            write_results_xlsx(out_path, results_by_date)
            self.assertTrue(out_path.exists())

            with zipfile.ZipFile(out_path, "r") as zf:
                wb_xml = zf.read("xl/workbook.xml").decode("utf-8")
                self.assertIn('name="2026-11-15"', wb_xml)
                self.assertIn('name="2026-11-16"', wb_xml)
                sheet2_xml = zf.read("xl/worksheets/sheet2.xml").decode("utf-8")
                self.assertIn("Golden ABC", sheet2_xml)
                self.assertIn("golden_abc - PH.TTK.2", sheet2_xml)
