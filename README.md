# CE-content-calc

TikTok Shop **LIVE & Video Details** Chrome Extension (Manifest V3) for automated report downloading, paired with a zero-dependency Python pipeline for Seller ID -> Client mapping, metric calculation (`revenue`, `product_impression`, `impression`), and date-range storage cleanup.

---

## 1. Repository Structure

```text
CE-content-calc/
├── config/
│   └── seller_list.xlsx                 # Master Client <-> Seller ID mapping table
├── data/
│   ├── reports/                         # Downloaded TikTok reports: {YYYY-MM-DD}/{SellerID}/*.xlsx
│   └── results/                         # Generated Excel output: tiktok_content_metrics.xlsx
├── extension/                           # Unpacked Chrome Extension root (Load unpacked here)
│   ├── manifest.json                    # Manifest V3 config
│   ├── assets/icons/                    # Extension toolbar icons
│   └── src/
│       ├── background/service_worker.js # Background tab orchestration & Downloads routing
│       ├── content/content.js           # Calendar selection, empty-tab handling & Export retry
│       ├── content/injected.js          # MAIN-world fetch/XHR hook (seller ID & export task API)
│       └── popup/popup.{html,css,js}    # Extension popup UI
├── scripts/
│   ├── setup-reports-junction.bat       # Creates Downloads\CE-Reports -> data\reports junction
│   ├── calculate_reports.py             # CLI wrapper: calculate metrics -> data/results/
│   └── delete_reports.py                # CLI wrapper: delete YYYY-MM-DD folders in data/reports/
├── src/ce_content_calc/                 # Modular Python package (src layout, zero external deps)
│   ├── config.py                        # Paths, content labels & column mapping rules
│   ├── xlsx_io.py                       # Pure-Python OpenXML reader & multi-sheet writer
│   ├── seller_mapping.py                # seller_list.xlsx parser (forward-fill) & resolver
│   ├── calculator.py                    # Report classification & date-grouped metric aggregation
│   ├── cleanup.py                       # Safe date-range directory deletion
│   └── cli.py                           # CLI subcommands & wrappers
├── tests/                               # Unit test suite (python -m unittest)
├── pyproject.toml
└── .gitignore
```

---

## 2. Setup Chrome Extension & Reports Folder Junction

1. **Link `Downloads\CE-Reports` to `data\reports\`** (run once on Windows):
   ```powershell
   scripts\setup-reports-junction.bat
   ```
   All exports saved by Chrome to `Downloads/CE-Reports/{YYYY-MM-DD}/{SellerID}/` automatically land inside `data/reports/{YYYY-MM-DD}/{SellerID}/`.

2. **Load Chrome Extension**:
   - Open `chrome://extensions/` and enable **Developer mode**.
   - Click **Load unpacked** and select the **`extension/`** directory (`CE-content-calc\extension`).

---

## 3. CLI Usage

All Python commands run directly with `.venv` (zero external pip dependencies required):

### Calculate Metrics (`data/results/tiktok_content_metrics.xlsx`)
Scans `data/reports/{date}/{seller_id}/*.xlsx`, maps sellers via `config/seller_list.xlsx`, computes `revenue`, `product_impression`, and `impression` for `TikTok Content Live` and `TikTok Content Video`, and writes one worksheet per date:

```powershell
.\.venv\Scripts\python.exe scripts\calculate_reports.py
```

Optional flags: `--reports-dir`, `--seller-list`, `--output`.

### Delete Old Report Dates (`data/reports/{YYYY-MM-DD}/`)
Preview matching folders first (`--dry-run`), or delete an inclusive `YYYY-MM-DD` range:

```powershell
.\.venv\Scripts\python.exe scripts\delete_reports.py --start '2026-11-15' --end '2026-11-18' --dry-run
.\.venv\Scripts\python.exe scripts\delete_reports.py --start '2026-11-15' --end '2026-11-18'
```

*(Alternatively, with `PYTHONPATH=src` or after `pip install -e .`, run `python -m ce_content_calc calculate` / `python -m ce_content_calc delete ...`.)*

---

## 4. Running Tests

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```
