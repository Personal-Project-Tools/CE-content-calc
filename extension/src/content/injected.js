/**
 * Injected script running in the MAIN world to intercept TikTok Seller API calls.
 */
(function () {
  'use strict';

  // Run on TikTok & Tokopedia Seller Center domains (including id.tokopedia.com / seller-id.tokopedia.com)
  const host = window.location.hostname.toLowerCase();
  if (
    !host.includes('seller') &&
    !host.includes('tiktokglobalshop') &&
    !host.includes('id.tokopedia.com')
  ) {
    return;
  }

  // Ensure requestAnimationFrame continues firing when the worker tab runs in the background (document.hidden === true).
  // Arco Design's Trigger / DatePicker relies on requestAnimationFrame to mount and position calendar popups.
  const origRAF = window.requestAnimationFrame.bind(window);
  const origCAF = window.cancelAnimationFrame.bind(window);
  const pendingRafQueue = new Map();

  function runSinglePendingRaf(rafId, entry) {
    if (!pendingRafQueue.has(rafId)) return;
    pendingRafQueue.delete(rafId);
    window.clearTimeout(entry.timerId);
    origCAF(rafId);
    try {
      entry.callback(performance.now());
    } catch (err) {
      console.error('[TikTok Extension] Background rAF callback error:', err);
    }
  }

  function flushPendingBackgroundRafs() {
    if (pendingRafQueue.size === 0) return;
    const snapshot = Array.from(pendingRafQueue.entries());
    for (const [rafId, entry] of snapshot) {
      runSinglePendingRaf(rafId, entry);
    }
  }

  window.requestAnimationFrame = function (callback) {
    if (typeof callback !== 'function') {
      return origRAF(callback);
    }
    let rafId = 0;
    const entry = {
      callback,
      timerId: 0
    };
    entry.timerId = window.setTimeout(() => {
      runSinglePendingRaf(rafId, entry);
    }, 32);

    rafId = origRAF((ts) => {
      if (!pendingRafQueue.has(rafId)) return;
      pendingRafQueue.delete(rafId);
      window.clearTimeout(entry.timerId);
      callback(ts);
    });

    pendingRafQueue.set(rafId, entry);
    return rafId;
  };

  window.cancelAnimationFrame = function (rafId) {
    const entry = pendingRafQueue.get(rafId);
    if (entry) {
      window.clearTimeout(entry.timerId);
      pendingRafQueue.delete(rafId);
    }
    return origCAF(rafId);
  };

  window.addEventListener('TTK_FLUSH_BACKGROUND_RAF', () => {
    flushPendingBackgroundRafs();
  });

  const TARGET_ENDPOINT = '/api/v1/seller/workbench/get_all_sellers';
  const EXPORT_ENDPOINT_HINTS = ['/live/list/export', '/video/analytics/video/list/export'];
  let lastCapturedPayload = null;

  function parseSellerData(data, requestUrl) {
    if (!data || typeof data !== 'object') return null;

    const sellersData = data.data?.sellers_data || data.sellers_data;
    if (!sellersData || typeof sellersData !== 'object') return null;

    const parsedShops = [];

    // Loop through keys in sellers_data
    // e.g. "7000000000000000001": { global_seller: { base_region: "MY", seller_name: "Sample Official Store", ... } }
    for (const [sellerKey, sellerInfo] of Object.entries(sellersData)) {
      if (!sellerInfo || typeof sellerInfo !== 'object') continue;

      const globalSeller = sellerInfo.global_seller || {};
      const country = (globalSeller.base_region || 'UNKNOWN').toUpperCase();
      const seller = sellerKey; // e.g. 7000000000000000001

      // Format requirement: country.TTK.seller
      const formattedSellerId = `${country}.TTK.${seller}`;

      // Build seller-specific analytics report page URLs
      const origin = window.location.origin;
      const reportUrls = {
        live_details: `${origin}/compass/live-analysis/live-details?shop_region=${encodeURIComponent(country)}`,
        video_details: `${origin}/compass/video-analytics/video-details?platform_data_source=shop&shop_region=${encodeURIComponent(country)}`
      };

      parsedShops.push({
        formatted_seller_id: formattedSellerId,
        seller: seller,
        country: country,
        seller_name: globalSeller.seller_name || 'Unnamed Shop',
        global_seller_id: globalSeller.global_seller_id || seller,
        unified_seller_id: globalSeller.unified_seller_id || '',
        operation_mode: sellerInfo.operation_mode || '',
        status: globalSeller.status ?? null,
        seller_type: globalSeller.seller_type ?? null,
        report_urls: reportUrls,
        raw_seller_info: sellerInfo
      });
    }

    if (parsedShops.length === 0) return null;

    return {
      shops: parsedShops,
      active_shop: parsedShops[0],
      raw_data: data,
      endpoint_url: requestUrl,
      timestamp: Date.now()
    };
  }

  function dispatchSellerData(payload) {
    if (!payload) return;
    lastCapturedPayload = payload;
    window.__TIKTOK_SELLER_CAPTURED_DATA__ = payload;

    // Dispatch event to ISOLATED content script
    window.dispatchEvent(
      new CustomEvent('TIKTOK_SELLER_CAPTURED', {
        detail: payload
      })
    );
    console.log('[TikTok Extension] Successfully captured Seller ID:', payload.shops.map(s => s.formatted_seller_id));
  }

  // 1. Intercept window.fetch
  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (url && url.includes(TARGET_ENDPOINT)) {
          const clone = response.clone();
          clone.json().then(jsonData => {
            const payload = parseSellerData(jsonData, url);
            if (payload) dispatchSellerData(payload);
          }).catch(err => {
            console.debug('[TikTok Extension] JSON parse error in fetch clone:', err);
          });
        } else if (url && EXPORT_ENDPOINT_HINTS.some(hint => url.includes(hint))) {
          const clone = response.clone();
          clone.json().then(jsonData => {
            const taskId = jsonData?.data?.file;
            if (taskId) {
              window.dispatchEvent(
                new CustomEvent('TIKTOK_EXPORT_TASK_CREATED', {
                  detail: { taskId, url, timestamp: Date.now() }
                })
              );
            }
          }).catch(() => {});
        }
      } catch (err) {
        console.debug('[TikTok Extension] Error in fetch hook:', err);
      }
      return response;
    };
  }

  // 2. Intercept XMLHttpRequest
  if (typeof window.XMLHttpRequest === 'function') {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__reqUrl = typeof url === 'string' ? url : (url ? url.toString() : '');
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          if (this.__reqUrl && this.__reqUrl.includes(TARGET_ENDPOINT)) {
            const jsonData = JSON.parse(this.responseText);
            const payload = parseSellerData(jsonData, this.__reqUrl);
            if (payload) dispatchSellerData(payload);
          }
        } catch (e) {
          // not JSON or not target response
        }
      });
      return origSend.apply(this, args);
    };
  }

  // 3. Listen for manual requests from extension
  window.addEventListener('TIKTOK_SELLER_REQUEST_STATE', () => {
    if (lastCapturedPayload) {
      dispatchSellerData(lastCapturedPayload);
    } else {
      // If not captured yet, attempt a passive fetch with current page cookies/session
      const currentUrl = new URL(window.location.href);
      const testEndpoint = `${currentUrl.origin}${TARGET_ENDPOINT}?locale=en&language=en`;
      fetch(testEndpoint, { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
          const payload = parseSellerData(data, testEndpoint);
          if (payload) dispatchSellerData(payload);
        })
        .catch(() => {});
    }
  });

  console.log('[TikTok Extension] Injected Hook (MAIN world) listening for get_all_sellers API.');
})();
