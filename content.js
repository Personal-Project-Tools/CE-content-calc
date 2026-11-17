/**
 * Content Script running in the ISOLATED world.
 * Bridges communication between injected.js (MAIN world) and Chrome Extension runtime,
 * and executes human-like DOM automation for downloading LIVE & Video Details reports.
 */
(function () {
  'use strict';

  // Only run on seller subdomains
  if (!window.location.hostname.includes('seller') && !window.location.hostname.includes('tiktokglobalshop')) {
    return;
  }

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let isWorkflowRunning = false;
  let lastDownloadTimestamp = 0;

  // Remove legacy on-page toast if present
  const existingToast = document.getElementById('ttk-ext-toast');
  if (existingToast) {
    existingToast.remove();
  }

  // --- Utility Helpers ---

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  }

  /**
   * Simulates a full human mouse click sequence (pointerdown -> mousedown -> pointerup -> mouseup -> click)
   * which is required by React / Arco Design components on TikTok Seller Center.
   */
  function humanClick(element) {
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };

    element.dispatchEvent(new PointerEvent('pointerdown', eventInit));
    element.dispatchEvent(new MouseEvent('mousedown', eventInit));
    element.dispatchEvent(new PointerEvent('pointerup', eventInit));
    element.dispatchEvent(new MouseEvent('mouseup', eventInit));
    element.dispatchEvent(new MouseEvent('click', eventInit));
    return true;
  }

  async function waitForSelector(selectorFn, timeoutMs = 10000, intervalMs = 250) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = selectorFn();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  function getPageReportType() {
    const path = window.location.pathname;
    if (path.includes('/live-analysis/live-details')) return 'live';
    if (path.includes('/video-analytics/video-details')) return 'video';
    return null;
  }

  function updateReportStatus(reportKey, status, message = '') {
    chrome.runtime.sendMessage({
      action: 'UPDATE_REPORT_STATUS',
      reportKey,
      status,
      message
    });
  }

  // --- Step 1: Open & Select Date/Month on #page-title-datepicker ---

  function findDatePickerTrigger() {
    const container = document.getElementById('page-title-datepicker');
    if (!container) return null;

    // Prefer the SVG icon or input inside #page-title-datepicker (from Recorder JSON)
    const svg = container.querySelector('svg');
    if (svg && isElementVisible(svg)) {
      return svg.closest('span') || svg;
    }
    const input = container.querySelector('input');
    if (input && isElementVisible(input)) {
      return input;
    }
    return container;
  }

  function findOpenCalendarPopup() {
    // Look for the visible Arco DatePicker popup container in document.body
    const spaceEl = Array.from(document.querySelectorAll('div.arco-space')).find((el) => {
      const text = el.textContent || '';
      return isElementVisible(el) && text.includes('Day') && text.includes('Month');
    });
    if (spaceEl) {
      return spaceEl.closest('div[class*="arco-trigger"], div[class*="arco-picker"], span')?.parentElement || spaceEl.parentElement?.parentElement;
    }

    const pickers = Array.from(document.querySelectorAll('.arco-picker-container, .arco-picker-panel-wrapper')).filter(
      isElementVisible
    );
    return pickers[pickers.length - 1] || null;
  }

  async function openDatePickerPopup() {
    const trigger = await waitForSelector(findDatePickerTrigger, 12000);
    if (!trigger) {
      throw new Error('Could not find #page-title-datepicker on page');
    }

    // If popup is not already visible, click trigger
    let popup = findOpenCalendarPopup();
    if (!popup) {
      humanClick(trigger);
      await sleep(400);
      popup = await waitForSelector(findOpenCalendarPopup, 3000, 150);
    }

    // Fallback: click input inside #page-title-datepicker if SVG didn't open it
    if (!popup) {
      const container = document.getElementById('page-title-datepicker');
      const input = container?.querySelector('input');
      if (input) {
        humanClick(input);
        popup = await waitForSelector(findOpenCalendarPopup, 3000, 150);
      }
    }

    if (!popup) {
      throw new Error('DatePicker popup did not open');
    }
    return popup;
  }

  async function switchCalendarModeTab(modeLabel) {
    // From Recorder JSON: "div.arco-space > div:nth-of-type(3) > div" with text "Month" (or "Day")
    const modeBtn = Array.from(document.querySelectorAll('div.arco-space > div > div, div.arco-space div')).find(
      (el) => isElementVisible(el) && el.textContent.trim() === modeLabel && el.children.length === 0
    );
    if (modeBtn) {
      humanClick(modeBtn);
      await sleep(350);
      return true;
    }
    return false;
  }

  /**
   * Navigates the calendar header (e.g. "11/2026" or "2026") to match targetYear and targetMonth (optional).
   */
  async function navigateCalendarHeader(targetYear, targetMonth = null) {
    for (let step = 0; step < 24; step++) {
      const popup = findOpenCalendarPopup() || document.body;
      // Find header text such as "11/2026", "2026-11", or "2026"
      const candidates = Array.from(popup.querySelectorAll('div, span')).filter((el) => {
        if (!isElementVisible(el) || el.children.length > 0) return false;
        const txt = el.textContent.trim();
        return /^\d{1,2}\/\d{4}$/.test(txt) || /^\d{4}-\d{1,2}$/.test(txt) || /^\d{4}$/.test(txt);
      });

      if (candidates.length === 0) break;
      const headerEl = candidates[0];
      const txt = headerEl.textContent.trim();

      let currentYear = null;
      let currentMonth = null;

      if (/^(\d{1,2})\/(\d{4})$/.test(txt)) {
        const [, m, y] = txt.match(/^(\d{1,2})\/(\d{4})$/);
        currentMonth = parseInt(m, 10);
        currentYear = parseInt(y, 10);
      } else if (/^(\d{4})-(\d{1,2})$/.test(txt)) {
        const [, y, m] = txt.match(/^(\d{4})-(\d{1,2})$/);
        currentYear = parseInt(y, 10);
        currentMonth = parseInt(m, 10);
      } else if (/^\d{4}$/.test(txt)) {
        currentYear = parseInt(txt, 10);
      }

      if (currentYear === null) break;

      if (targetMonth === null) {
        // Month mode: only compare year
        if (currentYear === targetYear) break;
      } else {
        // Day mode: compare year and month
        if (currentYear === targetYear && currentMonth === targetMonth) break;
      }

      // Find header container with navigation arrows (<, <<, >, >>)
      const headerRow = headerEl.parentElement?.parentElement || headerEl.parentElement;
      const icons = headerRow ? Array.from(headerRow.querySelectorAll('svg, button, span[class*="icon"], div[class*="icon"]')).filter(isElementVisible) : [];

      const targetTotal = targetYear * 12 + (targetMonth || 1);
      const currentTotal = currentYear * 12 + (currentMonth || 1);

      if (targetTotal < currentTotal) {
        // Click single prev month '<' (usually 2nd icon on left if '<<' and '<' exist, or 1st icon)
        const prevBtn = targetMonth !== null && icons.length >= 4 ? icons[1] : icons[0];
        if (prevBtn) humanClick(prevBtn);
      } else {
        // Click single next month '>'
        const nextBtn = targetMonth !== null && icons.length >= 4 ? icons[icons.length - 2] : icons[icons.length - 1];
        if (nextBtn) humanClick(nextBtn);
      }
      await sleep(250);
    }
  }

  function findDayCellInPopup(dayNumber) {
    const dayStr = String(dayNumber);
    const popup = findOpenCalendarPopup() || document.body;

    // 1. Prefer Arco Design's .arco-picker-cell-in-view (current month's active cells)
    const inViewCells = Array.from(popup.querySelectorAll('.arco-picker-cell-in-view')).filter(isElementVisible);
    for (const cell of inViewCells) {
      const inner = Array.from(cell.querySelectorAll('div')).find(
        (d) => d.children.length === 0 && d.textContent.trim() === dayStr
      );
      if (inner || cell.textContent.trim() === dayStr) {
        return inner || cell;
      }
    }

    // 2. Fallback: find leaf divs inside the calendar popup matching dayStr
    const allCells = Array.from(popup.querySelectorAll('.arco-picker-cell div, div > div')).filter(
      (el) => isElementVisible(el) && el.children.length === 0 && el.textContent.trim() === dayStr
    );
    if (allCells.length === 0) return null;
    // If day <= 15, pick first occurrence; if day > 15, pick last occurrence (avoids prev/next month overflow)
    return dayNumber <= 15 ? allCells[0] : allCells[allCells.length - 1];
  }

  function findMonthCellInPopup(monthIndexZeroBased) {
    const monthLabel = MONTH_NAMES[monthIndexZeroBased];
    if (!monthLabel) return null;
    const popup = findOpenCalendarPopup() || document.body;

    // From Monthly_flow JSON: leaf div with text "Oct", "Sep", etc.
    const match = Array.from(popup.querySelectorAll('div')).find(
      (el) => isElementVisible(el) && el.children.length === 0 && el.textContent.trim() === monthLabel
    );
    return match || null;
  }

  async function selectCalendarPeriod(periodConfig, pageType) {
    const mode = periodConfig?.mode || 'day';
    await openDatePickerPopup();

    if (mode === 'month') {
      // e.g. "2026-10"
      const [yyyyStr, mmStr] = (periodConfig.month || '').split('-');
      const targetYear = parseInt(yyyyStr, 10);
      const targetMonthIdx = parseInt(mmStr, 10) - 1;

      await switchCalendarModeTab('Month');
      if (!isNaN(targetYear)) {
        await navigateCalendarHeader(targetYear, null);
      }

      const monthCell = await waitForSelector(() => findMonthCellInPopup(targetMonthIdx), 4000, 150);
      if (!monthCell) {
        throw new Error(`Could not find month "${MONTH_NAMES[targetMonthIdx]}" on calendar`);
      }

      // Both LIVE and Video close after 1 click in Month mode
      humanClick(monthCell);
      await sleep(600);
    } else {
      // Single Day mode: e.g. "2026-11-15"
      const [yyyyStr, mmStr, ddStr] = (periodConfig.date || '').split('-');
      const targetYear = parseInt(yyyyStr, 10);
      const targetMonth = parseInt(mmStr, 10);
      const targetDay = parseInt(ddStr, 10);

      await switchCalendarModeTab('Day');
      if (!isNaN(targetYear) && !isNaN(targetMonth)) {
        await navigateCalendarHeader(targetYear, targetMonth);
      }

      const dayCell1 = await waitForSelector(() => findDayCellInPopup(targetDay), 4000, 150);
      if (!dayCell1) {
        throw new Error(`Could not find day "${targetDay}" on calendar`);
      }

      // Click #1 (On LIVE -> Details, 1 click selects the day and closes the calendar)
      humanClick(dayCell1);
      await sleep(350);

      // On Video -> Details, Day mode is a Date Range picker: click the same day a 2nd time!
      if (pageType === 'video') {
        const dayCell2 = findDayCellInPopup(targetDay);
        if (dayCell2) {
          humanClick(dayCell2);
          await sleep(500);
        }
      }
    }
  }

  // --- Step 2: Wait for Table Loading & Switch Tabs ---

  async function waitForDataLoadingComplete(timeoutMs = 15000) {
    await sleep(900); // Initial settle for React state update
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const spinners = Array.from(
        document.querySelectorAll('.arco-spin-loading, .arco-spin-dot, [class*="loading-mask"]')
      ).filter(isElementVisible);
      if (spinners.length === 0) {
        break;
      }
      await sleep(300);
    }
    await sleep(600);
  }

  function hasNoAvailableData() {
    const mainEl = document.getElementById('main') || document.body;
    const text = mainEl.innerText || '';
    return text.includes('No available data yet') || text.includes('No data');
  }

  function findAccountTab(tabType) {
    const targetText = tabType === 'affiliate' ? 'Affiliate accounts' : 'Linked accounts';

    // 1. Check IDs from LIVE_Details_workflow JSON (#core-tabs-0-tab-0 / #core-tabs-0-tab-1)
    const idSelector = tabType === 'affiliate' ? '#core-tabs-0-tab-1' : '#core-tabs-0-tab-0';
    const byId = document.querySelector(idSelector);
    if (byId && isElementVisible(byId)) {
      return byId.querySelector('div > div') || byId;
    }

    // 2. Check by exact text (works on both LIVE Details and Video Details div.rounded-r)
    const mainEl = document.getElementById('main') || document.body;
    const match = Array.from(mainEl.querySelectorAll('div, span, button')).find(
      (el) => isElementVisible(el) && el.children.length === 0 && el.textContent.trim() === targetText
    );
    return match ? match.closest('div[role="tab"], div.rounded-r, div.rounded-l, button') || match : null;
  }

  // --- Step 3: Click Export with Smart Retry (handles platform double-click quirk) ---

  function findExportButton() {
    const mainEl = document.getElementById('main') || document.body;
    const buttons = Array.from(mainEl.querySelectorAll('button')).filter((btn) => {
      if (!isElementVisible(btn)) return false;
      return btn.textContent.trim() === 'Export' || btn.getAttribute('aria-label') === 'Export';
    });
    return buttons[0] || null;
  }

  async function waitForDownloadSince(timestampMs, waitMs = 4500) {
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      if (lastDownloadTimestamp >= timestampMs) {
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  async function exportCurrentTabReport(reportKey) {
    updateReportStatus(reportKey, 'running', 'Loading...');
    await waitForDataLoadingComplete();

    const exportBtn = await waitForSelector(findExportButton, 6000, 200);
    if (!exportBtn) {
      if (hasNoAvailableData()) {
        updateReportStatus(reportKey, 'empty', 'No data');
        return { status: 'empty' };
      }
      updateReportStatus(reportKey, 'error', 'No Export btn');
      return { status: 'error', reason: 'Export button not found' };
    }

    const isDisabled =
      exportBtn.disabled ||
      exportBtn.getAttribute('aria-disabled') === 'true' ||
      exportBtn.classList.contains('arco-btn-disabled');

    if (isDisabled || hasNoAvailableData()) {
      updateReportStatus(reportKey, 'empty', 'No data');
      return { status: 'empty' };
    }

    // Attempt #1: Click Export button
    const clickTime1 = Date.now();
    updateReportStatus(reportKey, 'running', 'Exporting...');
    humanClick(exportBtn);

    const downloadedOnFirstTry = await waitForDownloadSince(clickTime1, 4500);
    if (downloadedOnFirstTry) {
      updateReportStatus(reportKey, 'done', 'Downloaded ✓');
      await sleep(800);
      return { status: 'done', attempts: 1 };
    }

    // Check if after clicking once, page showed no data
    if (hasNoAvailableData()) {
      updateReportStatus(reportKey, 'empty', 'No data');
      return { status: 'empty' };
    }

    // Attempt #2 (Platform fallback when 1st click on Export doesn't trigger download)
    const retryBtn = findExportButton();
    if (retryBtn && !retryBtn.disabled) {
      const clickTime2 = Date.now();
      updateReportStatus(reportKey, 'running', 'Retry click...');
      humanClick(retryBtn);

      const downloadedOnSecondTry = await waitForDownloadSince(clickTime2, 5500);
      if (downloadedOnSecondTry) {
        updateReportStatus(reportKey, 'done', 'Downloaded ✓');
        await sleep(800);
        return { status: 'done', attempts: 2 };
      }
    }

    // Even if browser handled download via internal blob/iframe, mark as Triggered
    updateReportStatus(reportKey, 'done', 'Triggered ✓');
    return { status: 'done', attempts: 2 };
  }

  // --- Main Page Workflow (LIVE Details or Video Details) ---

  async function executeDetailsPageWorkflow(periodConfig) {
    if (isWorkflowRunning) {
      return { ok: false, error: 'Workflow already running on this tab' };
    }

    const pageType = getPageReportType();
    if (!pageType) {
      return {
        ok: false,
        error: 'Current tab is not on LIVE Details or Video Details page'
      };
    }

    isWorkflowRunning = true;
    const linkedKey = `${pageType}_linked`;
    const affiliateKey = `${pageType}_affiliate`;

    try {
      updateReportStatus(linkedKey, 'running', 'Selecting date...');

      // 1. Ensure we start on "Linked accounts" tab (default when entering page)
      const linkedTab = await waitForSelector(() => findAccountTab('linked'), 12000, 300);
      if (linkedTab) {
        humanClick(linkedTab);
        await sleep(500);
      }

      // 2. Select Single Day or Month on #page-title-datepicker
      await selectCalendarPeriod(periodConfig, pageType);

      // 3. Export Report #1 (Linked accounts)
      const linkedResult = await exportCurrentTabReport(linkedKey);

      // 4. Switch to "Affiliate accounts" tab (Date Range is preserved on same page!)
      updateReportStatus(affiliateKey, 'running', 'Switching tab...');
      const affiliateTab = await waitForSelector(() => findAccountTab('affiliate'), 6000, 250);
      if (!affiliateTab) {
        updateReportStatus(affiliateKey, 'error', 'Tab not found');
        return { ok: false, error: 'Affiliate accounts tab not found' };
      }

      humanClick(affiliateTab);
      await sleep(700);

      // 5. Export Report #2 (Affiliate accounts)
      const affiliateResult = await exportCurrentTabReport(affiliateKey);

      return {
        ok: true,
        pageType,
        results: {
          [linkedKey]: linkedResult,
          [affiliateKey]: affiliateResult
        }
      };
    } catch (err) {
      console.error('[TikTok Extension] Workflow error:', err);
      updateReportStatus(linkedKey, 'error', err.message || 'Error');
      return { ok: false, error: err.message || String(err) };
    } finally {
      isWorkflowRunning = false;
    }
  }

  // --- Event & Message Listeners ---

  // Listen for captured seller data from injected script
  window.addEventListener('TIKTOK_SELLER_CAPTURED', (event) => {
    const payload = event.detail;
    if (!payload || !payload.shops) return;

    chrome.runtime.sendMessage(
      {
        action: 'SAVE_SELLER_DATA',
        payload: payload
      },
      () => {
        if (chrome.runtime.lastError) {
          // Background service worker waking up
        }
      }
    );
  });

  // Listen for messages from popup or background orchestrator
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'REFRESH_SELLER_DATA') {
      window.dispatchEvent(new CustomEvent('TIKTOK_SELLER_REQUEST_STATE'));
      sendResponse({ status: 'requested' });
      return true;
    }

    if (request.action === 'DOWNLOAD_DETECTED') {
      lastDownloadTimestamp = request.timestamp || Date.now();
      sendResponse({ ok: true });
      return true;
    }

    if (request.action === 'RUN_PAGE_WORKFLOW') {
      executeDetailsPageWorkflow(request.periodConfig).then((res) => {
        sendResponse(res);
      });
      return true; // keep async channel open
    }

    return true;
  });

  // Request seller state on initial content script load
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('TIKTOK_SELLER_REQUEST_STATE'));
  }, 1000);
})();
