# TikTok Shop Calculator & Seller ID Chrome Extension (Manifest V3)

A Chrome extension that automatically detects TikTok Shop accounts, standardizes the `seller_id` format (`country.TTK.seller`), and prepares report calculations (GMV, items sold, and conversion metrics).

## 1. Data Extraction & Formatting Rule
Based on DevTools network inspection and the `/api/v1/seller/workbench/get_all_sellers` endpoint:
* **seller**: Key from `data.sellers_data` (e.g., `7495489135139195356`)
* **country**: `data.sellers_data.<seller>.global_seller.base_region` (e.g., `VN` or `MY`)
* **Standardized seller_id**: `{country}.TTK.{seller}` $\rightarrow$ e.g., **`VN.TTK.7495489135139195356`**

## 2. Architecture
* **`injected.js` (MAIN world)**: Runs at `document_start`, hooks into `window.fetch` and `XMLHttpRequest` to capture the `/api/v1/seller/workbench/get_all_sellers` response directly.
* **`content.js` (ISOLATED world)**: Bridges communication with extension runtime and silently passes captured data into storage without altering or cluttering the page DOM.
* **`background.js` (Service Worker)**: Manages extension state in `chrome.storage.local` and updates the toolbar badge with the country code.
* **`popup.html / popup.js / popup.css`**: Streamlined popup UI strictly following **Modern Web Guidance** (accessible copy button with Invoker Commands, live region status announcements, and dark/light mode).

## 3. Installation in Google Chrome
1. Open Google Chrome and navigate to:
   ```
   chrome://extensions/
   ```
2. Enable **Developer mode** at the top right.
3. Click **Load unpacked**.
4. Select the project folder:
   ```
   E:\ada_tools\Extension_Cal_Content
   ```
5. Pin the extension to your browser toolbar for quick access.

## 4. Usage
1. Open any TikTok Shop Seller Center page: `https://seller-<country>.tiktok.com/` (e.g., Vietnam, Malaysia, US).
2. The extension automatically detects the shop and copies/displays the standardized `seller_id`.
3. Click the extension icon to view the shop name, country badge, and 1-click copy the standardized ID.
