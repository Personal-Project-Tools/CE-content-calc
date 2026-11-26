const BG_VERSION = '2.2.5';

const REPORT_PREFIX_MAP = {
  live_linked: '1_LIVE_Linked',
  live_affiliate: '2_LIVE_Affiliate',
  video_linked: '3_Video_Linked',
  video_affiliate: '4_Video_Affiliate'
};

const EXPECTED_DOWNLOAD_TTL_MS = 60000;
const TIKTOK_DOMAIN_KEYWORDS = [
  'tiktok',
  'tokopedia',
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
let cachedSheetClientMap = null;
let cachedSheetMapUpdatedAt = 0;
let cachedGoogleAccessToken = null;
let cachedGoogleTokenExpiresAt = 0;
let inflightSheetMapPromise = null;
let cacheHydrated = false;
let hydratePromise = null;

const SHEET_CACHE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const utf8Encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeUtf8Base64Url(text) {
  return bytesToBase64Url(utf8Encoder.encode(text));
}

function stripYamlScalar(rawVal) {
  const withoutComment = String(rawVal || '').split('#')[0].trim();
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1).trim();
  }
  return withoutComment;
}

function normalizeA1RangeJs(rawRange) {
  const cleaned = stripYamlScalar(rawRange);
  const shorthand = cleaned.match(/column\[\s*([A-Za-z]+)\s*\]\s*-\s*row\[\s*(\d+)\s*\]/i);
  if (shorthand) {
    const col = shorthand[1].toUpperCase();
    return `${col}${shorthand[2]}:${col}`;
  }
  return cleaned;
}

function parseSheetYamlText(yamlText) {
  const kv = {};
  for (const line of String(yamlText || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const val = stripYamlScalar(trimmed.slice(colonIdx + 1));
    if (val !== '') {
      kv[key] = val;
    }
  }

  const spreadsheetId = kv.spreadsheet_id || kv.root_spreadsheet || '';
  const worksheet = kv.worksheet || kv.tab_sheet || 'seller_scope';
  const sellerFullMatchRange = normalizeA1RangeJs(kv.seller_full_match || 'AV4:AV');
  const sellerUsedIdRange = normalizeA1RangeJs(kv.seller_used_id || kv.seller_id_range || 'AW4:AW');
  const activeStatusRange = kv.active_status
    ? normalizeA1RangeJs(kv.active_status)
    : '';
  const credentialsFile = (kv.credentials_file || 'config/service.json')
    .replace(/\\+/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/^extension\/+/i, '');
  const platform = (kv.platform || kv.platform_filter || 'TTK').toUpperCase();
  const activeOnly = kv.active_only
    ? ['true', '1', 'yes'].includes(kv.active_only.toLowerCase())
    : Boolean(activeStatusRange);

  if (!spreadsheetId || spreadsheetId.startsWith('<')) {
    throw new Error('Missing valid spreadsheet_id in config/sheet.yaml');
  }

  return {
    credentialsFile,
    spreadsheetId,
    worksheet,
    sellerFullMatchRange,
    sellerUsedIdRange,
    activeStatusRange,
    platform,
    activeOnly
  };
}

async function importServiceAccountPrivateKey(pem) {
  const b64 = String(pem || '').replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g,
    ''
  );
  const bin = atob(b64);
  const der = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function getGoogleSheetsAccessToken(serviceAccount) {
  const nowMs = Date.now();
  if (cachedGoogleAccessToken && nowMs < cachedGoogleTokenExpiresAt - 60_000) {
    return cachedGoogleAccessToken;
  }

  const nowSec = Math.floor(nowMs / 1000);
  const tokenUri = serviceAccount.token_uri || GOOGLE_TOKEN_URI;
  const headerB64 = encodeUtf8Base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimsB64 = encodeUtf8Base64Url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: GOOGLE_SHEETS_READONLY_SCOPE,
      aud: tokenUri,
      iat: nowSec,
      exp: nowSec + 3600
    })
  );

  const signingInput = `${headerB64}.${claimsB64}`;
  const cryptoKey = await importServiceAccountPrivateKey(serviceAccount.private_key);
  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    utf8Encoder.encode(signingInput)
  );
  const jwt = `${signingInput}.${bytesToBase64Url(new Uint8Array(sigBuffer))}`;

  const tokenRes = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    }),
    signal: AbortSignal.timeout(10_000)
  });

  if (!tokenRes.ok) {
    throw new Error(`OAuth token HTTP ${tokenRes.status}`);
  }

  const tokenData = await tokenRes.json();
  cachedGoogleAccessToken = tokenData.access_token;
  cachedGoogleTokenExpiresAt = nowMs + (Number(tokenData.expires_in) || 3600) * 1000;
  return cachedGoogleAccessToken;
}

