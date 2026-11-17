/**
 * Background Service Worker (Manifest V3)
 * Manages seller state, monitors Chrome report downloads, routes TikTok reports to CE-Reports/,
 * and orchestrates the 4-report workflow across LIVE -> Details and Video -> Details pages.
 */

importScripts('report-calculator.js');

const BG_VERSION = '2.1.0';

const REPORT_PREFIX_MAP = {
  live_linked: '1_LIVE_Linked',
  live_affiliate: '2_LIVE_Affiliate',
  video_linked: '3_Video_Linked',
  video_affiliate: '4_Video_Affiliate'
};

const EXPECTED_DOWNLOAD_TTL_MS = 60000;
const TIKTOK_DOMAIN_KEYWORDS = [
  'tiktok',
  'oecstatic',
  'byted',
  'byteintl',
  'ibyte',
  'ttwstatic',
  'compass'
];
const TIKTOK_FILENAME_PATTERNS = ['live analysis', 'video performance'];

let cachedSellerPayload = null;
let cachedPeriodConfig = null;
let cachedExpectedDownload = null;
let cacheHydrated = false;
let hydratePromise = null;
let activeExportSession = null;

function hydrateCaches() {
  if (hydratePromise) return hydratePromise;
  hydratePromise = new Promise((resolve) => {
    chrome.storage.local.get(
      ['ttk_seller_payload', 'ttk_period_config', 'ttk_expected_download'],
      (res) => {
        if (res.ttk_seller_payload) cachedSellerPayload = res.ttk_seller_payload;
        if (res.ttk_period_config) cachedPeriodConfig = res.ttk_period_config;
        if (res.ttk_expected_download) cachedExpectedDownload = res.ttk_expected_download;
        cacheHydrated = true;
        resolve();
      }
    );
  });
  return hydratePromise;
}

hydrateCaches();

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'local') return;
  if (changes.ttk_seller_payload) {
    cachedSellerPayload = changes.ttk_seller_payload.newValue || null;
  }
  if (changes.ttk_period_config) {
    cachedPeriodConfig = changes.ttk_period_config.newValue || null;
  }
  if (changes.ttk_expected_download) {
    cachedExpectedDownload = changes.ttk_expected_download.newValue || null;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log(`[TikTok Extension] Extension installed/reloaded (v${BG_VERSION}).`);
  chrome.storage.local.set({ ttk_workflow_running: false });
  hydrateCaches();
});

function sanitizeFilenamePart(value, fallback = 'UNKNOWN') {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || fallback;
}

function getTodayLocalDateStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isRecentExpectedDownload() {
  return Boolean(
    cachedExpectedDownload &&
      typeof cachedExpectedDownload.timestamp === 'number' &&
      Date.now() - cachedExpectedDownload.timestamp <= EXPECTED_DOWNLOAD_TTL_MS
  );
}

function isTikTokReportDownload(downloadItem) {
  if (isRecentExpectedDownload()) {
    return true;
  }
  const filenameLower = (downloadItem.filename || '').toLowerCase();
  if (TIKTOK_FILENAME_PATTERNS.some((pat) => filenameLower.includes(pat))) {
    return true;
  }

  const haystack = [
    downloadItem.url || '',
    downloadItem.finalUrl || '',
    downloadItem.referrer || '',
    downloadItem.filename || ''
  ]
    .join(' ')
    .toLowerCase();

  return TIKTOK_DOMAIN_KEYWORDS.some((kw) => haystack.includes(kw));
}

function getSellerAndPeriodFolder() {
  const activeShop = cachedSellerPayload?.active_shop || cachedSellerPayload?.shops?.[0];
  const rawSellerId = cachedExpectedDownload?.sellerId || activeShop?.formatted_seller_id;
  const sellerId = sanitizeFilenamePart(rawSellerId, 'UNKNOWN_SELLER');

  const recentExpected = isRecentExpectedDownload();
  const periodCfg = (recentExpected ? cachedExpectedDownload?.periodConfig : null) || cachedPeriodConfig;
  const rawPeriod = periodCfg
    ? periodCfg.mode === 'month'
      ? periodCfg.month
      : periodCfg.date
    : '';
  const periodLabel = sanitizeFilenamePart(rawPeriod, getTodayLocalDateStr());

  return { sellerId, periodLabel, recentExpected };
}

