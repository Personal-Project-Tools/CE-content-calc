# TikTok Content Report Automation & Calculator — User Guide

This guide covers the complete daily operational workflow for end users: one-time initial machine setup, automated report downloading from TikTok Seller Center, metric aggregation into a consolidated Excel workbook mapped against your internal Google Sheet, and disk cleanup for old daily reports.

---

## 3-Step Workflow Overview

| Step | Tool Used | Action | Output |
|---|---|---|---|
| **Step 1** | Chrome Extension (**TikTok Content Calc**) | Select shop → choose Single Day or Month → run auto export | Up to 4 raw report files automatically saved to `data\raw_file\Daily\<Date>\<Seller ID>\` or `data\raw_file\Monthly\<Month>\<Seller ID>\` |
| **Step 2** | Terminal (`calculate_reports.py`) | Run aggregation command & auto-map Clients via Google Sheets | Consolidated Excel workbook exported to `data\reports\tiktok_content_metrics.xlsx` (one sheet per date/month) |
| **Step 3** | Terminal (`delete_reports.py`) | Delete old daily folders inside `data\raw_file\Daily\` by date range | Frees local disk space while preserving the consolidated Excel report |

---

## Part 1: One-Time Initial Setup (New Machine Only)

### 1.1. Disable Chrome's "Ask where to save each file" prompt
To allow continuous background downloading without `Save As` dialog interruptions:
1. Open Google Chrome and navigate to: `chrome://settings/downloads`
2. Locate **Ask where to save each file before downloading**.
3. **Turn OFF** this toggle.

### 1.2. Link Chrome Downloads to `data\raw_file\` and Extension Config
Run `scripts\setup-reports-junction.bat` (double-click the file or run it from Terminal inside the project root):

```powershell
.\scripts\setup-reports-junction.bat
```

* What it does:
  1. Creates a Windows directory junction routing `%USERPROFILE%\Downloads\CE-Reports` directly into `data\raw_file\` (and automatically creates `Daily\` and `Monthly\` subfolders). If `Downloads\CE-Reports` already existed with previous files, it automatically migrates them into `data\raw_file\` before creating the link.
  2. Links `extension\config` to `config\` so the Chrome Extension can read your Google Sheets configuration directly.

### 1.3. Install the Chrome Extension
1. Open Chrome and navigate to: `chrome://extensions`
2. Turn ON **Developer mode** in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the **`extension`** folder inside this project (`...\CE-content-calc\extension`).
5. Click the puzzle icon on Chrome's toolbar and **Pin** **TikTok Content Calc** for quick access.

> **Note:** Whenever you pull new project updates, open `chrome://extensions` and click the **Reload (🔄)** icon on the **TikTok Content Calc** card.

### 1.4. Install Python Requirements & Configure Google Sheets Connection
To protect client data privacy, `Clients <-> Seller ID` mapping is not stored in Git. Instead, it is fetched directly from your internal Google Sheet using a Google Service Account:

1. Install the required Python packages (`Python >= 3.11`):
   ```powershell
   pip install -r requirements.txt
   ```
2. Place your Google Service Account JSON key inside `config\service_account.json` (or `config\service.json`). Make sure the internal Google Sheet grants **Viewer** access to the `client_email` inside that JSON key.
3. Create `config\sheet.yaml` from [config/sheet.example.yaml](config/sheet.example.yaml) and fill in your actual `spreadsheet_id`:
   ```yaml
   sheet:
     credentials_file: "config/service_account.json"
     spreadsheet_id: "<YOUR_GOOGLE_SPREADSHEET_ID>"
     worksheet: "seller_scope"
     ranges:
       seller_full_match: "AV4:AV"  # Format: <company> - <COUNTRY>.TTK.<SELLER_ID>
       seller_used_id: "AW4:AW"     # Format: <COUNTRY>.TTK.<SELLER_ID>
       active_status: "I4:I"        # Active selling status (TRUE / FALSE)
     filters:
       platform: "TTK"
       active_only: true            # Only match rows where active_status == TRUE
   ```

---

## Part 2: Step 1 — Download Reports from TikTok Seller Center

