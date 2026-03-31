/**
 * merchant_site.js
 * Content Script — runs in the merchant page's renderer process.
 * OS analog: "user-space shim / system-call gateway"
 *
 * Detects payment / checkout pages and iframes, signals the background,
 * and handles masked injection from the vault UI.
 *
 * Fixes applied:
 *  1. checkHasSavedCards() now reads sv_cards_v1 (correct storage key)
 *  2. isPaymentPage() now includes domain-based detection for netbanking
 *     portals that don't use /checkout/ or /payment/ in their URLs
 *  3. isIframeContext() detects 3DS / embedded payment SDK iframes
 *  4. URL patterns expanded to cover Amazon /gp/buy/, /ap/, Indian banks
 */

import { MerchantDomAdapter } from "./merchant_dom_adapter.js";

const adapter = new MerchantDomAdapter();

// ── Payment page detection ─────────────────────────────────────────────────

/**
 * URL path/query patterns that indicate a checkout or payment page.
 * Tested against the full href (path + query string).
 */
const PAYMENT_URL_PATTERNS = [
  /checkout/i,
  /payment/i,
  /\/pay[\/\?#]/i,
  /\/pay$/i,
  /billing/i,
  /order.*confirm/i,
  /\/cart/i,
  /\/buy\//i,
  /\/purchase/i,
  /\/gp\/buy\//i, // Amazon: /gp/buy/addressselect/, /gp/buy/payselect/
  /\/ap\/signin/i, // Amazon: account/payment signin flow
  /\/ap\/cvf/i, // Amazon: card verification flow
  /processTransaction/i, // Paytm gateway
  /theia\//i, // Paytm Theia SDK
  /\/transaction/i,
  /\/secure\//i,
  /netbanking/i,
  /ibanking/i,
  /onlinebanking/i,
  /retail\/login/i, // SBI retail banking
];

/**
 * Domains that are inherently payment/banking domains — the entire site
 * is a payment context regardless of URL path.
 */
const PAYMENT_DOMAINS = new Set([
  "securegw.paytm.in",
  "securegw-stage.paytm.in",
  "razorpay.com",
  "api.razorpay.com",
  "stripe.com",
  "js.stripe.com",
  "paypal.com",
  "www.paypal.com",
  "payu.in",
  "secure.payu.in",
  "payumoney.com",
  "www.payumoney.com",
  "ccavenue.com",
  "www.ccavenue.com",
  "billdesk.com",
  "pgi.billdesk.com",
  "cashfree.com",
  "api.cashfree.com",
  "easebuzz.in",
  "instamojo.com",
  "zaakpay.com",
  "adyen.com",
  "checkout.com",
  "braintreegateway.com",
  "squareup.com",
  "klarna.com",
  "afterpay.com",
  "affirm.com",
  // Indian banks (all paths are payment-relevant)
  "netbanking.hdfcbank.com",
  "ibanking.icicibank.com",
  "netpay.axisbank.co.in",
  "retail.onlinesbi.sbi",
  "www.onlinesbi.com",
  "netbanking.kotak.com",
  "netbanking.yesbank.in",
  "indusnet.indusind.com",
  "netbanking.idfcfirstbank.com",
  "netbanking.federalbank.co.in",
  "rblbank.com",
  "netbanking.canarabank.in",
  "netbanking.unionbankofindia.co.in",
  // 3DS / ACS domains
  "acs.mastercard.com",
  "verified-by-visa.com",
  "safekey.com",
  "3ds.websdk.amazon.dev",
  "3dsecure.io",
]);

/**
 * Returns true if the current page is a payment or banking context,
 * using three detection methods in priority order:
 *  1. Known payment domain (fastest, most reliable)
 *  2. URL path/query pattern match
 *  3. Presence of meaningful payment/login-like form fields
 */
function isPaymentPage() {
  // 1. Domain-based detection
  const hostname = location.hostname.toLowerCase();
  if (PAYMENT_DOMAINS.has(hostname)) return true;

  for (const domain of PAYMENT_DOMAINS) {
    if (hostname.endsWith("." + domain) || hostname === domain) return true;
  }

  // 2. URL pattern match
  const url = location.href;
  if (PAYMENT_URL_PATTERNS.some(p => p.test(url))) return true;

  // 3. Field presence fallback — only if the page has meaningful payment‑like fields
  const fields = adapter.getFormFields();
  if (fields.length > 0) {
    return fields.some(f => {
      const text = f.fieldId.toLowerCase();
      return /password|pass|otp|pin|cvv|cvc|card|account|bill|auth|login|netbanking/i;
    });
  }
  return false;
}

/**
 * Returns true if this content script is running inside an iframe
 * (e.g. a 3DS authentication frame, embedded Razorpay/Paytm SDK).
 */
function isIframeContext() {
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin frame — definitely an iframe
    return true;
  }
}

