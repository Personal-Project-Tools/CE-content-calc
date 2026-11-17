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

    const rectBefore = element.getBoundingClientRect();
    if (
      rectBefore.top < 0 ||
      rectBefore.bottom > window.innerHeight ||
      rectBefore.left < 0 ||
      rectBefore.right > window.innerWidth
    ) {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
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
      await sleep(150);
      popup = await waitForSelector(findOpenCalendarPopup, 1500, 100);
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

  function isCalendarCellDisabled(el) {
    if (el instanceof Element && !(el instanceof SVGElement)) {
      const leafStyle = window.getComputedStyle(el);
      if (parseFloat(leafStyle.opacity) < 0.5) {
        return true;
      }
      const colorMatch = leafStyle.color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
      if (colorMatch) {
        const r = parseInt(colorMatch[1], 10);
        const g = parseInt(colorMatch[2], 10);
        const b = parseInt(colorMatch[3], 10);
        const a = colorMatch[4] !== undefined ? parseFloat(colorMatch[4]) : 1;
        if (a < 0.5) {
          return true;
        }
        if (r >= 160 && r <= 240 && g >= 160 && g <= 240 && b >= 160 && b <= 240) {
          return true;
        }
      }
    }

    let cur = el;
    for (let depth = 0; cur && depth < 5; depth++) {
      if (cur instanceof Element) {
        const cls = typeof cur.className === 'string' ? cur.className : cur.getAttribute('class') || '';
        const clsLower = cls.toLowerCase();
        const isCellOrIcon =
          clsLower.includes('picker-cell') ||
          clsLower.includes('picker-header-icon') ||
          cur.tagName === 'BUTTON';
        if (
          clsLower.includes('disabled') ||
          cur.hasAttribute('disabled') ||
          cur.getAttribute('aria-disabled') === 'true'
        ) {
          return true;
        }
        const style = window.getComputedStyle(cur);
        if (
          style.cursor === 'not-allowed' ||
          parseFloat(style.opacity) < 0.5 ||
          (isCellOrIcon && style.pointerEvents === 'none')
        ) {
          return true;
        }
        if (clsLower.includes('picker-cell') || clsLower.includes('picker-header-icon')) {
          break;
        }
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function parseCalendarHeaderText(rawText, requireMonth) {
    const txt = (rawText || '').replace(/\s+/g, '');
    if (requireMonth) {
      let match = txt.match(/^(\d{1,2})\/(\d{4})$/);
      if (match) {
        return { month: parseInt(match[1], 10), year: parseInt(match[2], 10) };
      }
      match = txt.match(/^(\d{4})-(\d{1,2})$/);
      if (match) {
        return { year: parseInt(match[1], 10), month: parseInt(match[2], 10) };
      }
      return null;
    }

    const yearMatch = txt.match(/^(\d{4})$/);
    if (yearMatch) {
      return { year: parseInt(yearMatch[1], 10), month: null };
    }
    return null;
  }

  function getCalendarHeaderStates(popup, requireMonth = true) {
    const candidates = Array.from(popup.querySelectorAll('div, span')).filter((el) => {
      if (!isElementVisible(el) || el.querySelector('svg') !== null) return false;
      return parseCalendarHeaderText(el.textContent, requireMonth) !== null;
    });

    const deepest = candidates.filter(
      (el) => !candidates.some((other) => other !== el && el.contains(other))
    );

    return deepest.map((headerEl) => {
      const parsed = parseCalendarHeaderText(headerEl.textContent, requireMonth);
      return {
        headerEl,
        year: parsed.year,
        month: parsed.month
      };
    });
  }

  function getCalendarHeaderState(popup, requireMonth = true, targetYear = null, targetMonth = null) {
    const states = getCalendarHeaderStates(popup, requireMonth);
    if (states.length === 0) return null;

    if (targetYear !== null) {
      const exactMatch = states.find((s) =>
        requireMonth ? s.year === targetYear && s.month === targetMonth : s.year === targetYear
      );
      if (exactMatch) return exactMatch;
    }

    return states[0];
  }

  async function navigateCalendarHeader(targetYear, targetMonth = null) {
    const requireMonth = targetMonth !== null;
    let lastYear = null;
    let lastMonth = null;

    for (let step = 0; step < 24; step++) {
      const popup = findOpenCalendarPopup() || document.body;
      const states = getCalendarHeaderStates(popup, requireMonth);
      if (states.length === 0) return false;

      const matched = states.find((s) =>
        requireMonth ? s.year === targetYear && s.month === targetMonth : s.year === targetYear
      );
      if (matched) return true;

      const targetTotal = targetYear * 12 + (targetMonth || 1);
      const firstTotal = states[0].year * 12 + (states[0].month || 1);
      const goingPrev = targetTotal < firstTotal;
      const state = goingPrev ? states[0] : states[states.length - 1];
      const stateTotal = state.year * 12 + (state.month || 1);

      if (state.year === lastYear && state.month === lastMonth) {
        return false;
      }
      lastYear = state.year;
      lastMonth = state.month;

      let headerRow = state.headerEl.parentElement;
      for (let depth = 0; depth < 4 && headerRow && headerRow !== popup; depth++) {
        if (headerRow.querySelectorAll('svg').length >= 2) break;
        headerRow = headerRow.parentElement;
      }

      const svgs = headerRow
        ? Array.from(headerRow.querySelectorAll('svg')).filter(isElementVisible)
        : [];

      const prevSvgs = svgs.filter((svg) =>
        Boolean(svg.compareDocumentPosition(state.headerEl) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      const nextSvgs = svgs.filter((svg) =>
        Boolean(state.headerEl.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING)
      );

      let targetSvg = null;
      if (goingPrev) {
        if (requireMonth && stateTotal - targetTotal >= 12 && prevSvgs.length >= 2) {
          targetSvg = prevSvgs[0];
        } else {
          targetSvg = prevSvgs[prevSvgs.length - 1] || null;
        }
      } else {
        if (requireMonth && targetTotal - stateTotal >= 12 && nextSvgs.length >= 2) {
          targetSvg = nextSvgs[nextSvgs.length - 1];
        } else {
          targetSvg = nextSvgs[0] || null;
        }
      }

      if (!targetSvg || isCalendarCellDisabled(targetSvg)) {
        return false;
      }

      humanClick(targetSvg);
      await sleep(200);
    }

    return false;
  }

  function findCalendarPanelRoot(popup, requireMonth, targetYear, targetMonth) {
    if (!targetYear) return popup;
    const states = getCalendarHeaderStates(popup, requireMonth);
    if (states.length <= 1) return popup;

    const matchingState = states.find((s) =>
      requireMonth ? s.year === targetYear && s.month === targetMonth : s.year === targetYear
    );
    if (!matchingState) return popup;

    let cur = matchingState.headerEl.parentElement;
    let best = popup;
    while (cur && cur !== popup) {
      const headersInside = getCalendarHeaderStates(cur, requireMonth);
      if (headersInside.length > 1) {
        break;
      }
      if (
        cur.querySelector('.arco-picker-cell, [class*="picker-cell"]') ||
        cur.textContent.includes('Mon')
      ) {
        best = cur;
      }
      cur = cur.parentElement;
    }
    return best;
  }

  function findDayCellStateInPopup(dayNumber, targetYear = null, targetMonth = null) {
    const dayStr = String(dayNumber);
    const popup = findOpenCalendarPopup() || document.body;
    const scopeRoot = findCalendarPanelRoot(popup, true, targetYear, targetMonth);

    // 1. Prefer Arco Design's in-view cells (.arco-picker-cell-in-view)
    const inViewCells = Array.from(
      scopeRoot.querySelectorAll('.arco-picker-cell-in-view, [class*="picker-cell-in-view"]')
    ).filter(isElementVisible);

    for (const cell of inViewCells) {
      const leaf = Array.from(cell.querySelectorAll('div')).find(
        (d) => d.children.length === 0 && d.textContent.trim() === dayStr
      );
      if (leaf) {
        return {
          found: true,
          disabled: isCalendarCellDisabled(leaf),
          element: leaf
        };
      }
      if (cell.textContent.trim() === dayStr) {
        return {
          found: true,
          disabled: isCalendarCellDisabled(cell),
          element: cell
        };
      }
    }

    // 2. Fallback only when no Arco in-view cells exist
    if (inViewCells.length === 0) {
      const allCells = Array.from(scopeRoot.querySelectorAll('div > div > div')).filter(
        (el) => isElementVisible(el) && el.children.length === 0 && el.textContent.trim() === dayStr
      );
      if (allCells.length > 0) {
        const picked = dayNumber <= 15 ? allCells[0] : allCells[allCells.length - 1];
        return {
          found: true,
          disabled: isCalendarCellDisabled(picked),
          element: picked
        };
      }
    }

    return { found: false, disabled: true, element: null };
  }

  function findMonthCellStateInPopup(monthIndexZeroBased, targetYear = null) {
    const monthLabel = MONTH_NAMES[monthIndexZeroBased];
    if (!monthLabel) return { found: false, disabled: true, element: null };
    const popup = findOpenCalendarPopup() || document.body;
    const scopeRoot = findCalendarPanelRoot(popup, false, targetYear, null);

    const match = Array.from(scopeRoot.querySelectorAll('div')).find(
      (el) => isElementVisible(el) && el.children.length === 0 && el.textContent.trim() === monthLabel
    );
    if (!match) {
      return { found: false, disabled: true, element: null };
    }
    return {
      found: true,
      disabled: isCalendarCellDisabled(match),
      element: match
    };
  }

  function doesInputMatchSingleDay(rawVal, targetYear, targetMonth, targetDay) {
    const val = (rawVal || '').trim();
    if (!val) return false;

    const monthName = MONTH_NAMES[targetMonth - 1];
    const yyyy = String(targetYear);
    const mStr = String(targetMonth);
    const dStr = String(targetDay);

    const isoRegex = new RegExp(`\\b${yyyy}[-/]0?${mStr}[-/]0?${dStr}\\b`);
    const dmyRegex = new RegExp(`\\b0?${dStr}[-/]0?${mStr}[-/]${yyyy}\\b`);
    const mdyRegex = new RegExp(`\\b0?${mStr}[-/]0?${dStr}[-/]${yyyy}\\b`);
    if (isoRegex.test(val) || dmyRegex.test(val) || mdyRegex.test(val)) {
      return true;
    }

    if (monthName) {
      const hasMonthName = new RegExp(`\\b${monthName}\\b`, 'i').test(val);
      const hasYear = new RegExp(`\\b${yyyy}\\b`).test(val);
      const hasDay = new RegExp(`\\b0?${dStr}\\b`).test(val);
      if (hasMonthName && hasYear && hasDay) {
        return true;
      }
    }

    return false;
  }

  function getDatePickerCombinedText(container) {
    if (!container) return '';
    return [
      container.textContent || '',
      ...Array.from(container.querySelectorAll('input')).map((i) => i.value || '')
    ]
      .join(' ')
      .trim();
  }

  function isSingleDaySelectedOnPage(targetYear, targetMonth, targetDay) {
    const container = document.getElementById('page-title-datepicker');
    if (!container) return false;

    const combinedText = getDatePickerCombinedText(container);
    if (/\b(Last|Week|Month)\b/i.test(combinedText)) {
      return false;
    }

    const inputs = Array.from(container.querySelectorAll('input')).filter(isElementVisible);
    if (inputs.length === 0) return false;

    return inputs.every((inp) =>
      doesInputMatchSingleDay(inp.value, targetYear, targetMonth, targetDay)
    );
  }

  function isMonthSelectionApplied(targetYear, targetMonthIdx, targetMonthLabel) {
    if (!findOpenCalendarPopup()) {
      return true;
    }

    const container = document.getElementById('page-title-datepicker');
    if (!container) return false;
    const combinedText = getDatePickerCombinedText(container);
    if (/\b(Last|Week|Today|Day)\b/i.test(combinedText)) {
      return false;
    }

    const monthName = MONTH_NAMES[targetMonthIdx] || '';
    const yyyy = String(targetYear);
    const inputsText = Array.from(container.querySelectorAll('input'))
      .filter(isElementVisible)
      .map((i) => i.value || '')
      .join(' ');

    if (targetMonthLabel && (inputsText.includes(targetMonthLabel) || combinedText.includes(targetMonthLabel))) {
      return true;
    }

    return Boolean(
      monthName &&
        new RegExp(`\\b${monthName}\\b`, 'i').test(inputsText) &&
        new RegExp(`\\b${yyyy}\\b`).test(inputsText)
    );
  }

  async function selectCalendarPeriod(periodConfig, pageType) {
    const mode = periodConfig?.mode || 'day';
    const reportTypeLabel = pageType === 'video' ? 'Content Video' : 'Content LIVE';
    const buildMissingReportError = (label) =>
      new Error(`Platform do not have ${reportTypeLabel} report for ${label}`);

    if (mode === 'month') {
      const popup = await openDatePickerPopup();
      const targetMonthLabel = periodConfig.month || '';
      const [yyyyStr, mmStr] = targetMonthLabel.split('-');
      const targetYear = parseInt(yyyyStr, 10);
      const targetMonthIdx = parseInt(mmStr, 10) - 1;
      const monthName = MONTH_NAMES[targetMonthIdx] || mmStr;

      logStep(`Switching calendar to Month mode (${monthName} ${targetYear})...`);
      await switchCalendarModeTab('Month');
      if (!isNaN(targetYear)) {
        const reached = await navigateCalendarHeader(targetYear, null);
        if (!reached) {
          throw buildMissingReportError(targetMonthLabel);
        }
      }

      const monthState = await waitForSelector(() => {
        const s = findMonthCellStateInPopup(targetMonthIdx, targetYear);
        return s.found ? s : null;
      }, 2500, 100);

      if (!monthState || !monthState.found || monthState.disabled) {
        throw buildMissingReportError(targetMonthLabel);
      }

      logStep(`Clicking month "${monthName}"...`);
      humanClick(monthState.element);
      await sleep(300);

      const monthVerified = await waitForSelector(
        () => isMonthSelectionApplied(targetYear, targetMonthIdx, targetMonthLabel),
        1500,
        100
      );
      if (!monthVerified) {
        throw buildMissingReportError(targetMonthLabel);
      }
      await sleep(300);
    } else {
      const targetDateLabel = periodConfig.date || '';
      const [yyyyStr, mmStr, ddStr] = targetDateLabel.split('-');
      const targetYear = parseInt(yyyyStr, 10);
      const targetMonth = parseInt(mmStr, 10);
      const targetDay = parseInt(ddStr, 10);

      if (isNaN(targetYear) || isNaN(targetMonth) || isNaN(targetDay)) {
        throw buildMissingReportError(targetDateLabel);
      }

      const containerBefore = document.getElementById('page-title-datepicker');
      const combinedBefore = getDatePickerCombinedText(containerBefore);
      if (/\bDay\s*:/.test(combinedBefore) && isSingleDaySelectedOnPage(targetYear, targetMonth, targetDay)) {
        logStep(`Single Day ${targetDateLabel} is already selected on page.`);
        return;
      }

      const popup = await openDatePickerPopup();
      logStep(`Selecting Single Day: ${targetDateLabel} (${pageType.toUpperCase()})...`);
      const combinedNow = getDatePickerCombinedText(document.getElementById('page-title-datepicker'));
      const isExplicitDayMode =
        /\bDay\s*:/.test(combinedNow) &&
        !/\b(Week|Month|Last)\b/i.test(combinedNow) &&
        Boolean(getCalendarHeaderState(popup, true));
      if (!isExplicitDayMode) {
        await switchCalendarModeTab('Day');
      }

      const reached = await navigateCalendarHeader(targetYear, targetMonth);
      if (!reached) {
        throw buildMissingReportError(targetDateLabel);
      }

      const dayState1 = await waitForSelector(() => {
        const s = findDayCellStateInPopup(targetDay, targetYear, targetMonth);
        return s.found ? s : null;
      }, 2500, 100);

      if (!dayState1 || !dayState1.found || dayState1.disabled) {
        throw buildMissingReportError(targetDateLabel);
      }

      logStep(`Click #1 on day ${targetDay}...`);
      humanClick(dayState1.element);

      // On Video -> Details, Day mode is a Date Range picker: click the same day a 2nd time!
      if (pageType === 'video') {
        await sleep(250);
        const dayState2 = await waitForSelector(() => {
          const s = findDayCellStateInPopup(targetDay, targetYear, targetMonth);
          return s.found ? s : null;
        }, 2000, 100);
        if (!dayState2 || !dayState2.found || dayState2.disabled) {
          throw buildMissingReportError(targetDateLabel);
        }
        logStep(`Click #2 on day ${targetDay} (Video range end)...`);
        humanClick(dayState2.element);
      }

      const verified = await waitForSelector(
        () => isSingleDaySelectedOnPage(targetYear, targetMonth, targetDay),
        1500,
        100
      );
      if (!verified) {
        throw buildMissingReportError(targetDateLabel);
      }
      await sleep(300);
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

    for (let attempt = 1; ; attempt++) {
      if (hasNoAvailableData()) {
        logStep(`[${reportKey}] No available data yet -> Skipped.`);
        updateReportStatus(reportKey, 'empty', 'No data');
        return { status: 'empty' };
      }

      const currentBtn =
        attempt === 1 ? exportBtn : await waitForSelector(findExportButton, 3000, 200);
      if (!currentBtn) {
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
        currentBtn.disabled ||
        currentBtn.getAttribute('aria-disabled') === 'true' ||
        currentBtn.classList.contains('arco-btn-disabled');

      if (isDisabled || hasNoAvailableData()) {
        logStep(`[${reportKey}] Export button is disabled / No data -> Skipped.`);
        updateReportStatus(reportKey, 'empty', 'No data');
        return { status: 'empty' };
      }

      const clickTime = Date.now();
      logStep(`[${reportKey}] Clicking Export button (Attempt #${attempt})...`);
      updateReportStatus(
        reportKey,
        'running',
        attempt === 1 ? 'Exporting...' : `Retry #${attempt}...`
      );
      await notifyExpectedDownload(reportKey, periodConfig);
      triggerExportButtonClick(currentBtn);

      const downloaded = await waitForExportAttempt(clickTime, attempt, reportKey, 4500);
      if (downloaded) {
        logStep(`[${reportKey}] Download started on Attempt #${attempt}!`);
        updateReportStatus(reportKey, 'done', 'Downloaded ✓');
        await sleep(1000);
        return { status: 'done', attempts: attempt };
      }

      logStep(
        `[${reportKey}] No download after 4.5s -> Clicking Export again (Attempt #${attempt + 1})...`
      );
    }
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