function resolveDownloadSuggestion(downloadItem, suggest) {
  if (
    (typeof chrome?.runtime?.id === 'string' && downloadItem.byExtensionId === chrome.runtime.id) ||
    (downloadItem.url || '').startsWith('data:') ||
    /summary_.*\.xlsx$/i.test(downloadItem.filename || '')
  ) {
    suggest();
    return;
  }

  if (!isTikTokReportDownload(downloadItem)) {
    suggest();
    return;
  }

  const rawBasename = (downloadItem.filename || '').split(/[\\/]/).pop() || '';
  const dotIdx = rawBasename.lastIndexOf('.');
  const ext = dotIdx > 0 ? rawBasename.slice(dotIdx) : '.xlsx';
  const rawStem = dotIdx > 0 ? rawBasename.slice(0, dotIdx) : rawBasename;

  const { sellerId, periodLabel, recentExpected } = getSellerAndPeriodFolder();

  const reportKey = recentExpected ? cachedExpectedDownload?.reportKey : null;
  const reportPrefix =
    (reportKey && REPORT_PREFIX_MAP[reportKey]) || sanitizeFilenamePart(rawStem, 'report');

  if (activeExportSession && reportKey) {
    activeExportSession.sellerId = sellerId;
    activeExportSession.periodLabel = periodLabel;
    activeExportSession.downloads.set(downloadItem.id, {
      id: downloadItem.id,
      reportKey,
      fileName: `${reportPrefix}${ext}`,
      url: downloadItem.url || '',
      finalUrl: downloadItem.finalUrl || '',
      state: downloadItem.state || 'in_progress'
    });
  }

  const relativePath = `CE-Reports/${sellerId}_${periodLabel}/${reportPrefix}${ext}`;
  suggest({ filename: relativePath, conflictAction: 'overwrite' });
}

if (chrome.downloads && chrome.downloads.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    if (!activeExportSession) return;
    const entry = activeExportSession.downloads.get(delta.id);
    if (!entry) return;
    if (delta.state?.current) {
      entry.state = delta.state.current;
    }
  });
}

// Route TikTok reports through the Downloads/CE-Reports junction into repo Reports/
// Must call suggest() synchronously in MV3 service workers so Chromium applies the override reliably.
if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    resolveDownloadSuggestion(downloadItem, suggest);
  });
}

// Notify active Seller Center tabs whenever Chrome starts a download (used for smart Export retry)
if (chrome.downloads && chrome.downloads.onCreated) {
  chrome.downloads.onCreated.addListener((downloadItem) => {
    const now = Date.now();
    chrome.tabs.query({ url: ['https://*.tiktok.com/*', 'https://*.tiktokglobalshop.com/*'] }, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(
            tab.id,
            {
              action: 'DOWNLOAD_DETECTED',
              timestamp: now,
              filename: downloadItem.filename || '',
              url: downloadItem.url || ''
            },
            () => {
              if (chrome.runtime.lastError) {
                // Ignore tabs without content script ready
              }
            }
          );
        }
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function saveWorkflowLog(text, status = 'info') {
  chrome.storage.local.set({
    ttk_workflow_log: {
      text,
      status,
      isError: status === 'error',
      isSuccess: status === 'success',
      timestamp: Date.now()
    }
  });
}

function updateReportChecklistStorage(reportKey, status, message = '') {
  chrome.storage.local.get(['ttk_report_statuses'], (res) => {
    const statuses = res.ttk_report_statuses || {};
    statuses[reportKey] = {
      status,
      message,
      updatedAt: Date.now()
    };
    chrome.storage.local.set({ ttk_report_statuses: statuses });
  });
}

function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const start = Date.now();

    function checkTab() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          resolve(false);
          return;
        }
        if (tab.status === 'complete') {
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(checkTab, 400);
      });
    }

    checkTab();
  });
}