async function fetchSheetClientMappingFromGoogle() {
  const sheetYamlUrl = chrome.runtime.getURL('config/sheet.yaml');
  const yamlRes = await fetch(sheetYamlUrl, { cache: 'no-store' });
  if (!yamlRes.ok) {
    throw new Error('Could not read extension/config/sheet.yaml (run setup-reports-junction.bat)');
  }
  const cfg = parseSheetYamlText(await yamlRes.text());

  const credsRelPath = cfg.credentialsFile.startsWith('config/')
    ? cfg.credentialsFile
    : `config/${cfg.credentialsFile}`;
  const credsRes = await fetch(chrome.runtime.getURL(credsRelPath), { cache: 'no-store' });
  if (!credsRes.ok) {
    throw new Error(`Could not read ${credsRelPath}`);
  }
  const serviceAccount = await credsRes.json();
  const accessToken = await getGoogleSheetsAccessToken(serviceAccount);

  const safeSheet = cfg.worksheet.replace(/'/g, "''");
  const batchUrl = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.spreadsheetId)}/values:batchGet`
  );
  batchUrl.searchParams.append('ranges', `'${safeSheet}'!${cfg.sellerFullMatchRange}`);
  batchUrl.searchParams.append('ranges', `'${safeSheet}'!${cfg.sellerUsedIdRange}`);
  if (cfg.activeStatusRange) {
    batchUrl.searchParams.append('ranges', `'${safeSheet}'!${cfg.activeStatusRange}`);
  }

  const sheetRes = await fetch(batchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(12_000)
  });
  if (!sheetRes.ok) {
    throw new Error(`Google Sheets HTTP ${sheetRes.status}`);
  }

  const sheetJson = await sheetRes.json();
  const valueRanges = sheetJson.valueRanges || [];
  const fullRows = valueRanges[0]?.values || [];
  const idRows = valueRanges[1]?.values || [];
  const statusRows = valueRanges[2]?.values || [];

  const totalRows = Math.max(fullRows.length, idRows.length, statusRows.length);
  const platformToken = cfg.platform ? `.${cfg.platform}.` : '';
  const buckets = new Map();

  for (let i = 0; i < totalRows; i++) {
    const fullVal = String(fullRows[i]?.[0] || '').trim();
    const idVal = String(idRows[i]?.[0] || '').trim();
    if (!fullVal && !idVal) continue;

    if (cfg.activeStatusRange && cfg.activeOnly) {
      const statusVal = String(statusRows[i]?.[0] || '').trim().toUpperCase();
      if (statusVal !== 'TRUE') continue;
    }

    const candidateUpper = `${idVal} ${fullVal}`.toUpperCase();
    if (platformToken && !candidateUpper.includes(platformToken)) continue;
    if (idVal.toUpperCase().endsWith('.TBD') || fullVal.toUpperCase().endsWith('.TBD')) continue;

    const clientName = fullVal.includes(' - ')
      ? fullVal.split(' - ', 1)[0].trim()
      : '';
    if (!clientName) continue;

    const codeKey = (idVal || fullVal.split(' - ').pop() || '').trim().toUpperCase();
    if (!codeKey) continue;

    const candidateKeys = new Set([codeKey]);
    const codeMatch = `${idVal} ${fullVal}`.toUpperCase().match(/([A-Z]{2}\.[A-Z]{3}\.\d+)/);
    if (codeMatch) {
      candidateKeys.add(codeMatch[1]);
    }

    for (const key of candidateKeys) {
      let list = buckets.get(key);
      if (!list) {
        list = [];
        buckets.set(key, list);
      }
      if (!list.includes(clientName)) {
        list.push(clientName);
      }
    }
  }

  const clientMap = {};
  for (const [codeKey, clients] of buckets.entries()) {
    clientMap[codeKey] = clients.join(', ');
  }

  cachedSheetClientMap = clientMap;
  cachedSheetMapUpdatedAt = Date.now();
  chrome.storage.local.set({
    ttk_sheet_client_cache: {
      map: clientMap,
      updatedAt: cachedSheetMapUpdatedAt
    }
  });
  return clientMap;
}

async function getSheetClientMap(forceRefresh = false) {
  await hydrateCaches();
  const isFresh =
    cachedSheetClientMap && Date.now() - cachedSheetMapUpdatedAt < SHEET_CACHE_TTL_MS;
  if (!forceRefresh && isFresh) {
    return cachedSheetClientMap;
  }
  if (!inflightSheetMapPromise) {
    inflightSheetMapPromise = fetchSheetClientMappingFromGoogle().finally(() => {
      inflightSheetMapPromise = null;
    });
  }
  return inflightSheetMapPromise;
}

async function resolveClientForSellerId(sellerId, forceRefresh = false) {
  const key = String(sellerId || '').trim().toUpperCase();
  if (!key) {
    return { ok: true, client: 'Unmapped', unmapped: true };
  }
  try {
    const clientMap = await getSheetClientMap(forceRefresh);
    const matchedClient = clientMap?.[key];
    if (matchedClient) {
      return { ok: true, client: matchedClient, unmapped: false };
    }
    return { ok: true, client: 'Unmapped', unmapped: true };
  } catch (err) {
    console.warn('[TikTok Extension] Client lookup failed:', new Error('Sheet lookup error', { cause: err }));
    return { ok: false, client: 'Unmapped', unmapped: true, error: err.message || String(err) };
  }
}

function hydrateCaches() {
  if (hydratePromise) return hydratePromise;
  hydratePromise = new Promise((resolve) => {
    chrome.storage.local.get(
      [
        'ttk_seller_payload',
        'ttk_period_config',
        'ttk_expected_download',
        'ttk_sheet_client_cache'
      ],
      (res) => {
        if (res.ttk_seller_payload) cachedSellerPayload = res.ttk_seller_payload;
        if (res.ttk_period_config) cachedPeriodConfig = res.ttk_period_config;
        if (res.ttk_expected_download) cachedExpectedDownload = res.ttk_expected_download;
        if (res.ttk_sheet_client_cache?.map) {
          cachedSheetClientMap = res.ttk_sheet_client_cache.map;
          cachedSheetMapUpdatedAt = res.ttk_sheet_client_cache.updatedAt || 0;
        }
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

  const relativePath = `CE-Reports/${periodLabel}/${sellerId}/${reportPrefix}${ext}`;
  suggest({ filename: relativePath, conflictAction: 'overwrite' });
}

// Route TikTok reports through the Downloads/CE-Reports junction into repo Reports/
// Must call suggest() synchronously in MV3 service workers so Chromium applies the override reliably.
if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    resolveDownloadSuggestion(downloadItem, suggest);
  });
}

let lastChromeDownloadCreatedAt = 0;
const recentTriggeredDownloadUrls = new Set();

// Notify active Seller Center tabs whenever Chrome starts a download (used for smart Export retry)
if (chrome.downloads && chrome.downloads.onCreated) {
  chrome.downloads.onCreated.addListener((downloadItem) => {
    const now = Date.now();
    lastChromeDownloadCreatedAt = now;
    if (downloadItem.url) {
      recentTriggeredDownloadUrls.add(downloadItem.url);
    }
    if (downloadItem.finalUrl) {
      recentTriggeredDownloadUrls.add(downloadItem.finalUrl);
    }
    chrome.tabs.query(
      {
        url: [
          'https://*.tiktok.com/*',
          'https://*.tiktokglobalshop.com/*',
          'https://*.tokopedia.com/*'
        ]
      },
      (tabs) => {
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
              files: ['src/content/content.js']
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

async function waitAndRunPageWorkflow(tabId, periodConfig, sellerId = null) {
  await sleep(1500);
  await waitForTabComplete(tabId, 25000);
  // Give React + Arco time to render #page-title-datepicker and table
  await sleep(3500);

  return sendMessageWithAutoInject(tabId, {
    action: 'RUN_PAGE_WORKFLOW',
    periodConfig,
    sellerId
  });
}

async function navigateAndRunPageWorkflow(tabId, targetUrl, periodConfig, sellerId = null) {
  await chrome.tabs.update(tabId, { url: targetUrl });
  return waitAndRunPageWorkflow(tabId, periodConfig, sellerId);
}

const EXPORT_SCOPE_LABELS = {
  all: 'All 4 Reports',
  live: 'LIVE Reports',
  video: 'Video Reports'
};

async function runBackgroundExportWorkflow(
  sourceTabId,
  reportUrls,
  periodConfig,
  scope = 'all',
  explicitSellerId = null
) {
  const normalizedScope = scope === 'live' || scope === 'video' ? scope : 'all';

  await hydrateCaches();
  const activeShop = cachedSellerPayload?.active_shop || cachedSellerPayload?.shops?.[0];
  const lockedSellerId = explicitSellerId || activeShop?.formatted_seller_id || null;

  await chrome.storage.local.remove(['ttk_workflow_log']);
  await chrome.storage.local.set({ ttk_workflow_running: normalizedScope });

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
      liveRes = await waitAndRunPageWorkflow(workerTabId, periodConfig, lockedSellerId);
      if (liveRes && !liveRes.ok) {
        throw new Error(liveRes.error || 'LIVE export failed');
      }
      await sleep(2500);
    } else if (normalizedScope === 'video') {
      saveWorkflowLog('⏳ Exporting Video Reports in background tab...', 'info');
      videoRes = await waitAndRunPageWorkflow(workerTabId, periodConfig, lockedSellerId);
      if (videoRes && !videoRes.ok) {
        throw new Error(videoRes.error || 'Video export failed');
      }
      await sleep(3000);
    } else {
      saveWorkflowLog('⏳ Exporting LIVE Reports in background tab...', 'info');
      liveRes = await waitAndRunPageWorkflow(workerTabId, periodConfig, lockedSellerId);
      if (liveRes && !liveRes.ok) {
        throw new Error(liveRes.error || 'LIVE export failed');
      }
      await sleep(1500);
      saveWorkflowLog('⏳ Exporting Video Reports in background tab...', 'info');
      videoRes = await navigateAndRunPageWorkflow(
        workerTabId,
        reportUrls.video_details,
        periodConfig,
        lockedSellerId
      );
      if (videoRes && !videoRes.ok) {
        throw new Error(videoRes.error || 'Video export failed');
      }
      await sleep(3000);
    }

    const label = EXPORT_SCOPE_LABELS[normalizedScope];
    saveWorkflowLog(`✓ Completed: ${label} exported!`, 'success');
    return { ok: true, scope: normalizedScope, liveRes, videoRes };
  } catch (err) {
    saveWorkflowLog(err.message || String(err), 'error');
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

    const activeShop = payload.active_shop || payload.shops[0];
    if (activeShop?.formatted_seller_id && cachedSheetClientMap) {
      const matched = cachedSheetClientMap[activeShop.formatted_seller_id.toUpperCase()];
      if (matched) {
        activeShop.resolved_client = matched;
      }
    }

    cachedSellerPayload = payload;
    chrome.storage.local.set(
      {
        ttk_seller_payload: payload,
        ttk_last_updated: Date.now()
      },
      () => {
        const badgeText = activeShop?.country || `${payload.shops.length}`;
        chrome.action.setBadgeText({ text: badgeText });
        chrome.action.setBadgeBackgroundColor({ color: '#fe2c55' });
        sendResponse({ success: true, saved: payload.shops.length });
      }
    );
    return true;
  }

  if (message.action === 'RESOLVE_SELLER_CLIENT') {
    resolveClientForSellerId(message.sellerId, Boolean(message.forceRefresh)).then((res) => {
      sendResponse(res);
    });
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
    const { tabId, reportUrls, periodConfig, scope, sellerId } = message;
    runBackgroundExportWorkflow(tabId, reportUrls, periodConfig, scope || 'all', sellerId || null);
    sendResponse({ ok: true, started: true, version: BG_VERSION });
    return false;
  }

  if (message.action === 'FALLBACK_DIRECT_DOWNLOAD') {
    const targetUrl = String(message.url || '').trim();
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      sendResponse({ ok: false });
      return false;
    }
    setTimeout(() => {
      const recentlyStarted =
        recentTriggeredDownloadUrls.has(targetUrl) ||
        Date.now() - lastChromeDownloadCreatedAt < 900;
      if (!recentlyStarted && chrome.downloads && chrome.downloads.download) {
        recentTriggeredDownloadUrls.add(targetUrl);
        chrome.downloads.download({ url: targetUrl, saveAs: false }, () => {
          void chrome.runtime.lastError;
        });
      }
    }, 550);
    sendResponse({ ok: true });
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
