/**
 * merchant_site.js
 * Content Script — runs in the merchant page's renderer process.
 * OS analog: "user-space shim / system-call gateway"
 *
 * Detects payment / checkout pages, sends a vault_requested message to the
 * background with autofill availability context, and handles masked injection.
 */

import { MerchantDomAdapter } from './merchant_dom_adapter.js';

const adapter = new MerchantDomAdapter();

// ── Page detection ─────────────────────────────────────────────────────────

const PAYMENT_URL_PATTERNS = [
  /checkout/i,
  /payment/i,
  /\/pay\b/i,
  /billing/i,
  /order.*confirm/i,
  /cart/i,
];

function isPaymentPage() {
  const url = location.href;
  if (PAYMENT_URL_PATTERNS.some(p => p.test(url))) return true;

  // Also check for presence of payment-related form fields
  return adapter.getFormFields().length > 0;
}

// ── Listen for messages from background / vault UI ─────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'VAULT_READY':
      // Background confirmed vault is available — attach field observers
      adapter.attachFieldObservers(adapter.getFormFields());
      sendResponse({ ok: true });
      break;

    case 'VAULT_UNLOCKED':
      // Vault unlocked; if autofill is ready, pre-lock fields visually
      if (msg.payload?.autofillReady) {
        adapter.markFieldsAutofillReady(adapter.getFormFields());
      }
      sendResponse({ ok: true });
      break;

    case 'INJECT_MASKED':
      // Vault has prepared masked tokens — write them into the merchant form
      adapter.injectMaskedInputs(msg.payload ?? []);
      // Confirm back to background
      chrome.runtime.sendMessage({
        type:    'vault_data_filled',
        payload: { fields: (msg.payload ?? []).map(t => t.fieldName) },
      }).catch(() => {});
      sendResponse({ ok: true });
      break;
  }
  return true; // keep channel open for async responses
});

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  if (!isPaymentPage()) return;

  const fields      = adapter.getFormFields();
  const hasSavedCards = await checkHasSavedCards();

  console.log('[SecureVault] Payment page detected —',
    fields.length, 'field(s), hasSavedCards:', hasSavedCards);

  // Send vault_requested to background, including autofill context
  const resp = await chrome.runtime.sendMessage({
    type:    'vault_requested',
    payload: {
      origin:       location.origin,
      fieldsFound:  fields.length,
      hasSavedCards,
      pageTitle:    document.title,
    },
  }).catch(() => null);

  if (resp?.ok && resp?.allowed) {
    adapter.attachFieldObservers(fields);
  }
}

/**
 * Checks chrome.storage.local for any saved vault profiles
 * so the background can advertise autofill availability to the UI.
 */
async function checkHasSavedCards() {
  try {
    const result = await chrome.storage.local.get('sv_profiles_v1');
    return Array.isArray(result['sv_profiles_v1']) && result['sv_profiles_v1'].length > 0;
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

domObserver.observe(document.body, { childList: true, subtree: true });

// Run immediately for static pages
init().then(() => { initiated = true; });