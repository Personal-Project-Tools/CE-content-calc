/**
 * Content Script running in the ISOLATED world.
 * Bridges communication between injected.js (MAIN world) and Chrome Extension runtime.
 */
(function () {
  'use strict';

  // Only run on seller subdomains
  if (!window.location.hostname.includes('seller') && !window.location.hostname.includes('tiktokglobalshop')) {
    return;
  }

  // Remove legacy on-page toast if present
  const existingToast = document.getElementById('ttk-ext-toast');
  if (existingToast) {
    existingToast.remove();
  }

  // Listen for captured seller data from injected script
  window.addEventListener('TIKTOK_SELLER_CAPTURED', (event) => {
    const payload = event.detail;
    if (!payload || !payload.shops) return;

    // Send silently to background service worker & storage
    chrome.runtime.sendMessage(
      {
        action: 'SAVE_SELLER_DATA',
        payload: payload
      },
      () => {
        if (chrome.runtime.lastError) {
          // Background service worker might be waking up
        }
      }
    );
  });

  // Listen for messages from popup or background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'REFRESH_SELLER_DATA') {
      window.dispatchEvent(new CustomEvent('TIKTOK_SELLER_REQUEST_STATE'));
      sendResponse({ status: 'requested' });
    }
    return true;
  });

  // Request state on initial content script load
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('TIKTOK_SELLER_REQUEST_STATE'));
  }, 1000);
})();