/**
 * Ensures content.js is injected into the tab (even if the user didn't manually refresh the tab after reloading the extension)
 * and sends a message to content.js.
 */
async function sendMessageWithAutoInject(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, async (response) => {
      if (chrome.runtime.lastError) {
        // Content script not loaded yet -> inject content.js dynamically and retry
        try {
          if (chrome.scripting) {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['content.js']
            });
            await sleep(300);
            chrome.tabs.sendMessage(tabId, payload, (retryResponse) => {
              if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(retryResponse || { ok: false, error: 'Empty response after script injection' });
              }
            });
            return;
          }
        } catch (injectErr) {
          resolve({ ok: false, error: injectErr.message || String(injectErr) });
          return;
        }
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: 'No response from content script' });
      }
    });
  });
}

async function waitAndRunPageWorkflow(tabId, periodConfig) {
  await sleep(1500);
  await waitForTabComplete(tabId, 25000);
  // Give React + Arco time to render #page-title-datepicker and table
  await sleep(3500);

  return sendMessageWithAutoInject(tabId, {
    action: 'RUN_PAGE_WORKFLOW',
    periodConfig
  });
}

async function navigateAndRunPageWorkflow(tabId, targetUrl, periodConfig) {
  await chrome.tabs.update(tabId, { url: targetUrl });
  return waitAndRunPageWorkflow(tabId, periodConfig);
}

const EXPORT_SCOPE_LABELS = {
  all: 'All 4 Reports',
  live: 'LIVE Reports',
  video: 'Video Reports'
};

function uint8ToBase64(uint8) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < uint8.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, uint8.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function queryDownloadItemById(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (items) => {
      if (chrome.runtime.lastError || !items || items.length === 0) {
        resolve(null);
        return;
      }
      resolve(items[0]);
    });
  });
}

async function fetchDownloadBytes(entry) {
  const item = await queryDownloadItemById(entry.id);
  const candidateUrls = [item?.url, item?.finalUrl, entry.url, entry.finalUrl].filter(
    (u, idx, arr) => u && !u.startsWith('blob:') && !u.startsWith('data:') && arr.indexOf(u) === idx
  );

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) {
        return new Uint8Array(await res.arrayBuffer());
      }
    } catch {
      // Try next candidate URL
    }
  }
  return null;
}

