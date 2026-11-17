/**
 * Content Script running in the ISOLATED world.
 * Bridges communication between injected.js (MAIN world) and Chrome Extension runtime,
 * and executes human-like DOM + XPath automation for downloading LIVE & Video Details reports.
 */
(function () {
  'use strict';

  // Prevent duplicate listener registration if re-injected via chrome.scripting
  if (window.__TTK_CONTENT_SCRIPT_LOADED__) {
    return;
  }
  window.__TTK_CONTENT_SCRIPT_LOADED__ = true;

  // Only run on seller subdomains
  if (!window.location.hostname.includes('seller') && !window.location.hostname.includes('tiktokglobalshop')) {
    return;
  }

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let isWorkflowRunning = false;
  let lastDownloadTimestamp = 0;
  let lastExportTaskCreatedTimestamp = 0;

  // Remove legacy on-page toast if present
  const existingToast = document.getElementById('ttk-ext-toast');
  if (existingToast) {
    existingToast.remove();
  }

  // --- Utility & XPath Helpers ---

  /**
   * Sleeps via background service worker timer so inactive background tabs
   * are not throttled to 1s+ timer ticks by Chrome.
   */
  function sleep(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const fallbackTimer = setTimeout(done, ms + 1500);
      try {
        chrome.runtime.sendMessage({ action: 'BACKGROUND_SLEEP', ms }, (res) => {
          if (chrome.runtime.lastError || !res?.ok) {
            clearTimeout(fallbackTimer);
            setTimeout(done, ms);
            return;
          }
          clearTimeout(fallbackTimer);
          done();
        });
      } catch {
        clearTimeout(fallbackTimer);
        setTimeout(done, ms);
      }
    });
  }

  function logStep(text, isError = false) {
    console.log(`[TikTok Extension] ${isError ? 'ERROR: ' : ''}${text}`);
  }

  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;
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

  function getElementByXPath(xpath, contextNode = document) {
    try {
      const result = document.evaluate(xpath, contextNode, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < result.snapshotLength; i++) {
        const node = result.snapshotItem(i);
        if (node && isElementVisible(node)) {
          return node;
        }
      }
    } catch (e) {
      console.debug('[TikTok Extension] XPath eval error:', xpath, e);
    }
    return null;
  }

  /**
   * Simulates a full human mouse click sequence + native .click()
   * Handles SVG elements by targeting their interactive HTML parent container.
   */
  function humanClick( rawElement ) {
    if (!rawElement) return false;

    // If an <svg> or <path> was matched, climb up to the closest HTML element (span/div/button)
    let element = rawElement;
    if (element instanceof SVGElement) {
      element = element.closest('button, span, div') || element.parentElement;
    }
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
    if (typeof element.focus === 'function') {
      element.focus({ preventScroll: true });
    }
    element.dispatchEvent(new PointerEvent('pointerup', eventInit));
    element.dispatchEvent(new MouseEvent('mouseup', eventInit));

    if (typeof element.click === 'function') {
      element.click();
    } else {
      element.dispatchEvent(new MouseEvent('click', eventInit));
    }
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
    console.debug(`[TikTok Extension] [${reportKey}] ${status}${message ? `: ${message}` : ''}`);
  }

  // --- Step 1: Open & Select Date/Month on #page-title-datepicker ---

  function findDatePickerTriggerCandidates() {
    const candidates = [];

    // Exact XPaths from your Recorder JSONs:
    // 1. LIVE_Details_workflow: //*[@id="page-title-datepicker"]/div/div[2]/div[3]/input
    const xpathInput = getElementByXPath('//*[@id="page-title-datepicker"]//input');
    if (xpathInput) candidates.push(xpathInput);

    // 2. Video_Details_workflow & Monthly_flow: //*[@id="page-title-datepicker"]/div/div[2]/div[4]/span/svg
    const xpathIconSpan = getElementByXPath('//*[@id="page-title-datepicker"]/div/div[2]/div[4]/span');
    if (xpathIconSpan) candidates.push(xpathIconSpan);

    // 3. Picker wrapper inside #page-title-datepicker
    const container = document.getElementById('page-title-datepicker');
    if (container && isElementVisible(container)) {
      const inputs = Array.from(container.querySelectorAll('input')).filter(isElementVisible);
      candidates.push(...inputs);
      const pickerBox = container.querySelector('[class*="picker"]');
      if (pickerBox && isElementVisible(pickerBox)) candidates.push(pickerBox);
      candidates.push(container);
    }

    return candidates;
  }

  function findOpenCalendarPopup() {
    // 1. From Monthly_flow JSON: div.arco-space containing "Day" and "Month"
    const spaceEl = Array.from(document.querySelectorAll('div.arco-space, div[class*="space"]')).find((el) => {
      if (!isElementVisible(el)) return false;
      const text = el.textContent || '';
      return text.includes('Day') && text.includes('Month');
    });
    if (spaceEl) {
      // Climb up to the popup root under body > div > span > div
      return (
        spaceEl.closest('div[class*="trigger"], div[class*="picker-container"]') ||
        spaceEl.parentElement?.parentElement?.parentElement ||
        spaceEl.parentElement?.parentElement
      );
    }

    // 2. Fallback: look for any visible popup added at the end of document.body that has calendar days
    const bodyPopups = Array.from(document.body.querySelectorAll('body > div > span > div, .arco-picker-container')).filter(
      (el) => isElementVisible(el) && (el.textContent || '').includes('Mon') && (el.textContent || '').includes('Sun')
    );
    return bodyPopups[bodyPopups.length - 1] || null;
  }

  async function openDatePickerPopup() {
    logStep('Opening Date Picker (#page-title-datepicker)...');
    const ready = await waitForSelector(() => findDatePickerTriggerCandidates().length > 0, 12000, 300);
    if (!ready) {
      throw new Error('Could not find #page-title-datepicker on page');
    }

    let popup = findOpenCalendarPopup();
    if (popup) return popup;

    const candidates = findDatePickerTriggerCandidates();
    for (const trigger of candidates) {
      humanClick(trigger);
      await sleep(450);
      popup = await waitForSelector(findOpenCalendarPopup, 1800, 150);
      if (popup) {
        logStep('Date Picker popup opened.');
        return popup;
      }
    }

    throw new Error('DatePicker popup did not open after clicking #page-title-datepicker');
  }

  async function switchCalendarModeTab(modeLabel) {
    // From Monthly_flow JSON: "div.arco-space > div:nth-of-type(3) > div" with text "Month" (or "Day")
    const xpathMode = getElementByXPath(
      `//div[contains(@class, "arco-space")]//div[normalize-space(text())="${modeLabel}"]`
    );
    if (xpathMode) {
      humanClick(xpathMode);
      await sleep(400);
      return true;
    }

    const popup = findOpenCalendarPopup() || document.body;
    const fallbackBtn = Array.from(popup.querySelectorAll('div, span')).find(
      (el) => isElementVisible(el) && el.children.length === 0 && el.textContent.trim() === modeLabel
    );
    if (fallbackBtn) {
      humanClick(fallbackBtn);
      await sleep(400);
      return true;
    }
    return false;
  }

  async function navigateCalendarHeader(targetYear, targetMonth = null) {
    for (let step = 0; step < 24; step++) {
      const popup = findOpenCalendarPopup() || document.body;
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
        if (currentYear === targetYear) break;
      } else {
        if (currentYear === targetYear && currentMonth === targetMonth) break;
      }

      const headerRow = headerEl.parentElement?.parentElement || headerEl.parentElement;
      const icons = headerRow
        ? Array.from(headerRow.querySelectorAll('svg, button, span[class*="icon"], div[class*="icon"]')).filter(
            isElementVisible
          )
        : [];

      const targetTotal = targetYear * 12 + (targetMonth || 1);
      const currentTotal = currentYear * 12 + (currentMonth || 1);

      if (targetTotal < currentTotal) {
        const prevBtn = targetMonth !== null && icons.length >= 4 ? icons[1] : icons[0];
        if (prevBtn) humanClick(prevBtn);
      } else {
        const nextBtn = targetMonth !== null && icons.length >= 4 ? icons[icons.length - 2] : icons[icons.length - 1];
        if (nextBtn) humanClick(nextBtn);
      }
      await sleep(300);
    }
  }

  function findDayCellInPopup(dayNumber) {
    const dayStr = String(dayNumber);
    const popup = findOpenCalendarPopup() || document.body;

    // 1. Prefer Arco Design's in-view cells (.arco-picker-cell-in-view)
    const inViewCells = Array.from(
      popup.querySelectorAll('.arco-picker-cell-in-view, [class*="picker-cell-in-view"]')
    ).filter(isElementVisible);

    for (const cell of inViewCells) {
      const leaf = Array.from(cell.querySelectorAll('div')).find(
        (d) => d.children.length === 0 && d.textContent.trim() === dayStr
      );
      if (leaf) return leaf;
      if (cell.textContent.trim() === dayStr) return cell;
    }

    // 2. Fallback: find leaf divs inside the calendar popup matching dayStr
    const allCells = Array.from(popup.querySelectorAll('div > div > div')).filter(
      (el) => isElementVisible(el) && el.children.length === 0 && el.textContent.trim() === dayStr
    );
    if (allCells.length === 0) return null;
    return dayNumber <= 15 ? allCells[0] : allCells[allCells.length - 1];
  }

  function findMonthCellInPopup(monthIndexZeroBased) {
    const monthLabel = MONTH_NAMES[monthIndexZeroBased];
    if (!monthLabel) return null;
    const popup = findOpenCalendarPopup() || document.body;

    const match = Array.from(popup.querySelectorAll('div')).find(
      (el) => isElementVisible(el) && el.children.length === 0 && el.textContent.trim() === monthLabel
    );
    return match || null;
  }

  async function selectCalendarPeriod(periodConfig, pageType) {
    const mode = periodConfig?.mode || 'day';
    await openDatePickerPopup();

    if (mode === 'month') {
      const [yyyyStr, mmStr] = (periodConfig.month || '').split('-');
      const targetYear = parseInt(yyyyStr, 10);
      const targetMonthIdx = parseInt(mmStr, 10) - 1;
      const monthName = MONTH_NAMES[targetMonthIdx] || mmStr;

      logStep(`Switching calendar to Month mode (${monthName} ${targetYear})...`);
      await switchCalendarModeTab('Month');
      if (!isNaN(targetYear)) {
        await navigateCalendarHeader(targetYear, null);
      }

      const monthCell = await waitForSelector(() => findMonthCellInPopup(targetMonthIdx), 4000, 150);
      if (!monthCell) {
        throw new Error(`Could not find month "${monthName}" on calendar`);
      }

      logStep(`Clicking month "${monthName}"...`);
      humanClick(monthCell);
      await sleep(700);
    } else {
      const [yyyyStr, mmStr, ddStr] = (periodConfig.date || '').split('-');
      const targetYear = parseInt(yyyyStr, 10);
      const targetMonth = parseInt(mmStr, 10);
      const targetDay = parseInt(ddStr, 10);

      logStep(`Selecting Single Day: ${periodConfig.date} (${pageType.toUpperCase()})...`);
      await switchCalendarModeTab('Day');
      if (!isNaN(targetYear) && !isNaN(targetMonth)) {
        await navigateCalendarHeader(targetYear, targetMonth);
      }

      const dayCell1 = await waitForSelector(() => findDayCellInPopup(targetDay), 4000, 150);
      if (!dayCell1) {
        throw new Error(`Could not find day "${targetDay}" on calendar`);
      }

      logStep(`Click #1 on day ${targetDay}...`);
      humanClick(dayCell1);
      await sleep(400);

      // On Video -> Details, Day mode is a Date Range picker: click the same day a 2nd time!
      if (pageType === 'video') {
        const dayCell2 = await waitForSelector(() => findDayCellInPopup(targetDay), 2500, 150);
        if (dayCell2) {
          logStep(`Click #2 on day ${targetDay} (Video range end)...`);
          humanClick(dayCell2);
          await sleep(600);
        }
      }
    }
  }

  // --- Step 2: Wait for Table Loading & Switch Tabs ---

  async function waitForDataLoadingComplete(timeoutMs = 15000) {
    await sleep(1000);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const spinners = Array.from(
        document.querySelectorAll('.arco-spin-loading, .arco-spin-dot, [class*="loading-mask"], [class*="spin-dot"]')
      ).filter(isElementVisible);
      if (spinners.length === 0) {
        break;
      }
      await sleep(300);
    }
    await sleep(700);
  }

  function hasNoAvailableData() {
    const mainEl = document.getElementById('main') || document.body;
    const text = mainEl.innerText || '';
    return text.includes('No available data yet');
  }

  function findAccountTab(tabType) {
    const targetText = tabType === 'affiliate' ? 'Affiliate accounts' : 'Linked accounts';

    // 1. Check IDs from LIVE_Details_workflow JSON (#core-tabs-0-tab-0 / #core-tabs-0-tab-1)
    const idSelector = tabType === 'affiliate' ? '#core-tabs-0-tab-1' : '#core-tabs-0-tab-0';
    const byId = document.querySelector(idSelector);
    if (byId && isElementVisible(byId)) {
      return byId.querySelector('div > div') || byId;
    }

    // 2. XPath search inside #main for exact tab label (covers Video_Details_workflow div.rounded-r)
    const byXPath = getElementByXPath(`//*[@id="main"]//*[normalize-space(text())="${targetText}"]`);
    if (byXPath) {
      return byXPath.closest('div[role="tab"], div.rounded-r, div.rounded-l, button') || byXPath;
    }

    return null;
  }

  // --- Step 3: Click Export with Smart Retry ---

  function findExportButton() {
    // 1. Check exact XPaths from your LIVE and Video Recorder JSONs
    const exactXPaths = [
      '//*[@id="main"]//button[normalize-space(.)="Export" or @aria-label="Export"]',
      '//*[@id="main"]/div[2]/div/div/div/div/div[2]/div[3]/div/div/div/div/div[2]/div[1]/div[2]/div[2]/button',
      '//*[@id="main"]/div[2]/div/div/div/div/div[2]/div[3]/div/div/div/div/div[2]/div[1]/div/div[2]/button',
      '//*[@id="main"]/div[2]/div/div/div/div/div[2]/div[3]/div/div/div/div/div[2]/div/div[1]/div[2]/div/div/button'
    ];

    for (const xp of exactXPaths) {
      const btn = getElementByXPath(xp);
      if (btn) return btn;
    }

    // 2. Fallback: any visible button containing "Export"
    const mainEl = document.getElementById('main') || document.body;
    const buttons = Array.from(mainEl.querySelectorAll('button')).filter((btn) => {
      if (!isElementVisible(btn)) return false;
      const text = (btn.textContent || '').trim();
      return text === 'Export' || text.includes('Export') || btn.getAttribute('aria-label') === 'Export';
    });
    return buttons[0] || null;
  }

  function triggerExportButtonClick(exportBtn) {
    if (!exportBtn) return;
    humanClick(exportBtn);
  }

  async function waitForDownloadSince(timestampMs, waitMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      if (lastDownloadTimestamp >= timestampMs) {
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  async function waitForDownloadOrTaskSince(timestampMs, waitMs = 4500) {
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      if (lastDownloadTimestamp >= timestampMs) {
        return 'download';
      }
      if (lastExportTaskCreatedTimestamp >= timestampMs) {
        return 'task';
      }
      await sleep(250);
    }
    return null;
  }

  async function waitForExportAttempt(clickTime, attemptNum, reportKey, initialWaitMs) {
    const outcome = await waitForDownloadOrTaskSince(clickTime, initialWaitMs);
    if (outcome === 'download') {
      return true;
    }
    if (outcome === 'task') {
      logStep(`[${reportKey}] Export task queued (Attempt #${attemptNum}) -> waiting up to 25s for file...`);
      updateReportStatus(reportKey, 'running', 'Generating file...');
      return await waitForDownloadSince(clickTime, 25000);
    }
    return false;
  }

  async function notifyExpectedDownload(reportKey, periodConfig) {
    let sellerId = null;
    try {
      const stored = await Promise.race([
        new Promise((resolve) => {
          chrome.storage.local.get(['ttk_seller_payload'], (res) => resolve(res || {}));
        }),
        sleep(300)
      ]);
      const sellerPayload = stored?.ttk_seller_payload;
      const activeShop = sellerPayload?.active_shop || sellerPayload?.shops?.[0];
      sellerId = activeShop?.formatted_seller_id || null;
    } catch (e) {
      sellerId = null;
    }

    const payload = {
      sellerId,
      reportKey,
      periodConfig: periodConfig || null,
      timestamp: Date.now()
    };

    const storagePromise = new Promise((resolve) => {
      try {
        chrome.storage.local.set({ ttk_expected_download: payload }, () => resolve());
      } catch (e) {
        resolve();
      }
    });

    const msgPromise = new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            action: 'SET_EXPECTED_DOWNLOAD',
            ...payload
          },
          () => {
            if (chrome.runtime.lastError) {
              // Service worker might be waking up
            }
            resolve();
          }
        );
      } catch (e) {
        resolve();
      }
    });

    await Promise.race([Promise.all([storagePromise, msgPromise]), sleep(1000)]);
  }

  async function exportCurrentTabReport(reportKey, periodConfig) {
    updateReportStatus(reportKey, 'running', 'Loading...');
    logStep(`[${reportKey}] Waiting for table data to load...`);
    await waitForDataLoadingComplete();

    const exportBtn = await waitForSelector(findExportButton, 6000, 250);
    if (!exportBtn) {
      if (hasNoAvailableData()) {
        logStep(`[${reportKey}] No available data yet -> Skipped.`);
        updateReportStatus(reportKey, 'empty', 'No data');
        return { status: 'empty' };
      }
      logStep(`[${reportKey}] Export button not found!`, true);
      updateReportStatus(reportKey, 'error', 'No Export btn');
      return { status: 'error', reason: 'Export button not found' };
    }

    const isDisabled =
      exportBtn.disabled ||
      exportBtn.getAttribute('aria-disabled') === 'true' ||
      exportBtn.classList.contains('arco-btn-disabled');

    if (isDisabled || hasNoAvailableData()) {
      logStep(`[${reportKey}] Export button is disabled / No data -> Skipped.`);
      updateReportStatus(reportKey, 'empty', 'No data');
      return { status: 'empty' };
    }

    // Attempt #1: Click Export button
    const clickTime1 = Date.now();
    logStep(`[${reportKey}] Clicking Export button (Attempt #1)...`);
    updateReportStatus(reportKey, 'running', 'Exporting...');
    await notifyExpectedDownload(reportKey, periodConfig);
    triggerExportButtonClick(exportBtn);

    const downloadedOnFirstTry = await waitForExportAttempt(clickTime1, 1, reportKey, 4500);
    if (downloadedOnFirstTry) {
      logStep(`[${reportKey}] Download started on Attempt #1!`);
      updateReportStatus(reportKey, 'done', 'Downloaded ✓');
      await sleep(1000);
      return { status: 'done', attempts: 1 };
    }

    if (hasNoAvailableData()) {
      updateReportStatus(reportKey, 'empty', 'No data');
      return { status: 'empty' };
    }

    // Attempt #2 (Platform fallback when 1st click on Export didn't queue a task or trigger download)
    const retryBtn = findExportButton();
    if (retryBtn && !retryBtn.disabled) {
      const clickTime2 = Date.now();
      logStep(`[${reportKey}] No download after 4.5s -> Clicking Export (Attempt #2)...`);
      updateReportStatus(reportKey, 'running', 'Retry click...');
      await notifyExpectedDownload(reportKey, periodConfig);
      triggerExportButtonClick(retryBtn);

      const downloadedOnSecondTry = await waitForExportAttempt(clickTime2, 2, reportKey, 5500);
      if (downloadedOnSecondTry) {
        logStep(`[${reportKey}] Download started on Attempt #2!`);
        updateReportStatus(reportKey, 'done', 'Downloaded ✓');
        await sleep(1000);
        return { status: 'done', attempts: 2 };
      }
    }

    logStep(`[${reportKey}] Export clicked (check browser download prompt if Save As is enabled).`);
    updateReportStatus(reportKey, 'done', 'Clicked ✓');
    return { status: 'done', attempts: 2 };
  }

  // --- Main Page Workflow (LIVE Details or Video Details) ---

  async function executeDetailsPageWorkflow(periodConfig) {
    if (isWorkflowRunning) {
      return { ok: false, error: 'Workflow already running on this tab' };
    }

    const pageType = getPageReportType();
    if (!pageType) {
      const msg = 'Please open LIVE Details or Video Details page first.';
      logStep(msg, true);
      return { ok: false, error: msg };
    }

    isWorkflowRunning = true;
    const linkedKey = `${pageType}_linked`;
    const affiliateKey = `${pageType}_affiliate`;

    try {
      logStep(`Running ${pageType.toUpperCase()} Details workflow (Mode: ${periodConfig?.mode || 'day'})...`);
      updateReportStatus(linkedKey, 'running', 'Selecting date...');

      // 1. Ensure we are on "Linked accounts" tab first (do not block long if tab markup differs)
      logStep('Looking for "Linked accounts" tab...');
      const linkedTab = await waitForSelector(() => findAccountTab('linked'), 4000, 300);
      if (linkedTab) {
        logStep(`Ensuring "Linked accounts" tab is active...`);
        humanClick(linkedTab);
        await sleep(500);
      } else {
        logStep('"Linked accounts" tab not found, assuming it is already active.');
      }

      // 2. Select Single Day or Month on #page-title-datepicker
      await selectCalendarPeriod(periodConfig, pageType);

      // 3. Export Report #1 (Linked accounts)
      const linkedResult = await exportCurrentTabReport(linkedKey, periodConfig);

      // 4. Switch to "Affiliate accounts" tab (Date Range is preserved on same page!)
      updateReportStatus(affiliateKey, 'running', 'Switching tab...');
      logStep(`Switching to "Affiliate accounts" tab...`);
      const affiliateTab = await waitForSelector(() => findAccountTab('affiliate'), 6000, 250);
      if (!affiliateTab) {
        logStep(`Could not find "Affiliate accounts" tab!`, true);
        updateReportStatus(affiliateKey, 'error', 'Tab not found');
        return { ok: false, error: 'Affiliate accounts tab not found' };
      }

      humanClick(affiliateTab);
      await sleep(800);

      // 5. Export Report #2 (Affiliate accounts)
      const affiliateResult = await exportCurrentTabReport(affiliateKey, periodConfig);

      logStep(`Finished ${pageType.toUpperCase()} Details page workflow!`);
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
      logStep(err.message || String(err), true);
      updateReportStatus(linkedKey, 'error', 'Failed');
      return { ok: false, error: err.message || String(err) };
    } finally {
      isWorkflowRunning = false;
    }
  }

  // --- Event & Message Listeners ---

  window.addEventListener('TIKTOK_EXPORT_TASK_CREATED', () => {
    lastExportTaskCreatedTimestamp = Date.now();
  });

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
          // ignore
        }
      }
    );
  });

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
      logStep('[v3] RUN_PAGE_WORKFLOW message received by content script.');
      executeDetailsPageWorkflow(request.periodConfig)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    if (request.action === 'PING') {
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('TIKTOK_SELLER_REQUEST_STATE'));
  }, 1000);
})();
