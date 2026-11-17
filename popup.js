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

  const shopCountry = document.getElementById('shop-country');
  const shopName = document.getElementById('shop-name');
  const formattedSellerId = document.getElementById('formatted-seller-id');
  const regionParamBadge = document.getElementById('region-param-badge');
  const btnGoLiveDetails = document.getElementById('btn-go-live-details');
  const btnGoVideoDetails = document.getElementById('btn-go-video-details');

  const modeBtnDay = document.getElementById('mode-btn-day');
  const modeBtnMonth = document.getElementById('mode-btn-month');
  const fieldDayWrapper = document.getElementById('field-day-wrapper');
  const fieldMonthWrapper = document.getElementById('field-month-wrapper');
  const inputSingleDate = document.getElementById('input-single-date');
  const inputTargetMonth = document.getElementById('input-target-month');
  const btnRunAllReports = document.getElementById('btn-run-all-reports');
  const btnRunCurrentPage = document.getElementById('btn-run-current-page');
  const workflowLogBox = document.getElementById('workflow-log-box');

  let currentReportUrls = null;
  let currentPeriodMode = 'day'; // 'day' | 'month'

  function renderWorkflowLog(logObj) {
    if (!workflowLogBox) return;
    if (!logObj || !logObj.text) {
      workflowLogBox.classList.add('hidden');
      return;
    }
    workflowLogBox.classList.remove('hidden');
    workflowLogBox.classList.toggle('log-error', Boolean(logObj.isError));
    workflowLogBox.textContent = logObj.text;
  }

  function getPeriodConfigFromInputs() {
    return {
      mode: currentPeriodMode,
      date: inputSingleDate?.value || getDefaultYesterdayStr(),
      month: inputTargetMonth?.value || getDefaultPreviousMonthStr()
    };
  }

  function renderChecklistStatuses(statuses = {}, isRunning = false) {
    const items = document.querySelectorAll('#report-checklist .checklist-item');
    items.forEach((item) => {
      const key = item.getAttribute('data-report');
      const info = statuses[key];
      const statusSpan = item.querySelector('.check-status');
      if (!info) {
        item.removeAttribute('data-status');
        if (statusSpan) statusSpan.textContent = 'Pending';
        return;
      }
      item.setAttribute('data-status', info.status || 'pending');
      if (statusSpan) {
        statusSpan.textContent = info.message || info.status || 'Pending';
      }
    });

    if (btnRunAllReports) {
      btnRunAllReports.disabled = Boolean(isRunning);
      btnRunAllReports.textContent = isRunning
        ? '⏳ Exporting in Background...'
        : '▶ Auto Export All 4 Reports (Background)';
    }
  }

  function loadChecklistStatuses() {
    chrome.storage.local.get(['ttk_report_statuses', 'ttk_workflow_running', 'ttk_workflow_log'], (res) => {
      renderChecklistStatuses(res.ttk_report_statuses || {}, res.ttk_workflow_running);
      if (res.ttk_workflow_log) {
        renderWorkflowLog(res.ttk_workflow_log);
      }
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
  loadChecklistStatuses();

  // Verify background service worker is up-to-date and downloads.onDeterminingFilename is active
  chrome.runtime.sendMessage({ action: 'CHECK_BACKGROUND_READY' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok || !res.hasDownloadsOnDetermining) {
      renderWorkflowLog({
        text: '⚠️ Please click Reload (🔄) on chrome://extensions to activate Reports/ folder routing.',
        isError: true
      });
    }
  });

  function buildFallbackReportUrls(country, tabUrl) {
    const region = (country || 'SG').toUpperCase();
    let origin = `https://seller-${region.toLowerCase()}.tiktok.com`;
    try {
      if (tabUrl && tabUrl.includes('tiktok')) {
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

  function navigateActiveTab(targetUrl) {
    if (!targetUrl) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab?.id) {
        chrome.tabs.update(activeTab.id, { url: targetUrl });
      } else {
        chrome.tabs.create({ url: targetUrl });
      }
    });
  }

  const btnRefresh = document.getElementById('btn-refresh');
  const btnClear = document.getElementById('btn-clear');
  const btnOpenSeller = document.getElementById('btn-open-seller');

  // Check active tab domain
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    const isTikTokTab =
      activeTab?.url &&
      ((activeTab.url.includes('seller') && activeTab.url.includes('tiktok.com')) ||
        activeTab.url.includes('tiktokglobalshop.com'));

    if (isTikTokTab) {
      statusBadge.className = 'status-badge status-connected';
      statusText.textContent = 'Seller Center Tab';
      // Request active tab to re-verify state
      chrome.tabs.sendMessage(activeTab.id, { action: 'REFRESH_SELLER_DATA' }, () => {
        if (chrome.runtime.lastError) {
          // Tab may not have finished loading or script injected yet
        }
      });
    } else {
      statusBadge.className = 'status-badge status-inactive';
      statusText.textContent = 'Not on TikTok';
    }

    loadStoredData();
  });

  function loadStoredData() {
    chrome.storage.local.get(['ttk_seller_payload'], (result) => {
      const payload = result.ttk_seller_payload;
      if (payload && payload.shops && payload.shops.length > 0) {
        renderShopData(payload);
      } else {
        showEmptyState();
      }
    });
  }

  function renderShopData(payload) {
    const shop = payload.active_shop || payload.shops[0];
    emptyState.classList.add('hidden');
    sellerSection.classList.remove('hidden');

    const country = shop.country || '--';
    shopCountry.textContent = country;
    shopName.textContent = shop.seller_name || 'TikTok Shop Seller';
    formattedSellerId.textContent = shop.formatted_seller_id;

    if (regionParamBadge) {
      regionParamBadge.textContent = `?shop_region=${country}`;
    }

    currentReportUrls =
      shop.report_urls || buildFallbackReportUrls(country, payload.endpoint_url);

    if (btnGoLiveDetails) {
      btnGoLiveDetails.title = currentReportUrls.live_details;
    }
    if (btnGoVideoDetails) {
      btnGoVideoDetails.title = currentReportUrls.video_details;
    }
  }

  function showEmptyState() {
    sellerSection.classList.add('hidden');
    emptyState.classList.remove('hidden');
  }

  // Refresh button
  btnRefresh.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab?.id) {
        chrome.tabs.sendMessage(activeTab.id, { action: 'REFRESH_SELLER_DATA' }, () => {
          void chrome.runtime.lastError;
          setTimeout(loadStoredData, 300);
        });
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

  // Navigate to LIVE -> Details
  if (btnGoLiveDetails) {
    btnGoLiveDetails.addEventListener('click', () => {
      if (currentReportUrls?.live_details) {
        navigateActiveTab(currentReportUrls.live_details);
      }
    });
  }

  // Navigate to Video -> Details
  if (btnGoVideoDetails) {
    btnGoVideoDetails.addEventListener('click', () => {
      if (currentReportUrls?.video_details) {
        navigateActiveTab(currentReportUrls.video_details);
      }
    });
  }

  // Run Full 4-Report Auto Export Workflow (LIVE Details -> Video Details)
  if (btnRunAllReports) {
    btnRunAllReports.addEventListener('click', () => {
      if (!currentReportUrls) return;
      savePeriodConfig();
      const periodConfig = getPeriodConfigFromInputs();

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        if (!activeTab?.id) return;

        renderWorkflowLog({ text: 'Starting silent background export...', isError: false });

        chrome.runtime.sendMessage(
          {
            action: 'START_FULL_WORKFLOW',
            tabId: activeTab.id,
            reportUrls: currentReportUrls,
            periodConfig
          },
          () => {
            void chrome.runtime.lastError;
          }
        );
      });
    });
  }

  // Run Workflow on Current Open Details Page Only (2 Reports)
  if (btnRunCurrentPage) {
    btnRunCurrentPage.addEventListener('click', () => {
      savePeriodConfig();
      const periodConfig = getPeriodConfigFromInputs();

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        if (!activeTab?.id) return;

        btnRunCurrentPage.disabled = true;
        btnRunCurrentPage.textContent = '⏳ Running Current Page...';
        renderWorkflowLog({ text: 'Starting workflow on current tab...', isError: false });

        const finish = (res) => {
          btnRunCurrentPage.disabled = false;
          btnRunCurrentPage.textContent = 'Run Current Page Only (2 Reports)';
          if (res && res.ok === false && res.error) {
            renderWorkflowLog({ text: res.error, isError: true });
          }
          loadChecklistStatuses();
        };

        const sendRun = (onDone) => {
          chrome.tabs.sendMessage(activeTab.id, { action: 'RUN_PAGE_WORKFLOW', periodConfig }, (res) => {
            if (chrome.runtime.lastError) {
              onDone(null, chrome.runtime.lastError.message);
            } else {
              onDone(res);
            }
          });
        };

        // Try direct message to the tab; if content script is missing, inject it and retry.
        chrome.tabs.sendMessage(activeTab.id, { action: 'PING' }, () => {
          if (!chrome.runtime.lastError) {
            sendRun((res, err) => finish(err ? { ok: false, error: err } : res));
            return;
          }
          renderWorkflowLog({ text: 'Content script missing in tab -> injecting...', isError: false });
          chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content.js'] }, () => {
            if (chrome.runtime.lastError) {
              finish({ ok: false, error: `Cannot inject into this tab: ${chrome.runtime.lastError.message}` });
              return;
            }
            setTimeout(() => sendRun((res, err) => finish(err ? { ok: false, error: err } : res)), 400);
          });
        });
      });
    });
  }

  // Listen for storage changes in real time
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
      if (changes.ttk_seller_payload) {
        loadStoredData();
      }
      if (changes.ttk_report_statuses || changes.ttk_workflow_running || changes.ttk_workflow_log) {
        loadChecklistStatuses();
      }
    }
  });
});