### 1. Open the Target Shop on TikTok Seller Center
1. Sign in to TikTok Seller Center (or Tokopedia Seller Center for `ID`) in Chrome and select the shop you want to export.
2. Click the **TikTok Content Calc** extension icon on the Chrome toolbar.
3. Verify the Seller card at the top of the popup:
   * Displays the matched **`Client:`** name from Google Sheets (`Unmapped` if not listed/active on the Sheet) and the standardized Seller ID `<COUNTRY>.TTK.<SELLER_ID>` (with a **Copy** button).
   * If you see **`No Seller ID Detected`**: click **Open TikTok Seller Center** (or switch to your open Seller Center tab and wait for it to finish loading), then click **Refresh**.

### 2. Choose Task Mode & Period (`1. Task Mode & Period`)
Select one of the two reporting modes:
* **`Single Day (Daily)`**: Exports reports for **one specific date**. Pick your target date in the date input below.
* **`Month (Monthly)`**: Exports reports for **an entire month** (automatically selects the full month on the calendar). Pick your target year/month in the month input below.

### 3. Start Automated Export (`2. Export Reports`)
* Click **`▶ Auto Export All 4 Reports`** *(Recommended)* to automatically export all 4 reports in the background for the selected shop and period:
  1. `1_LIVE_Linked.xlsx` — `LIVE -> Details`, `Linked accounts` tab
  2. `2_LIVE_Affiliate.xlsx` — `LIVE -> Details`, `Affiliate accounts` tab
  3. `3_Video_Linked.xlsx` — `Video -> Details`, `Linked accounts` tab
  4. `4_Video_Affiliate.xlsx` — `Video -> Details`, `Affiliate accounts` tab
* Alternatively, click **`Export LIVE Reports`** (only the 2 LIVE files) or **`Export Video Reports`** (only the 2 Video files) if you only need to re-download a single channel.

> **Notes While Running:**
> * The export runs unattended in a pinned background tab — you can freely switch to other tabs or applications while it runs.
> * **Do not close Chrome** and **do not log out of Seller Center** until the popup status bar displays `✓ Completed: ... exported!`.

### 4. Verify Downloaded Raw Files
Downloaded files are automatically organized into `Daily` or `Monthly` folders under `data\raw_file\`:
* Single Day mode (`Single Day (Daily)`): `data\raw_file\Daily\<YYYY-MM-DD>\<SELLER_ID>\`
* Monthly mode (`Month (Monthly)`): `data\raw_file\Monthly\<YYYY-MM>\<SELLER_ID>\`

Example for date `2026-11-18` (Daily) and month `2026-10` (Monthly) of shop `MY.TTK.1000000000000000001`:

```text
data/
└── raw_file/
    ├── Daily/
    │   └── 2026-11-18/
    │       └── MY.TTK.1000000000000000001/
    │           ├── 1_LIVE_Linked.xlsx
    │           ├── 2_LIVE_Affiliate.xlsx
    │           ├── 3_Video_Linked.xlsx
    │           └── 4_Video_Affiliate.xlsx
    └── Monthly/
        └── 2026-10/
            └── MY.TTK.1000000000000000001/
                ├── 1_LIVE_Linked.xlsx
                ├── 2_LIVE_Affiliate.xlsx
                ├── 3_Video_Linked.xlsx
                └── 4_Video_Affiliate.xlsx
