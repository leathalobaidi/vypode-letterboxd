// VYPODE FOR LETTERBOXD — Background Service Worker v6.0.2
// Local-only release worker. Keeps content-script messages from surfacing
// noisy "receiving end does not exist" errors while the registry lives in
// chrome.storage on the user's device.

'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'vypode') return;

  if (msg.action === 'stateChanged') {
    sendResponse({ ok: true });
  }
});
