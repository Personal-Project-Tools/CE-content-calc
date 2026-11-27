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

  // 0. Keep page visibility & focus state always active so switching to other Chrome tabs/apps
  // never pauses TikTok Seller Center's React rendering, table queries, or export task polling.
  try {
    Object.defineProperty(Document.prototype, 'hidden', {
      get: () => false,
      configurable: true
    });
    Object.defineProperty(Document.prototype, 'visibilityState', {
      get: () => 'visible',
      configurable: true
    });
    Object.defineProperty(Document.prototype, 'webkitHidden', {
      get: () => false,
      configurable: true
    });
    Object.defineProperty(Document.prototype, 'webkitVisibilityState', {
      get: () => 'visible',
      configurable: true
    });
    Document.prototype.hasFocus = function () {
      return true;
    };

    const BLOCKED_VISIBILITY_EVENTS = new Set([
      'visibilitychange',
      'webkitvisibilitychange',
      'pagehide',
      'freeze'
    ]);
    const origDocAddEvent = Document.prototype.addEventListener;
    Document.prototype.addEventListener = function (type, listener, options) {
      if (BLOCKED_VISIBILITY_EVENTS.has(String(type || '').toLowerCase())) {
        return;
      }
      return origDocAddEvent.call(this, type, listener, options);
    };

    const origWinAddEvent = Window.prototype.addEventListener;
    Window.prototype.addEventListener = function (type, listener, options) {
      if (BLOCKED_VISIBILITY_EVENTS.has(String(type || '').toLowerCase())) {
        return;
      }
      return origWinAddEvent.call(this, type, listener, options);
    };
  } catch (err) {
    console.debug('[TikTok Extension] Visibility override warning:', err);
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
  const EXPORT_ENDPOINT_HINTS = [
    '/live/list/export',
    '/video/analytics/video/list/export',
    '/compass/api',
    '/export'
  ];
  let lastCapturedPayload = null;

  function extractExportDownloadUrl(jsonData) {
    if (!jsonData || typeof jsonData !== 'object') return null;
    const data = jsonData.data || jsonData;
    if (!data || typeof data !== 'object') return null;
    const candidates = [
      data.download_url,
      data.downloadUrl,
      data.file_url,
      data.fileUrl,
      data.url,
      typeof data.file === 'string' && /^https?:\/\//i.test(data.file) ? data.file : null
    ];
    return candidates.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) || null;
  }

  function inspectPossibleExportResponse(jsonData, url) {
    if (!jsonData || typeof jsonData !== 'object') return;
    const lowerUrl = String(url || '').toLowerCase();
    const isExportUrl =
      lowerUrl.includes('/live/list/export') ||
      lowerUrl.includes('/video/analytics/video/list/export') ||
      lowerUrl.includes('export');
    if (!isExportUrl) return;

    const taskId =
      jsonData?.data?.file ||
      jsonData?.data?.task_id ||
      jsonData?.data?.taskId ||
      jsonData?.data?.export_task_id ||
      (jsonData?.code === 0 && lowerUrl.includes('/list/export') ? 'export_ok' : null);

    if (taskId) {
      window.dispatchEvent(
        new CustomEvent('TIKTOK_EXPORT_TASK_CREATED', {
          detail: { taskId, url, timestamp: Date.now() }
        })
      );
    }

    const directUrl = extractExportDownloadUrl(jsonData);
    if (directUrl) {
      window.dispatchEvent(
        new CustomEvent('TIKTOK_EXPORT_DOWNLOAD_URL', {
          detail: { url: directUrl, sourceUrl: url, timestamp: Date.now() }
        })
      );
    }
  }

  // Intercept window.open so background tabs (where Chrome blocks popups without user gesture)
  // still trigger file downloads seamlessly.
  if (typeof window.open === 'function') {
    const origWindowOpen = window.open;
    window.open = function (url, target, features) {
      const urlStr = typeof url === 'string' ? url : url ? String(url) : '';
      if (urlStr && /^https?:\/\//i.test(urlStr)) {
        window.dispatchEvent(
          new CustomEvent('TIKTOK_WINDOW_OPEN_URL', {
            detail: { url: urlStr, timestamp: Date.now() }
          })
        );
      }
      return origWindowOpen.call(this, url, target, features);
    };
  }

  function detectActiveRegionFromLocation(rawUrl) {
    try {
      const u = new URL(rawUrl || window.location.href);
      const paramRegion = (
        u.searchParams.get('shop_region') ||
        u.searchParams.get('region') ||
        ''
      )
        .trim()
        .toUpperCase();
      if (paramRegion) return paramRegion;

      const hostMatch = u.hostname.toLowerCase().match(/^seller-([a-z]{2})\./);
      if (hostMatch) return hostMatch[1].toUpperCase();
      if (u.hostname.toLowerCase().includes('tokopedia.com')) return 'ID';
    } catch {
      // ignore
    }
    return '';
  }

  function detectActiveSellerIdFromLocation(rawUrl, data) {
    try {
      const u = new URL(rawUrl || window.location.href);
      const paramSeller =
        u.searchParams.get('seller_id') ||
        u.searchParams.get('oec_seller_id') ||
        u.searchParams.get('shop_id') ||
        '';
      if (paramSeller.trim()) return paramSeller.trim();
    } catch {
      // ignore
    }
    const apiActive =
      data?.data?.active_seller_id ||
      data?.data?.current_seller_id ||
      data?.data?.seller_id ||
      data?.active_seller_id ||
      '';
    return String(apiActive || '').trim();
  }

  function selectActiveShop(parsedShops, data) {
    if (!parsedShops || parsedShops.length === 0) return null;
    if (parsedShops.length === 1) return parsedShops[0];

    const targetSellerId = detectActiveSellerIdFromLocation(window.location.href, data);
    if (targetSellerId) {
      const byId = parsedShops.find(
        (s) =>
          String(s.seller) === targetSellerId ||
          String(s.global_seller_id) === targetSellerId ||
          String(s.unified_seller_id) === targetSellerId
      );
      if (byId) return byId;
    }

    const targetRegion = detectActiveRegionFromLocation(window.location.href);
    if (targetRegion) {
      const byRegionAndFlag = parsedShops.find(
        (s) =>
          s.country === targetRegion &&
          (s.raw_seller_info?.is_current ||
            s.raw_seller_info?.active ||
            s.raw_seller_info?.selected)
      );
      if (byRegionAndFlag) return byRegionAndFlag;

      const byRegion = parsedShops.find((s) => s.country === targetRegion);
      if (byRegion) return byRegion;
    }

    const byFlag = parsedShops.find(
      (s) =>
        s.raw_seller_info?.is_current ||
        s.raw_seller_info?.active ||
        s.raw_seller_info?.selected
    );
    return byFlag || parsedShops[0];
  }

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

    const activeShop = selectActiveShop(parsedShops, data);

    return {
      shops: parsedShops,
      active_shop: activeShop,
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
            inspectPossibleExportResponse(jsonData, url);
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
          } else if (
            this.__reqUrl &&
            EXPORT_ENDPOINT_HINTS.some((hint) => this.__reqUrl.includes(hint))
          ) {
            const jsonData = JSON.parse(this.responseText);
            inspectPossibleExportResponse(jsonData, this.__reqUrl);
          }
        } catch (e) {
          // not JSON or not target response
        }
      });
      return origSend.apply(this, args);
    };
  }

  async function fetchFreshSellerData(forceNetwork = false) {
    if (!forceNetwork && lastCapturedPayload?.raw_data) {
      const reevaluated = parseSellerData(
        lastCapturedPayload.raw_data,
        lastCapturedPayload.endpoint_url
      );
      if (reevaluated) {
        dispatchSellerData(reevaluated);
        return reevaluated;
      }
    }

    try {
      const currentUrl = new URL(window.location.href);
      const testEndpoint = `${currentUrl.origin}${TARGET_ENDPOINT}?locale=en&language=en&_t=${Date.now()}`;
      const res = await fetch(testEndpoint, {
        credentials: 'include',
        cache: 'no-store'
      });
      const data = await res.json();
      const payload = parseSellerData(data, testEndpoint);
      if (payload) {
        dispatchSellerData(payload);
        return payload;
      }
    } catch {
      // Fall back to re-evaluating cached payload if network request fails
    }

    if (lastCapturedPayload?.raw_data) {
      const fallback =
        parseSellerData(lastCapturedPayload.raw_data, lastCapturedPayload.endpoint_url) ||
        lastCapturedPayload;
      dispatchSellerData(fallback);
      return fallback;
    }
    return null;
  }

  // 3. Listen for manual requests from extension
  window.addEventListener('TIKTOK_SELLER_REQUEST_STATE', (event) => {
    const forceNetwork = Boolean(event?.detail?.force);
    fetchFreshSellerData(forceNetwork);
  });

  console.log('[TikTok Extension] Injected Hook (MAIN world) listening for get_all_sellers API.');
})();
