// Vypode capture shim — runs in the PAGE's main world (injected by content.js).
// Wraps fetch + XHR so we can see the exact request Letterboxd's own modal
// makes when a film is logged/reviewed. Logs nothing itself; forwards request
// metadata to the content script via window.postMessage.
(function () {
  'use strict';
  if (window.__vypodeCaptureInstalled) return;
  window.__vypodeCaptureInstalled = true;

  const interesting = (url) =>
    typeof url === 'string' &&
    (url.includes('/s/') || /diary|review|rate|viewing/i.test(url));

  function report(method, url, body, headers) {
    try {
      let bodyStr = '';
      if (body instanceof URLSearchParams) bodyStr = body.toString();
      else if (typeof body === 'string') bodyStr = body;
      else if (body instanceof FormData) {
        bodyStr = [...body.entries()]
          .map(([k, v]) => k + '=' + (typeof v === 'string' ? v : '[file]'))
          .join('&');
      }
      window.postMessage(
        {
          __vypodeCapture: true,
          method: (method || 'GET').toUpperCase(),
          url: String(url),
          body: bodyStr.slice(0, 2000),
          headers: headers || null,
          ts: Date.now(),
        },
        '*'
      );
    } catch (e) {
      /* ignore */
    }
  }

  // ── fetch ──
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (interesting(url) && method.toUpperCase() === 'POST') {
        report(method, url, init && init.body, init && init.headers);
      }
    } catch (e) {
      /* ignore */
    }
    return origFetch.apply(this, arguments);
  };

  // ── XMLHttpRequest ──
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__vyMethod = method;
    this.__vyUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (
        interesting(this.__vyUrl) &&
        String(this.__vyMethod).toUpperCase() === 'POST'
      ) {
        report(this.__vyMethod, this.__vyUrl, body, null);
      }
    } catch (e) {
      /* ignore */
    }
    return origSend.apply(this, arguments);
  };
})();
