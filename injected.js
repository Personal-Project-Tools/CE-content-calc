/**
 * Injected script running in the MAIN world to intercept TikTok Seller API calls.
 */
(function () {
  'use strict';

  // Only run on seller subdomains
  if (!window.location.hostname.includes('seller') && !window.location.hostname.includes('tiktokglobalshop')) {
    return;
  }

  const TARGET_ENDPOINT = '/api/v1/seller/workbench/get_all_sellers';
  const EXPORT_ENDPOINT_HINTS = ['/live/list/export', '/video/analytics/video/list/export'];
  let lastCapturedPayload = null;

  function parseSellerData(data, requestUrl) {
    if (!data || typeof data !== 'object') return null;

    const sellersData = data.data?.sellers_data || data.sellers_data;
    if (!sellersData || typeof sellersData !== 'object') return null;

    const parsedShops = [];

    // Loop through keys in sellers_data
    // e.g. "7494520748649907971": { global_seller: { base_region: "MY", seller_name: "WD-40 Malaysia", ... } }
    for (const [sellerKey, sellerInfo] of Object.entries(sellersData)) {
      if (!sellerInfo || typeof sellerInfo !== 'object') continue;

      const globalSeller = sellerInfo.global_seller || {};
      const country = (globalSeller.base_region || 'UNKNOWN').toUpperCase();
      const seller = sellerKey; // e.g. 7494520748649907971

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