// ── Listen for messages from background / vault UI ─────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case "VAULT_READY":
      adapter.attachFieldObservers(adapter.getFormFields());
      sendResponse({ ok: true });
      break;

    case "VAULT_UNLOCKED":
      if (msg.payload?.autofillReady) {
        adapter.markFieldsAutofillReady(adapter.getFormFields());
      }
      sendResponse({ ok: true });
      break;

    case "INJECT_MASKED":
      adapter.injectMaskedInputs(msg.payload ?? []);
      chrome.runtime.sendMessage({
        type: "vault_data_filled",
        payload: { fields: (msg.payload ?? []).map(t => t.fieldName) },
      }).catch(() => {});
      sendResponse({ ok: true });
      break;
  }
  return true;
});

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  const isPay = isPaymentPage();
  if (window.DEBUG_CREDLOCK) {
    console.log(`[CredLock] isPaymentPage() → ${isPay}, origin: ${location.origin}`);
  }

  if (!isPay) return;

  const inIframe = isIframeContext();
  const fields = adapter.getFormFields();
  const hasSavedCards = await checkHasSavedCards();

  console.log(
    `[CredLock] Payment page detected — ${fields.length} field(s),`,
    `iframe: ${inIframe}, hasSavedCards: ${hasSavedCards},`,
    `origin: ${location.origin}`
  );

  const resp = await chrome.runtime.sendMessage({
    type: "vault_requested",
    payload: {
      origin: location.origin,
      fieldsFound: fields.length,
      hasSavedCards,
      isIframe: inIframe,
      pageTitle: inIframe ? `[iframe] ${document.title}` : document.title,
    },
  }).catch(() => null);

  if (resp?.ok && resp?.allowed) {
    adapter.attachFieldObservers(fields);
  }
}

/**
 * Checks chrome.storage.local for saved vault cards.
 * Uses sv_cards_v1 — the correct key written by VaultStorage.saveAllCards().
 */
async function checkHasSavedCards() {
  try {
    const result = await chrome.storage.local.get("sv_cards_v1");
    return (
      Array.isArray(result["sv_cards_v1"]) &&
      result["sv_cards_v1"].length > 0
    );
  } catch {
    return false;
  }
}

// ── DOM observer for SPAs / dynamically injected forms ─────────────────────

let initiated = false;

const domObserver = new MutationObserver(() => {
  if (initiated) return;
  if (adapter.getFormFields().length > 0) {
    initiated = true;
    domObserver.disconnect();
    init();
  }
});

// Observe body for dynamically injected payment forms (SPAs, lazy-loaded
// checkout steps, React/Vue/Angular rendered forms)
if (document.body) {
  domObserver.observe(document.body, { childList: true, subtree: true });
} else {
  // Body not yet available — wait for DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    domObserver.observe(document.body, { childList: true, subtree: true });
  }, { once: true });
}

// Run immediately for static / server-rendered pages
init().then(() => { initiated = true; });

// ═══════════════════════════════════════════════════════════════════
// CREDLOCK: AMAZON IFRAME FIELD DETECTION (NEW)
// ═══════════════════════════════════════════════════════════════════

// 1. Enhanced field detection (call this from your existing MutationObserver/scanner)
function findFields() {
  console.log('[CredLock] 🔍 Scanning for fields...');
  
  // Regular inputs (non-Amazon)
  const inputs = document.querySelectorAll(`
    input[type="tel"], input[type="number"], input[data-stripe],
    input[name*="card"], input[name*="cc"], input[id*="card"],
    input[placeholder*="card"], input[maxlength="16"], input[maxlength="19"]
  `);
  
  // Amazon secure iframes
  const amazonIframes = document.querySelectorAll(`
    iframe[src*="secure-fields"], iframe[src*="amazon.dev"],
    iframe[src*="payments.amazon"], iframe[title*="card"]
  `);
  
  console.log('[CredLock] Regular inputs:', inputs.length, 'Amazon iframes:', amazonIframes.length);
  
  // Send to iframes
  amazonIframes.forEach((iframe, i) => {
    try {
      iframe.contentWindow.postMessage({
        action: 'credlock-detect-fields',
        from: 'main-page',
        timestamp: Date.now()
      }, '*');
      console.log(`[CredLock] Sent to iframe ${i}:`, iframe.src.slice(0,50));
    } catch(e) {
      console.log(`[CredLock] iframe ${i} blocked`);
    }
  });
  
  return Array.from(inputs);
}

// 2. Listen for iframe responses
window.addEventListener('message', (e) => {
  if (e.data.action === 'credlock-fields-response') {
    console.log('[CredLock] 🎉 IFRAME FIELDS:', e.data.fields);
    e.data.fields.forEach(field => {
      if (field.type === 'card' || field.type === 'cvv') {
        console.log(`[CredLock] ${field.type.toUpperCase()}: ${field.value.slice(0,8)}...`);
      }
    });
  }
});

// 3. AUTO-SCAN every 2 seconds + on DOM changes
setInterval(findFields, 2000);
const observer = new MutationObserver(findFields);
observer.observe(document.body, { childList: true, subtree: true });
console.log('[CredLock] ✅ Iframe detection ACTIVE');