async function tryGenerateAndDownloadSummary(session) {
  if (!session || session.downloads.size === 0 || typeof ReportCalculator === 'undefined') {
    return false;
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const entries = Array.from(session.downloads.values());
    let allSettled = true;
    for (const entry of entries) {
      if (entry.state === 'in_progress') {
        const latest = await queryDownloadItemById(entry.id);
        if (latest?.state) entry.state = latest.state;
        if (latest?.finalUrl) entry.finalUrl = latest.finalUrl;
      }
      if (entry.state === 'in_progress') {
        allSettled = false;
      }
    }
    if (allSettled) break;
    await sleep(300);
  }

  // Deduplicate by reportKey (keep latest completed download for each report)
  const latestByKey = new Map();
  for (const entry of session.downloads.values()) {
    if (entry.state === 'interrupted') continue;
    latestByKey.set(entry.reportKey, entry);
  }

  if (latestByKey.size === 0) return false;

  const fileEntries = [];
  for (const entry of latestByKey.values()) {
    const bytes = await fetchDownloadBytes(entry);
    if (!bytes) {
      console.warn(
        `[TikTok Extension] Skipping background summary calculation: could not fetch ${entry.fileName}`
      );
      return false;
    }
    fileEntries.push({
      fileName: entry.fileName,
      contentKey: entry.reportKey.startsWith('live') ? 'live' : 'video',
      bytes
    });
  }

  fileEntries.sort((a, b) => a.fileName.localeCompare(b.fileName));
  const { summaryRows, breakdownRows } = await ReportCalculator.aggregateReportEntries(
    session.sellerId,
    session.periodLabel,
    fileEntries
  );
  if (breakdownRows.length === 0) return false;

  const workbookUint8 = ReportCalculator.buildWorkbookFromSummaryData(summaryRows, breakdownRows);
  const b64 = uint8ToBase64(workbookUint8);
  const summaryFilename = `CE-Reports/${session.sellerId}_${session.periodLabel}/Summary_${session.sellerId}_${session.periodLabel}.xlsx`;

  await new Promise((resolve) => {
    chrome.downloads.download(
      {
        url: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${b64}`,
        filename: summaryFilename,
        conflictAction: 'overwrite',
        saveAs: false
      },
      () => {
        void chrome.runtime.lastError;
        resolve();
      }
    );
  });
  return true;
}

async function runBackgroundExportWorkflow(sourceTabId, reportUrls, periodConfig, scope = 'all') {
  const normalizedScope = scope === 'live' || scope === 'video' ? scope : 'all';

  await hydrateCaches();
  await chrome.storage.local.remove(['ttk_workflow_log']);
  await chrome.storage.local.set({ ttk_workflow_running: normalizedScope });

  const activeShop = cachedSellerPayload?.active_shop || cachedSellerPayload?.shops?.[0];
  const initialSellerId = sanitizeFilenamePart(activeShop?.formatted_seller_id, 'UNKNOWN_SELLER');
  const rawPeriod = periodConfig?.mode === 'month' ? periodConfig?.month : periodConfig?.date;
  const initialPeriod = sanitizeFilenamePart(rawPeriod, getTodayLocalDateStr());

  activeExportSession = {
    sellerId: initialSellerId,
    periodLabel: initialPeriod,
    downloads: new Map()
  };

  let workerTabId = null;

  try {
    let windowId;
    if (sourceTabId) {
      try {
        const sourceTab = await chrome.tabs.get(sourceTabId);
        windowId = sourceTab?.windowId;
      } catch {
        windowId = undefined;
      }
    }

    const initialUrl =
      normalizedScope === 'video' ? reportUrls.video_details : reportUrls.live_details;

    const createOpts = {
      url: initialUrl,
      active: false,
      pinned: true
    };
    if (typeof windowId === 'number') {
      createOpts.windowId = windowId;
    }

    const workerTab = await chrome.tabs.create(createOpts);
    workerTabId = workerTab?.id || null;
    if (!workerTabId) {
      throw new Error('Failed to create background worker tab');
    }

    let liveRes = null;
    let videoRes = null;

    if (normalizedScope === 'live') {
      saveWorkflowLog('⏳ Exporting LIVE Reports in background tab...', 'info');
      liveRes = await waitAndRunPageWorkflow(workerTabId, periodConfig);
      if (liveRes && !liveRes.ok) {
        throw new Error(liveRes.error || 'LIVE export failed');
      }
      await sleep(2000);
    } else if (normalizedScope === 'video') {
      saveWorkflowLog('⏳ Exporting Video Reports in background tab...', 'info');
      videoRes = await waitAndRunPageWorkflow(workerTabId, periodConfig);
      if (videoRes && !videoRes.ok) {
        throw new Error(videoRes.error || 'Video export failed');
      }
      await sleep(3000);
    } else {
      saveWorkflowLog('⏳ Exporting LIVE Reports in background tab...', 'info');
      liveRes = await waitAndRunPageWorkflow(workerTabId, periodConfig);
      if (liveRes && !liveRes.ok) {
        throw new Error(liveRes.error || 'LIVE export failed');
      }
      await sleep(1200);
      saveWorkflowLog('⏳ Exporting Video Reports in background tab...', 'info');
      videoRes = await navigateAndRunPageWorkflow(workerTabId, reportUrls.video_details, periodConfig);
      if (videoRes && !videoRes.ok) {
        throw new Error(videoRes.error || 'Video export failed');
      }
      await sleep(3000);
    }

    try {
      await tryGenerateAndDownloadSummary(activeExportSession);
    } catch (calcErr) {
      console.warn('[TikTok Extension] Summary workbook export skipped:', calcErr);
    }

    const label = EXPORT_SCOPE_LABELS[normalizedScope];
    saveWorkflowLog(`✓ Completed: ${label} exported!`, 'success');
    return { ok: true, scope: normalizedScope, liveRes, videoRes };
  } catch (err) {
    saveWorkflowLog(err.message || String(err), 'error');
    return { ok: false, error: err.message || String(err) };
  } finally {
    activeExportSession = null;
    if (workerTabId) {
      try {
        await chrome.tabs.remove(workerTabId);
      } catch {
        // Tab may already be closed
      }
    }
    await chrome.storage.local.set({ ttk_workflow_running: false });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'SAVE_SELLER_DATA') {
    const payload = message.payload;
    if (!payload || !payload.shops) {
      sendResponse({ success: false });
      return;
    }

    cachedSellerPayload = payload;
    chrome.storage.local.set(
      {
        ttk_seller_payload: payload,
        ttk_last_updated: Date.now()
      },
      () => {
        const activeShop = payload.active_shop || payload.shops[0];
        const badgeText = activeShop?.country || `${payload.shops.length}`;
        chrome.action.setBadgeText({ text: badgeText });
        chrome.action.setBadgeBackgroundColor({ color: '#fe2c55' });
        sendResponse({ success: true, saved: payload.shops.length });
      }
    );
    return true;
  }

  if (message.action === 'CHECK_BACKGROUND_READY') {
    sendResponse({
      ok: true,
      version: BG_VERSION,
      hasDownloadsOnDetermining: Boolean(chrome.downloads && chrome.downloads.onDeterminingFilename)
    });
    return false;
  }

  if (message.action === 'SET_EXPECTED_DOWNLOAD') {
    cachedExpectedDownload = {
      sellerId: message.sellerId || null,
      reportKey: message.reportKey || null,
      periodConfig: message.periodConfig || null,
      timestamp: message.timestamp || Date.now()
    };
    if (message.periodConfig) {
      cachedPeriodConfig = message.periodConfig;
    }
    chrome.storage.local.set({ ttk_expected_download: cachedExpectedDownload });
    sendResponse({ ok: true, routedFolder: 'CE-Reports' });
    return false;
  }

  if (message.action === 'UPDATE_REPORT_STATUS') {
    updateReportChecklistStorage(message.reportKey, message.status, message.message);
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'WORKFLOW_LOG') {
    saveWorkflowLog(message.text, message.isError ? 'error' : 'info');
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'RUN_CURRENT_TAB_WORKFLOW') {
    const { tabId, periodConfig } = message;
    sendMessageWithAutoInject(tabId, {
      action: 'RUN_PAGE_WORKFLOW',
      periodConfig
    }).then((res) => {
      sendResponse(res);
    });
    return true;
  }

  if (message.action === 'START_EXPORT_WORKFLOW' || message.action === 'START_FULL_WORKFLOW') {
    const { tabId, reportUrls, periodConfig, scope } = message;
    runBackgroundExportWorkflow(tabId, reportUrls, periodConfig, scope || 'all');
    sendResponse({ ok: true, started: true, version: BG_VERSION });
    return false;
  }

  if (message.action === 'BACKGROUND_SLEEP') {
    const ms = Math.max(0, Math.min(Number(message.ms) || 0, 30000));
    setTimeout(() => {
      sendResponse({ ok: true });
    }, ms);
    return true;
  }

  if (message.action === 'CLEAR_SELLER_DATA') {
    cachedSellerPayload = null;
    cachedExpectedDownload = null;
    chrome.storage.local.remove(
      [
        'ttk_seller_payload',
        'ttk_last_updated',
        'ttk_report_statuses',
        'ttk_workflow_running',
        'ttk_workflow_log',
        'ttk_expected_download',
        'ttk_captured_apis'
      ],
      () => {
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ success: true });
      }
    );
    return true;
  }
});
