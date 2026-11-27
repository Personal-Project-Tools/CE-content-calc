/**
 * Popup Script for TikTok Shop Calculator & Seller ID Extension
 * Implements Modern Web Guidance standards for accessible copy buttons and UI state.
 */

// --- Modern Web Guidance: Accessible Copy Button Implementation ---
const timers = new WeakMap();
let lastReportMessage = '';

function legacyCopy(text) {
  const field = Object.assign(document.createElement('textarea'), { value: text });
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
  }
}

async function copy(button, target, command = '--copy') {
  if (!target) return;
  const text = target.matches('input, textarea') ? target.value : target.innerText.trim();
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    report(button, true);
  } catch {
    if (legacyCopy(text)) {
      report(button, true);
    } else {
      report(button, false);
    }
  }
}

function report(button, ok) {
  const tip = button.nextElementSibling; // the role="status" bubble
  if (!tip) return;

  clearTimeout(timers.get(button));
  button.removeAttribute('data-copied');
  button.removeAttribute('data-failed');

  let message = ok ? 'Copied!' : 'Copy failed';
  // Accessibility fix for VoiceOver repeated announcement
  if (message === lastReportMessage) {
    message += '\u00A0';
  }
  lastReportMessage = message;

  tip.textContent = '';
  void button.offsetWidth; // trigger reflow to restart CSS animation

  button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
  requestAnimationFrame(() => {
    tip.textContent = message;
  });

  timers.set(
    button,
    setTimeout(() => {
      button.removeAttribute('data-copied');
      button.removeAttribute('data-failed');
      tip.textContent = '';
    }, 2000)
  );
}

// 1. Invoker Commands handler (capture phase on document)
document.addEventListener(
  'command',
  (event) => {
    if (event.command && event.command.startsWith('--copy')) {
      copy(event.source, event.target, event.command);
    }
  },
  true
);

// 2. Progressive enhancement fallback for browsers without CommandEvent
if (!('CommandEvent' in window)) {
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[command^="--copy"]');
    if (!button) return;
    const target = document.getElementById(button.getAttribute('commandfor'));
    if (target) {
      copy(button, target, button.getAttribute('command'));
    }
  });
}

// --- Chrome Extension UI State & Data Management ---

