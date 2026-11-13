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

    shopCountry.textContent = shop.country || '--';
    shopName.textContent = shop.seller_name || 'TikTok Shop Seller';
    formattedSellerId.textContent = shop.formatted_seller_id;
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
          setTimeout(loadStoredData, 300);
        });
      }
    });
  });

  // Clear data
  btnClear.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CLEAR_SELLER_DATA' }, () => {
      showEmptyState();
    });
  });

  // Open TikTok Seller Center
  btnOpenSeller.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://seller.tiktok.com' });
  });

  // Listen for storage changes in real time
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.ttk_seller_payload) {
      loadStoredData();
    }
  });
});
