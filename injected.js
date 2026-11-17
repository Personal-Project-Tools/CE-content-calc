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
  const API_INCLUDE_KEYWORDS = [
    'export',
    'insights',
    'compass',
    'live',
    'video',
    'report',
    'list',
    'task',
    'download'
  ];
  const API_IGNORE_KEYWORDS = [
    'batch',
    'newest_reply',
    'tooltips',
    'get_config',
    'abtest_config',
    'browser-settings',
    'collect',
    'get_all_sellers'
  ];

  let lastCapturedPayload = null;

  function shouldCaptureApi(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    if (!lower.includes('/api/')) return false;
    if (API_IGNORE_KEYWORDS.some((kw) => lower.includes(kw))) return false;
    return API_INCLUDE_KEYWORDS.some((kw) => lower.includes(kw));
  }

  function serializeRequestBody(rawBody) {
    if (rawBody == null) return null;
    if (typeof rawBody === 'string') {
      try {
        return JSON.parse(rawBody);
      } catch {
        return rawBody.slice(0, 4000);
      }
    }
    if (rawBody instanceof URLSearchParams) {
      return rawBody.toString();
    }
    if (typeof FormData !== 'undefined' && rawBody instanceof FormData) {
      const obj = {};
      rawBody.forEach((val, key) => {
        obj[key] = typeof val === 'string' ? val : '[File]';
      });
      return obj;
    }
    return String(rawBody).slice(0, 4000);
  }

  function truncateResponsePayload(data) {
    try {
      const serialized = JSON.stringify(data);
      if (!serialized) return data;
      if (serialized.length <= 4000) return data;
      return {
        _truncated: true,
        length: serialized.length,
        preview: serialized.slice(0, 4000)
      };
    } catch {
      return null;
    }
  }

  function dispatchCapturedApi({ transport, method, url, requestBody, status, response }) {
    const entry = {
      transport,
      method: (method || 'GET').toUpperCase(),
      url,
      requestBody: serializeRequestBody(requestBody),
      status: status ?? null,
      response: truncateResponsePayload(response),
      timestamp: Date.now()
    };

    window.dispatchEvent(
      new CustomEvent('TIKTOK_API_CAPTURED', {
        detail: entry
      })
    );
  }

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

      // Build seller-specific analytics report page URLs (Step 1 of report collection workflow)
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
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      const method = (args[1]?.method || (typeof Request !== 'undefined' && args[0] instanceof Request ? args[0].method : 'GET') || 'GET').toUpperCase();
      const requestBody = args[1]?.body ?? null;

      const response = await originalFetch.apply(this, args);
      try {
        if (url && url.includes(TARGET_ENDPOINT)) {
          const clone = response.clone();
          clone.json().then(jsonData => {
            const payload = parseSellerData(jsonData, url);
            if (payload) dispatchSellerData(payload);
          }).catch(err => {
            console.debug('[TikTok Extension] JSON parse error in fetch clone:', err);
          });
        } else if (shouldCaptureApi(url)) {
          const clone = response.clone();
          const contentType = clone.headers.get('content-type') || '';
          const status = clone.status;
          if (contentType.includes('application/json') || contentType.includes('text/')) {
            clone.text().then(text => {
              let parsed = text;
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = text.slice(0, 2000);
              }
              dispatchCapturedApi({
                transport: 'fetch',
                method,
                url,
                requestBody,
                status,
                response: parsed
              });
            }).catch(() => {});
          } else {
            dispatchCapturedApi({
              transport: 'fetch',
              method,
              url,
              requestBody,
              status,
              response: {
                _binary: true,
                contentType,
                contentDisposition: clone.headers.get('content-disposition') || ''
              }
            });
          }
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
      this.__reqMethod = (method || 'GET').toUpperCase();
      this.__reqUrl = typeof url === 'string' ? url : (url ? url.toString() : '');
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (body, ...rest) {
      this.__reqBody = body ?? null;
      this.addEventListener('load', function () {
        try {
          if (this.__reqUrl && this.__reqUrl.includes(TARGET_ENDPOINT)) {
            const jsonData = JSON.parse(this.responseText);
            const payload = parseSellerData(jsonData, this.__reqUrl);
            if (payload) dispatchSellerData(payload);
          } else if (shouldCaptureApi(this.__reqUrl)) {
            let parsedResponse = null;
            if (!this.responseType || this.responseType === 'text') {
              try {
                parsedResponse = JSON.parse(this.responseText);
              } catch {
                parsedResponse = String(this.responseText || '').slice(0, 2000);
              }
            } else {
              parsedResponse = { _responseType: this.responseType };
            }
            dispatchCapturedApi({
              transport: 'xhr',
              method: this.__reqMethod,
              url: this.__reqUrl,
              requestBody: this.__reqBody,
              status: this.status,
              response: parsedResponse
            });
          }
        } catch (e) {
          // not JSON or not target response
        }
      });
      return origSend.call(this, body, ...rest);
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

  console.log('[TikTok Extension] Injected Hook (MAIN world) listening for get_all_sellers & analytics APIs.');
})();
