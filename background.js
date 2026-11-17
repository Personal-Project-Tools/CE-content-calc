/**
 * Background Service Worker (Manifest V3)
 * Manages seller state, monitors Chrome report downloads, and orchestrates the 4-report workflow
 * across LIVE -> Details and Video -> Details pages.
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[TikTok Extension] Extension installed successfully.');
});

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

async function navigateAndRunPageWorkflow(tabId, targetUrl, periodConfig) {
  await chrome.tabs.update(tabId, { url: targetUrl });
  await sleep(1500);
  await waitForTabComplete(tabId, 25000);
  // Give SPA (React + Arco) time to mount #page-title-datepicker
  await sleep(3000);

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        action: 'RUN_PAGE_WORKFLOW',
        periodConfig
      },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: 'No response from content script' });
        }
      }
    );
  });
}

async function runFullFourReportWorkflow(tabId, reportUrls, periodConfig) {
  // Reset checklist statuses to Pending
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

  try {
    // Phase 1: LIVE -> Details (2 reports: Linked + Affiliate)
    const liveRes = await navigateAndRunPageWorkflow(tabId, reportUrls.live_details, periodConfig);

    await sleep(1200);

    // Phase 2: Video -> Details (2 reports: Linked + Affiliate, re-selects Date/Month)
    const videoRes = await navigateAndRunPageWorkflow(tabId, reportUrls.video_details, periodConfig);

    await chrome.storage.local.set({ ttk_workflow_running: false });
    return { ok: true, liveRes, videoRes };
  } catch (err) {
    await chrome.storage.local.set({ ttk_workflow_running: false });
    return { ok: false, error: err.message || String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'SAVE_SELLER_DATA') {
    const payload = message.payload;
    if (!payload || !payload.shops) {
      sendResponse({ success: false });
      return;
    }

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

  if (message.action === 'UPDATE_REPORT_STATUS') {
    updateReportChecklistStorage(message.reportKey, message.status, message.message);
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'START_FULL_WORKFLOW') {
    const { tabId, reportUrls, periodConfig } = message;
    runFullFourReportWorkflow(tabId, reportUrls, periodConfig).then((res) => {
      sendResponse(res);
    });
    return true;
  }

  if (message.action === 'CLEAR_SELLER_DATA') {
    chrome.storage.local.remove(
      ['ttk_seller_payload', 'ttk_last_updated', 'ttk_report_statuses', 'ttk_workflow_running'],
      () => {
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ success: true });
      }
    );
    return true;
  }
});
