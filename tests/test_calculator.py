"""Tests for report file classification, column resolution, and date aggregation."""

from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from ce_content_calc.calculator import (
    classify_report_filename,
    collect_metrics_by_date,
    compute_file_metrics,
    resolve_column_index,
)
from ce_content_calc.config import CONTENT_TYPES


def _write_report_fixture(path: Path, headers: list[str], data_rows: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/></Relationships>'
    )

    def _col(idx: int) -> str:
        n = idx + 1
        out = ""
        while n:
            n, rem = divmod(n - 1, 26)
            out = chr(65 + rem) + out
        return out

    xml_rows = [
        '<row r="1"><c r="A1" t="inlineStr"><is><t>Date Range</t></is></c></row>'
    ]
    all_rows = [headers] + data_rows
    for offset, row in enumerate(all_rows, start=3):
        cells = "".join(
            f'<c r="{_col(i)}{offset}" t="inlineStr"><is><t>{val}</t></is></c>'
            for i, val in enumerate(row)
        )
        xml_rows.append(f'<row r="{offset}">{cells}</row>')

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


class CalculatorTests(unittest.TestCase):
    def test_classify_report_filename(self) -> None:
        self.assertEqual(classify_report_filename("1_LIVE_Linked.xlsx"), "live")
        self.assertEqual(classify_report_filename("2_LIVE_Affiliate.xlsx"), "live")
        self.assertEqual(classify_report_filename("3_Video_Linked.xlsx"), "video")
        self.assertEqual(classify_report_filename("4_Video_Affiliate.xlsx"), "video")
        self.assertIsNone(classify_report_filename("~$1_LIVE_Linked.xlsx"))
        self.assertIsNone(classify_report_filename("Summary_test.xlsx"))

    def test_resolve_column_index_and_fallbacks(self) -> None:
        headers = ["Creator", "LIVE-attributed GMV (₱)", "Views", "Viewers", "Product Impressions"]
        self.assertEqual(resolve_column_index(headers, ("LIVE-attributed GMV",), 5), 1)
        self.assertEqual(resolve_column_index(headers, ("Views",), 19), 2)
        self.assertEqual(resolve_column_index(headers, ("Product Impressions",), 25), 4)
        self.assertEqual(resolve_column_index(headers, ("VV", "Video views"), 7), 7)

    def test_compute_file_metrics_supports_shifted_video_columns(self) -> None:
        rows = [
            ["Date Range: 2026-11-18"],
            ["ColA", "Video views", "Other1", "Product Impressions", "Video-attributed GMV (₱)"],
            ["x", "120", "0", "300", "45.67"],
            ["y", "80", "0", "200", "54.33"],
        ]
        metrics = compute_file_metrics(rows, "video")
        self.assertAlmostEqual(metrics["revenue"], 100.0)
        self.assertEqual(metrics["product_impression"], 500.0)
        self.assertEqual(metrics["impression"], 200.0)

    def test_collect_metrics_by_date_handles_3level_hierarchy_and_missing_tabs(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            reports_dir = Path(tmpdir)
            seller_dir = reports_dir / "2026-11-18" / "PH.TTK.100"

            # Only 4_Video_Affiliate exists (LIVE reports missing for this date/seller)
            _write_report_fixture(
                seller_dir / "4_Video_Affiliate.xlsx",
                headers=["C0", "VV", "C2", "Product Impressions", "Video-attributed GMV (₱)"],
                data_rows=[["u1", "85", "a", "190", "12.34"]],
            )

            mapping = {"PH.TTK.100": [("Golden ABC", "golden_abc - PH.TTK.100")]}
            grouped = collect_metrics_by_date(reports_dir, mapping)

            self.assertIn("2026-11-18", grouped)
            rows = grouped["2026-11-18"]
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["client"], "Golden ABC")
            self.assertEqual(rows[0]["seller_id"], "golden_abc - PH.TTK.100")
            self.assertEqual(rows[0]["content_type"], CONTENT_TYPES["live"])
            self.assertEqual(rows[0]["revenue"], 0.0)
            self.assertEqual(rows[1]["content_type"], CONTENT_TYPES["video"])
            self.assertEqual(rows[1]["revenue"], 12.34)
            self.assertEqual(rows[1]["product_impression"], 190)
            self.assertEqual(rows[1]["impression"], 85)
