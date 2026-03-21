/**
 * content.js
 * SecureVault — Content Script (bundled entry point)
 *
 * This file is the esbuild output of src/content/merchant_site.js.
 * Run `npm run build` from the project root to regenerate it.
 *
 * What this module does at runtime:
 *  - Detects payment / checkout pages via URL patterns and field scanning
 *  - Sends vault_requested to the background service worker
 *  - Listens for VAULT_READY, VAULT_UNLOCKED, and INJECT_MASKED messages
 *  - Delegates DOM mutations to MerchantDomAdapter
 *  - Confirms fills back to background as vault_data_filled
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STUB NOTICE — run `npm run build` to replace with the real bundle.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  if (typeof chrome === 'undefined' || !chrome.runtime) return;

  console.warn(
    '[SecureVault] content.js is a pre-build stub. ' +
    'Run `npm run build` to generate the real bundle.'
  );

  // Minimal listener so the background's tab.sendMessage does not throw
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    sendResponse({ ok: false, stub: true });
    return false;
  });
})();