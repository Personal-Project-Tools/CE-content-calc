"""Tests for Google Sheets (`sheet.yaml`) and local `.xlsx` Client <-> Seller ID mapping."""

from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from ce_content_calc.seller_mapping import (
    load_seller_mapping,
    load_sheet_config,
    normalize_a1_range,
    resolve_seller_matches,
)


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
    def test_normalize_a1_range_supports_standard_and_shorthand(self) -> None:
        self.assertEqual(normalize_a1_range("AV4:AV"), "AV4:AV")
        self.assertEqual(normalize_a1_range("I4:I"), "I4:I")
        self.assertEqual(normalize_a1_range("column[AW] - row[4] #AW4:AW"), "AW4:AW")
        self.assertEqual(normalize_a1_range("column[av] - row[4]"), "AV4:AV")

    def test_load_sheet_config_and_mapping_filters_active_status_true(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            creds_file = tmp / "service.json"
            creds_file.write_text("{}", encoding="utf-8")
            yaml_path = tmp / "sheet.yaml"
            yaml_path.write_text(
                f"""
sheet:
  credentials_file: "{creds_file.as_posix()}"
  spreadsheet_id: "dummy_spreadsheet_123"
  worksheet: "seller_scope"
  ranges:
    seller_full_match: "AV4:AV"
    seller_used_id: "AW4:AW"
    active_status: "I4:I"
  filters:
    platform: "TTK"
    active_only: true
""",
                encoding="utf-8",
            )

            cfg = load_sheet_config(yaml_path)
            self.assertEqual(cfg.spreadsheet_id, "dummy_spreadsheet_123")
            self.assertEqual(cfg.worksheet, "seller_scope")
            self.assertEqual(cfg.seller_full_match_range, "AV4:AV")
            self.assertEqual(cfg.seller_used_id_range, "AW4:AW")
            self.assertEqual(cfg.active_status_range, "I4:I")
            self.assertTrue(cfg.active_only)

            # Also verify singular 'filter:' key and backslash path handling
            singular_yaml = tmp / "sheet_singular.yaml"
            singular_yaml.write_text(
                f"""
sheet:
  credentials_file: "{str(creds_file).replace('\\', '\\\\')}"
  spreadsheet_id: "dummy_spreadsheet_123"
  worksheet: "seller_scope"
  ranges:
    seller_full_match: "AV4:AV"
    seller_used_id: "AW4:AW"
  filter:
    platform: "TTK"
    active_only: false
""",
                encoding="utf-8",
            )
            singular_cfg = load_sheet_config(singular_yaml)
            self.assertEqual(singular_cfg.credentials_file, creds_file)
            self.assertFalse(singular_cfg.active_only)

            def fake_fetcher(
                credentials: Path, spreadsheet_id: str, worksheet: str, ranges: list[str]
            ) -> list[list[list[str]]]:
                self.assertEqual(credentials, creds_file)
                self.assertEqual(spreadsheet_id, "dummy_spreadsheet_123")
                self.assertEqual(worksheet, "seller_scope")
                self.assertEqual(ranges, ["AV4:AV", "AW4:AW", "I4:I"])
                return [
                    [
                        ["client_alpha - SG.TTK.1001"],
                        ["client_alpha - SG.SHP.2002"],   # non-TTK filtered out
                        ["client_beta - VN.TTK.3003"],    # active TRUE
                        ["client_old - VN.TTK.3003"],     # inactive FALSE -> excluded!
                        ["client_gamma - VN.TTK.3003"],   # active TRUE shared seller_used_id
                        ["client_beta - VN.TTK.3003"],    # exact duplicate deduplicated
                        ["client_delta - MY.TTK.4004"],   # empty status -> excluded!
                        ["client_eps - MY.TTK.TBD"],      # placeholder ignored
                    ],
                    [
                        ["SG.TTK.1001"],
                        ["SG.SHP.2002"],
                        ["VN.TTK.3003"],
                        ["VN.TTK.3003"],
                        ["VN.TTK.3003"],
                        ["VN.TTK.3003"],
                        ["MY.TTK.4004"],
                        ["MY.TTK.TBD"],
                    ],
                    [
                        ["TRUE"],
                        ["TRUE"],
                        ["TRUE"],
                        ["FALSE"],
                        ["true"],
                        ["TRUE"],
                        [""],
                        ["TRUE"],
                    ],
                ]

            mapping = load_seller_mapping(yaml_path, fetcher=fake_fetcher)

            self.assertEqual(
                resolve_seller_matches("SG.TTK.1001", mapping),
                [("client_alpha", "client_alpha - SG.TTK.1001")],
            )
            self.assertEqual(
                resolve_seller_matches("VN.TTK.3003", mapping),
                [
                    ("client_beta", "client_beta - VN.TTK.3003"),
                    ("client_gamma", "client_gamma - VN.TTK.3003"),
                ],
            )
            self.assertEqual(
                resolve_seller_matches("MY.TTK.4004", mapping),
                [("Unmapped", "MY.TTK.4004")],
            )
            self.assertEqual(
                resolve_seller_matches("SG.SHP.2002", mapping),
                [("Unmapped", "SG.SHP.2002")],
            )
            self.assertEqual(
                resolve_seller_matches("PH.TTK.9999", mapping),
                [("Unmapped", "PH.TTK.9999")],
            )

    def test_xlsx_fallback_forward_fills_merged_client_and_handles_shared_code(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            seller_xlsx = Path(tmpdir) / "seller_list.xlsx"
            _write_seller_list_fixture(
                seller_xlsx,
                [
                    ("Clients", "Seller ID"),
                    ("client_alpha", "client_alpha - MY.TTK.111"),
                    ("", "client_alpha - PH.TTK.222"),
                    ("client_beta", "client_beta - MY.TTK.333"),
                    ("client_gamma", "client_beta - MY.TTK.333"),
                ],
            )

            mapping = load_seller_mapping(seller_xlsx)

            self.assertEqual(
                resolve_seller_matches("PH.TTK.222", mapping),
                [("client_alpha", "client_alpha - PH.TTK.222")],
            )
            self.assertEqual(
                resolve_seller_matches("MY.TTK.333", mapping),
                [
                    ("client_beta", "client_beta - MY.TTK.333"),
                    ("client_gamma", "client_beta - MY.TTK.333"),
                ],
            )
            self.assertEqual(
                resolve_seller_matches("VN.TTK.999", mapping),
                [("Unmapped", "VN.TTK.999")],
            )

    def test_missing_xlsx_returns_empty_mapping(self) -> None:
        mapping = load_seller_mapping(Path("nonexistent_seller_list.xlsx"))
        self.assertEqual(mapping, {})
        self.assertEqual(
            resolve_seller_matches("MY.TTK.111", mapping),
            [("Unmapped", "MY.TTK.111")],
        )