document.addEventListener('DOMContentLoaded', () => {
  const statusBadge = document.getElementById('connection-status');
  const statusText = document.getElementById('status-text');
  const emptyState = document.getElementById('empty-state');
  const sellerSection = document.getElementById('seller-section');

  const shopClient = document.getElementById('shop-client');
  const formattedSellerId = document.getElementById('formatted-seller-id');
  const regionParamBadge = document.getElementById('region-param-badge');

  const modeBtnDay = document.getElementById('mode-btn-day');
  const modeBtnMonth = document.getElementById('mode-btn-month');
  const fieldDayWrapper = document.getElementById('field-day-wrapper');
  const fieldMonthWrapper = document.getElementById('field-month-wrapper');
  const inputSingleDate = document.getElementById('input-single-date');
  const inputTargetMonth = document.getElementById('input-target-month');

  const btnExportAll = document.getElementById('btn-export-all');
  const btnExportLive = document.getElementById('btn-export-live');
  const btnExportVideo = document.getElementById('btn-export-video');
  const workflowLogBox = document.getElementById('workflow-log-box');

  let currentReportUrls = null;
  let currentPeriodMode = 'day'; // 'day' | 'month'

  function renderWorkflowLog(logObj) {
    if (!workflowLogBox) return;
    if (!logObj || !logObj.text) {
      workflowLogBox.classList.add('hidden');
      workflowLogBox.classList.remove('log-error', 'log-success');
      return;
    }
    workflowLogBox.classList.remove('hidden');
    workflowLogBox.classList.toggle('log-error', Boolean(logObj.isError));
    workflowLogBox.classList.toggle('log-success', Boolean(logObj.isSuccess));
    workflowLogBox.textContent = logObj.text;
  }

  function getPeriodConfigFromInputs() {
    return {
      mode: currentPeriodMode,
      date: inputSingleDate?.value || getDefaultYesterdayStr(),
      month: inputTargetMonth?.value || getDefaultPreviousMonthStr()
    };
  }

  function renderExportButtonsState(runningScope = false) {
    const isRunning = Boolean(runningScope);
    const activeScope = typeof runningScope === 'string' ? runningScope : null;

    if (btnExportAll) {
      btnExportAll.disabled = isRunning;
      btnExportAll.textContent =
        isRunning && activeScope === 'all'
          ? '⏳ Exporting All 4 Reports...'
          : '▶ Auto Export All 4 Reports';
    }
    if (btnExportLive) {
      btnExportLive.disabled = isRunning;
      btnExportLive.textContent =
        isRunning && activeScope === 'live' ? '⏳ Exporting LIVE...' : 'Export LIVE Reports';
    }
    if (btnExportVideo) {
      btnExportVideo.disabled = isRunning;
      btnExportVideo.textContent =
        isRunning && activeScope === 'video' ? '⏳ Exporting Video...' : 'Export Video Reports';
    }
  }

  function loadWorkflowState() {
    chrome.storage.local.get(['ttk_workflow_running', 'ttk_workflow_log'], (res) => {
      renderExportButtonsState(res.ttk_workflow_running || false);
      renderWorkflowLog(res.ttk_workflow_log || null);
    });
  }

  function getDefaultYesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function getDefaultPreviousMonthStr() {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${yyyy}-${mm}`;
  }

  function applyModeUI(mode) {
    currentPeriodMode = mode === 'month' ? 'month' : 'day';
    const isDay = currentPeriodMode === 'day';

    if (modeBtnDay && modeBtnMonth) {
      modeBtnDay.classList.toggle('active', isDay);
      modeBtnDay.setAttribute('aria-selected', String(isDay));
      modeBtnMonth.classList.toggle('active', !isDay);
      modeBtnMonth.setAttribute('aria-selected', String(!isDay));
    }

    if (fieldDayWrapper && fieldMonthWrapper) {
      fieldDayWrapper.classList.toggle('hidden', !isDay);
      fieldMonthWrapper.classList.toggle('hidden', isDay);
    }
  }

  function loadStoredPeriodConfig() {
    chrome.storage.local.get(['ttk_period_config'], (res) => {
      const defaultDate = getDefaultYesterdayStr();
      const defaultMonth = getDefaultPreviousMonthStr();
      const config = res.ttk_period_config || {
        mode: 'day',
        date: defaultDate,
        month: defaultMonth
      };

      if (inputSingleDate) inputSingleDate.value = config.date || defaultDate;
      if (inputTargetMonth) inputTargetMonth.value = config.month || defaultMonth;
      applyModeUI(config.mode || 'day');

      if (!res.ttk_period_config) {
        chrome.storage.local.set({ ttk_period_config: config });
      }
    });
  }

  function savePeriodConfig() {
    const config = {
      mode: currentPeriodMode,
      date: inputSingleDate?.value || getDefaultYesterdayStr(),
      month: inputTargetMonth?.value || getDefaultPreviousMonthStr()
    };
    chrome.storage.local.set({ ttk_period_config: config });
  }

  if (modeBtnDay) {
    modeBtnDay.addEventListener('click', () => {
      applyModeUI('day');
      savePeriodConfig();
    });
  }

  if (modeBtnMonth) {
    modeBtnMonth.addEventListener('click', () => {
      applyModeUI('month');
      savePeriodConfig();
    });
  }

  if (inputSingleDate) inputSingleDate.addEventListener('change', savePeriodConfig);
  if (inputTargetMonth) inputTargetMonth.addEventListener('change', savePeriodConfig);
  loadStoredPeriodConfig();
  loadWorkflowState();

  // Verify background service worker is up-to-date and downloads.onDeterminingFilename is active
  const EXPECTED_BG_VERSION = '2.2.7';
  chrome.runtime.sendMessage({ action: 'CHECK_BACKGROUND_READY' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      renderWorkflowLog({
        text: '⚠️ Please click Reload (🔄) on chrome://extensions to activate Reports/ folder routing.',
        isError: true
      });
      return;
    }

    if (res.version !== EXPECTED_BG_VERSION) {
      if (localStorage.getItem('ttk_bg_reload_v') !== EXPECTED_BG_VERSION) {
        localStorage.setItem('ttk_bg_reload_v', EXPECTED_BG_VERSION);
        chrome.runtime.reload();
        return;
      }
      renderWorkflowLog({
        text: '⚠️ Background service worker is outdated. Please click Reload (🔄) on chrome://extensions.',
        isError: true
      });
      return;
    }

    if (!res.hasDownloadsOnDetermining) {
      renderWorkflowLog({
        text: '⚠️ Please click Reload (🔄) on chrome://extensions to activate Reports/ folder routing.',
        isError: true
      });
    }
  });

  function isSupportedSellerUrl(rawUrl) {
    if (!rawUrl) return false;
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      return (
        (host.includes('seller') && (host.includes('tiktok.com') || host.includes('tokopedia.com'))) ||
        host.includes('tiktokglobalshop.com') ||
        host.includes('id.tokopedia.com')
      );
    } catch {
      return false;
    }
  }

  function buildFallbackReportUrls(country, tabUrl) {
    const region = (country || 'SG').toUpperCase();
    let origin =
      region === 'ID'
        ? 'https://seller-id.tokopedia.com'
        : `https://seller-${region.toLowerCase()}.tiktok.com`;
    try {
      if (tabUrl && (tabUrl.includes('tiktok') || tabUrl.includes('tokopedia'))) {
        origin = new URL(tabUrl).origin;
      }
    } catch {
      // keep default origin
    }
    return {
      live_details: `${origin}/compass/live-analysis/live-details?shop_region=${encodeURIComponent(region)}`,
      video_details: `${origin}/compass/video-analytics/video-details?platform_data_source=shop&shop_region=${encodeURIComponent(region)}`
    };
  }

  const btnRefresh = document.getElementById('btn-refresh');
  const btnClear = document.getElementById('btn-clear');
  const btnOpenSeller = document.getElementById('btn-open-seller');

  function requestLiveTabSellerRefresh(tabId, forceNetwork = false, onDone = null) {
    if (!tabId) {
      loadStoredData(forceNetwork);
      if (onDone) onDone();
      return;
    }
    chrome.runtime.sendMessage(
      {
        action: 'FORCE_REFRESH_TAB_SELLER',
        tabId,
        forceNetwork
      },
      (res) => {
        void chrome.runtime.lastError;
        if (res?.ok && res.payload) {
          renderShopData(res.payload, forceNetwork);
        } else {
          loadStoredData(forceNetwork);
        }
        if (onDone) onDone();
      }
    );
  }

  // Check active tab domain
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    const isTikTokTab = isSupportedSellerUrl(activeTab?.url);

    if (isTikTokTab && activeTab?.id) {
      statusBadge.className = 'status-badge status-connected';
      statusText.textContent = 'Seller Center Tab';
      loadStoredData(false);
      // Sync live seller state from the active tab (even if tab was opened before extension reload)
      requestLiveTabSellerRefresh(activeTab.id, false);
    } else {
      statusBadge.className = 'status-badge status-inactive';
      statusText.textContent = 'Not on TikTok';
      loadStoredData(false);
    }
  });

  function loadStoredData(forceRefreshClient = false) {
    chrome.storage.local.get(['ttk_seller_payload'], (result) => {
      const payload = result.ttk_seller_payload;
      if (payload && payload.shops && payload.shops.length > 0) {
        renderShopData(payload, forceRefreshClient);
      } else {
        showEmptyState();
      }
    });
  }

  function setClientDisplay(clientLabel, isUnmapped = false) {
    if (!shopClient) return;
    shopClient.textContent = clientLabel || 'Unmapped';
    shopClient.classList.toggle('is-unmapped', Boolean(isUnmapped));
  }

  function resolveAndRenderClient(sellerId, forceRefresh = false) {
    if (!shopClient) return;
    if (!sellerId) {
      setClientDisplay('Unmapped', true);
      return;
    }

    chrome.runtime.sendMessage(
      {
        action: 'RESOLVE_SELLER_CLIENT',
        sellerId,
        forceRefresh
      },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          setClientDisplay('Unmapped', true);
          return;
        }
        setClientDisplay(res.client || 'Unmapped', Boolean(res.unmapped));
      }
    );
  }

  function renderShopData(payload, forceRefreshClient = false) {
    const shop = payload.active_shop || payload.shops[0];
    emptyState.classList.add('hidden');
    sellerSection.classList.remove('hidden');

    const country = shop.country || '--';
    formattedSellerId.textContent = shop.formatted_seller_id;

    if (!forceRefreshClient && shop.resolved_client) {
      setClientDisplay(shop.resolved_client, shop.resolved_client === 'Unmapped');
    } else if (!shopClient.textContent || shopClient.textContent === '--') {
      setClientDisplay('Loading...', false);
    }
    resolveAndRenderClient(shop.formatted_seller_id, forceRefreshClient);

    if (regionParamBadge) {
      regionParamBadge.textContent = `?shop_region=${country}`;
    }

    currentReportUrls =
      shop.report_urls || buildFallbackReportUrls(country, payload.endpoint_url);
  }

  function showEmptyState() {
    sellerSection.classList.add('hidden');
    emptyState.classList.remove('hidden');
  }

  // Refresh button
  btnRefresh.addEventListener('click', () => {
    const origDisabled = btnRefresh.disabled;
    btnRefresh.disabled = true;
    if (shopClient && !sellerSection.classList.contains('hidden')) {
      setClientDisplay('Refreshing...', false);
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      const isTikTokTab = isSupportedSellerUrl(activeTab?.url);
      if (isTikTokTab && activeTab?.id) {
        statusBadge.className = 'status-badge status-connected';
        statusText.textContent = 'Seller Center Tab';
        requestLiveTabSellerRefresh(activeTab.id, true, () => {
          btnRefresh.disabled = origDisabled;
        });
      } else {
        loadStoredData(true);
        btnRefresh.disabled = origDisabled;
      }
    });
  });

  // Clear data
  btnClear.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CLEAR_SELLER_DATA' }, () => {
      void chrome.runtime.lastError;
      showEmptyState();
    });
  });

  // Open TikTok Seller Center
  btnOpenSeller.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://seller.tiktok.com' });
  });

  function startExportWorkflow(scope) {
    if (!currentReportUrls) return;
    savePeriodConfig();
    const periodConfig = getPeriodConfigFromInputs();

    renderExportButtonsState(scope);
    renderWorkflowLog({ text: '⏳ Starting background export tab...' });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      const currentSellerId = formattedSellerId?.textContent?.trim() || null;
      chrome.runtime.sendMessage(
        {
          action: 'START_FULL_WORKFLOW',
          scope,
          tabId: activeTab?.id || null,
          sellerId: currentSellerId && !currentSellerId.includes('--') ? currentSellerId : null,
          reportUrls: currentReportUrls,
          periodConfig
        },
        (res) => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr || !res || !res.ok) {
            renderExportButtonsState(false);
            renderWorkflowLog({
              text:
                lastErr?.message ||
                res?.error ||
                'Failed to start background export. Please click Reload on chrome://extensions.',
              isError: true
            });
          }
        }
      );
    });
  }

  if (btnExportAll) {
    btnExportAll.addEventListener('click', () => startExportWorkflow('all'));
  }
  if (btnExportLive) {
    btnExportLive.addEventListener('click', () => startExportWorkflow('live'));
  }
  if (btnExportVideo) {
    btnExportVideo.addEventListener('click', () => startExportWorkflow('video'));
  }

  // Listen for storage changes in real time
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
      if (changes.ttk_seller_payload) {
        loadStoredData();
      }
      if (changes.ttk_workflow_running || changes.ttk_workflow_log) {
        loadWorkflowState();
      }
    }
  });
});