```

* Repeat the steps (switch Shop → verify Date/Month → click **`▶ Auto Export All 4 Reports`**) for your remaining shops.
* The **`Clear Data`** button at the bottom of the popup clears temporary UI state in the popup without deleting any downloaded `.xlsx` files on disk.

---

## Part 3: Step 2 — Calculate Metrics & Export Consolidated Excel

Once you have downloaded reports for all required shops and dates/months:

1. Open **Terminal** (or **PowerShell**) in the project root directory (`CE-content-calc`).
2. Run:

```powershell
python scripts\calculate_reports.py
```

*(Optional custom flags)* You can override the raw files directory, Google Sheet config path, or output Excel file path:

```powershell
python scripts\calculate_reports.py --reports-dir <raw_file_dir> --sheet-config config\sheet.yaml --output <output_xlsx_path>
```

### Output Excel Structure
The consolidated workbook is saved to: **`data\reports\tiktok_content_metrics.xlsx`**

* **Sheet layout:** Each date (`YYYY-MM-DD`) or month (`YYYY-MM`) found under `data\raw_file\Daily\` and `data\raw_file\Monthly\` is written to **its own worksheet** (e.g., `2026-11-16`, `2026-11-18`, `2026-10`). Each sheet contains **all Seller IDs** downloaded for that period.
* **Columns in each worksheet:**

| Column | Description |
|---|---|
| **`Clients`** | Client name (`<company>`) extracted from `seller_full_match` (`AV4:AV`) on the `seller_scope` Google Sheet tab. Shows `Unmapped` if not found or inactive. |
| **`Seller ID`** | Full Seller ID label (`<company> - <COUNTRY>.TTK.<SELLER_ID>`) from column `AV4:AV` (or the raw `<COUNTRY>.TTK.<SELLER_ID>` folder name if `Unmapped`). |
| **`Date`** | Reporting date or month (`YYYY-MM-DD` or `YYYY-MM`). |
| **`Content Type`** | Two rows per seller per period: **`TikTok Content Live`** and **`TikTok Content Video`**. |
| **`revenue`** | Total GMV: LIVE sums `LIVE-attributed GMV` across both LIVE files; Video sums `Video-attributed GMV` across both Video files. |
| **`product_impression`** | Total `Product Impressions` summed across the 2 files of the same channel (LIVE or Video). |
| **`impression`** | Total views: LIVE sums `Views` across both LIVE files; Video sums `Video views` (`Video Views` / `VV`) across both Video files. |

---

## Part 4: Step 3 — Clean Up Old Daily Reports to Free Disk Space

Over time, downloaded files in `data\raw_file\Daily\` can consume significant disk space. You can bulk-delete daily report folders across an inclusive date range (`YYYY-MM-DD`).

### 1. Preview folders to be deleted (Recommended first step)
```powershell
python scripts\delete_reports.py --start '2026-11-15' --end '2026-11-18' --dry-run
```
`--dry-run` **only lists the matching date folders** and file sizes without deleting anything.

### 2. Permanently delete the date range
Once you have verified the target dates, run the command without `--dry-run`:
```powershell
python scripts\delete_reports.py --start '2026-11-15' --end '2026-11-18'
```

> **Note:**
> * This command deletes `YYYY-MM-DD` folders between `--start` and `--end` (inclusive) inside `data\raw_file\Daily\`.
> * Consolidated reports in `data\reports\` and monthly folders in `data\raw_file\Monthly\` are **never** touched by this command.

---

## Part 5: Common Scenarios & Troubleshooting

### 1. A shop folder has fewer than 4 files (only 1, 2, or 3 files)
* **Cause:** On TikTok Seller Center for that date/month, one or more tabs (such as `Affiliate accounts`) displayed **`No available data yet`** with the `Export` button disabled.
* **Resolution:** This is normal behavior. The extension automatically skips empty tabs and continues exporting the remaining tabs without interruption. When running `calculate_reports.py`, missing tabs/channels are safely calculated as `0`.

### 2. Extension shows `Platform do not have Content Video report for YYYY-MM-DD` or `Platform do not have Content LIVE report for YYYY-MM-DD`
* **Cause:** The target date or month is disabled/unavailable on TikTok Seller Center's calendar for that channel.
* **Resolution:** Double-check the selected date/month in the popup or open Seller Center directly to verify whether data for that date has been published by TikTok yet.

### 3. Extension warns `⚠️ Please click Reload (🔄) on chrome://extensions to activate Reports/ folder routing.` or files download into `Downloads` instead of `data\raw_file\`
* **Resolution:**
  1. Open `chrome://extensions` and click **Reload (🔄)** on **TikTok Content Calc**.
  2. Make sure you have run `.\scripts\setup-reports-junction.bat` at least once.
  3. Confirm that *Ask where to save each file before downloading* is turned **OFF** in `chrome://settings/downloads`.

### 4. `Client` in the popup or `Clients` column in Excel shows `Unmapped`
* **Cause:** The shop's Seller ID is not listed in the `seller_scope` tab of your internal Google Sheet (`AV4:AV` / `AW4:AW`), or its active status in column `I` (`I4:I`) is set to `FALSE`.
* **Resolution:** Add the shop to the `seller_scope` Google Sheet tab (and ensure column `I` is `TRUE`), then click **Refresh** in the extension popup or re-run `python scripts\calculate_reports.py`.

### 5. Popup shows `No Seller ID Detected`
* **Resolution:** Ensure you are logged in to TikTok Seller Center in Chrome, click **Open TikTok Seller Center** (or switch to your active Seller Center tab), wait for the page to finish loading, and click **Refresh** in the popup.
