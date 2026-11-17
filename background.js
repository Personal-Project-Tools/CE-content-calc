/**
 * Background Service Worker (Manifest V3)
 * Manages seller state, monitors Chrome report downloads, routes TikTok reports to CE-Reports/,
 * and orchestrates the 4-report workflow across LIVE -> Details and Video -> Details pages.
 */

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
  console.log('[TikTok Extension] Extension installed successfully.');
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

  const relativePath = `CE-Reports/${sellerId}_${periodLabel}/${reportPrefix}${ext}`;
  suggest({ filename: relativePath, conflictAction: 'overwrite' });
  saveWorkflowLog(`Saved to Reports/${sellerId}_${periodLabel}/${reportPrefix}${ext}`);
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

function saveWorkflowLog(text, isError = false) {
  chrome.storage.local.set({
    ttk_workflow_log: {
      text,
      isError,
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
  saveWorkflowLog('Background: sending command to tab...');
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, async (response) => {
      if (chrome.runtime.lastError) {
        saveWorkflowLog(`Background: tab not reachable (${chrome.runtime.lastError.message}) -> injecting content.js...`, true);
      }
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
  saveWorkflowLog(`Loading ${targetUrl.includes('live-details') ? 'LIVE Details' : 'Video Details'} in background...`);
  await chrome.tabs.update(tabId, { url: targetUrl });
  return waitAndRunPageWorkflow(tabId, periodConfig);
}

async function runFullFourReportWorkflow(sourceTabId, reportUrls, periodConfig) {
  const initialStatuses = {
    live_linked: { status: 'pending', message: 'Queued' },
    live_affiliate: { status: 'pending', message: 'Queued' },
    video_linked: { status: 'pending', message: 'Queued' },
    video_affiliate: { status: 'pending', message: 'Queued' }
  };
  await chrome.storage.local.set({
    ttk_report_statuses: initialStatuses,
    ttk_workflow_running: true
  });

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

    saveWorkflowLog('Opening silent background tab for LIVE Details...');
    const createOpts = {
      url: reportUrls.live_details,
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

    // Phase 1: LIVE -> Details (2 reports: Linked + Affiliate)
    const liveRes = await waitAndRunPageWorkflow(workerTabId, periodConfig);

    await sleep(1200);

    // Phase 2: Video -> Details (2 reports: Linked + Affiliate, re-selects Date/Month)
    const videoRes = await navigateAndRunPageWorkflow(workerTabId, reportUrls.video_details, periodConfig);

    await sleep(1000);
    saveWorkflowLog('All 4 background export steps finished!');
    return { ok: true, liveRes, videoRes };
  } catch (err) {
    saveWorkflowLog(err.message || String(err), true);
    return { ok: false, error: err.message || String(err) };
  } finally {
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
    saveWorkflowLog(message.text, message.isError);
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

  if (message.action === 'START_FULL_WORKFLOW') {
    const { tabId, reportUrls, periodConfig } = message;
    runFullFourReportWorkflow(tabId, reportUrls, periodConfig).then((res) => {
      sendResponse(res);
    });
    return true;
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
