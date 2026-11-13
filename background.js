/**
 * Background Service Worker (Manifest V3)
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[TikTok Extension] Extension installed successfully.');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'SAVE_SELLER_DATA') {
    const payload = message.payload;
    if (!payload || !payload.shops) {
      sendResponse({ success: false });
      return;
    }

    // Save to storage
    chrome.storage.local.set({
      ttk_seller_payload: payload,
      ttk_last_updated: Date.now()
    }, () => {
      // Update badge
      const activeShop = payload.active_shop || payload.shops[0];
      const badgeText = activeShop?.country || `${payload.shops.length}`;
      chrome.action.setBadgeText({ text: badgeText });
      chrome.action.setBadgeBackgroundColor({ color: '#fe2c55' });
      sendResponse({ success: true, saved: payload.shops.length });
    });

    return true; // async
  }

  if (message.action === 'CLEAR_SELLER_DATA') {
    chrome.storage.local.remove(['ttk_seller_payload', 'ttk_last_updated'], () => {
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ success: true });
    });
    return true;
  }
});

