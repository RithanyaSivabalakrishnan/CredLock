/**
 * merchant_dom_adapter.js
 * Maps merchant-page form fields to internal identifiers.
 * Exports getFormFields(), setMaskedValue(), setAutofilledData(),
 * and injectMaskedInputs() for use by the vault and dom_injector.
 *
 * Real card data NEVER passes through this module.
 */

import { ALLOWED_FIELDS } from "../background/sandbox_policy.js";

// ── Field selectors ────────────────────────────────────────────────────────

const FIELD_SELECTORS = [
  // Card / payment fields (strong indicators)
  'input[id="cardnumber"]',
  'input[id="expirationdate"]', 
  'input[id="securitycode"]',
  'input[id="name"]',
  'input[name*="verification"]',
  'input[name*="creditcardverification"]', 
  'input[name*="cvvnumber"]',
  'input[name*="cardVerification"]',
  'input[autocomplete="cc-number"]',
  'input[autocomplete="cc-exp"]',
  'input[autocomplete="cc-exp-month"]',
  'input[autocomplete="cc-exp-year"]',
  'input[autocomplete="cc-csc"]',
  'input[name*="card"][type="text"]',
  'input[name*="card"][type="tel"]',
  'input[name*="cardnumber"]',
  'input[name*="card-number"]',
  'input[name*="cvv"]',
  'input[name*="cvc"]',
  'input[name*="expiry"]',
  'input[name*="expiration"]',
  'input[name*="otp"]',
  'input[name*="token"]',
  'input[name*="pin"]',
  'input[placeholder*="Card number" i]',
  'input[placeholder*="CVV" i]',
  'input[placeholder*="CVC" i]',
  'input[placeholder*="Expiry" i]',
  'input[placeholder*="OTP" i]',
  'input[placeholder*="PIN" i]',
  'input[data-vault-field]',

  // Generic fallback: scan broad text/password/tel inputs (for banking fields)
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
];

// Regexes to match banking / login / payment‑like fields
const SENSITIVE_FIELD_REGEXES = [
  /cardnumber/i,
  /expirationdate|expiry|exp|mm.?yy/i, 
  /securitycode|cvv|cvc/i,
  /verification/i,
  /creditcardverification/i,
  /password/i,
  /pwd/i,
  /pass/i,
  /token/i,
  /otp/i,
  /pin/i,
  /cvv/i,
  /cvc/i,
  /card/i,
  /userid/i,
  /user/i,
  /email/i,
  /account/i,
  /bill/i,
  /auth/i,
  /netbanking/i,
  /ibanking/i,
  /login/i,
];

function isLikelySensitiveField(el) {
  const text =
    ((el.getAttribute("name") || "") +
      (el.getAttribute("id") || "") +
      (el.getAttribute("placeholder") || "")).toLowerCase();

  if (el.type === "password") return true;
  if (el.type === "tel" || el.type === "text") {
    return SENSITIVE_FIELD_REGEXES.some(re => re.test(text));
  }
  return false;
}

/** Maps a DOM element to a canonical internal field identifier. */
function getFieldId(el) {
  return (
    el.getAttribute("data-vault-field") ||
    el.getAttribute("autocomplete") ||
    el.getAttribute("name") ||
    el.getAttribute("id") ||
    el.getAttribute("placeholder") ||
    "unknown"
  )
    .toLowerCase()
    .trim();
}

export class MerchantDomAdapter {
  #observedFields = new Map(); // element → fieldId

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Scans the DOM for payment-related input fields.
   * Uses:
   *  1) Strong card/payment selectors, then
   *  2) broad pattern-matching on generic text/tel inputs.
   *
   * @returns {{ element: HTMLInputElement, fieldId: string }[]}
   */
  getFormFields() {
    const seen = new Set();
    const found = [];

    if (window.DEBUG_CREDLOCK) {
    console.log('[CredLock DEBUG] ALL inputs found:', 
      Array.from(document.querySelectorAll('input')).map(i => ({
        id: i.id, name: i.name, placeholder: i.placeholder, type: i.type
      }))
    );
}

    // 1. First, scan with strong card/payment-style selectors
    for (const selector of FIELD_SELECTORS.slice(0, -1)) {
      document.querySelectorAll(selector).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        const fieldId = getFieldId(el);
        found.push({ element: el, fieldId });
      });
    }

    // 2. Fallback: scan generic text/password/tel inputs and apply pattern-match
    const fallbackSelector = FIELD_SELECTORS[FIELD_SELECTORS.length - 1];
    document.querySelectorAll(fallbackSelector).forEach(el => {
      if (seen.has(el)) return;

      // Skip really hidden fields
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      if (isLikelySensitiveField(el)) {
        seen.add(el);
        const fieldId = getFieldId(el);
        found.push({ element: el, fieldId });
      }
    });

    // Debug: show which fields are detected (toggle via window.DEBUG_CREDLOCK)
    if (window.DEBUG_CREDLOCK) {
      const labels = found.map(f => f.fieldId);
      console.log(`[CredLock] Found ${found.length} sensitive fields:`, labels);
    }

    return found;
  }

  /**
   * Writes a masked placeholder value (e.g. "•••• •••• •••• 4242") into
   * the field identified by fieldId.
   *
   * @param {string} fieldId — internal field identifier (canonical name)
   * @param {string} maskedValue — masked / tokenised string
   */
  setMaskedValue(fieldId, maskedValue) {
    const el = this.#findElementByFieldId(fieldId);
    if (!el) {
      console.warn("[MerchantDomAdapter] setMaskedValue: field not found:", fieldId);
      return;
    }
    this.#nativeSet(el, maskedValue);
  }

  /**
   * Writes autofilled data tokens into the merchant form.
   * Only writes fields that are in the ALLOWED_FIELDS set.
   *
   * @param {{ fieldName: string, maskedValue: string }[]} cardData
   */
  setAutofilledData(cardData = []) {
    for (const { fieldName, maskedValue } of cardData) {
      if (!ALLOWED_FIELDS.has(fieldName.toLowerCase())) {
        console.warn("[MerchantDomAdapter] setAutofilledData: field not allowed:", fieldName);
        continue;
      }
      this.setMaskedValue(fieldName, maskedValue);
    }
  }

  /**
   * Batch inject masked tokens array — used by dom_injector.js and
   * content script INJECT_MASKED handler.
   *
   * @param {{ fieldName: string, maskedValue: string }[]} tokens
   */
  injectMaskedInputs(tokens = []) {
    this.setAutofilledData(tokens);
  }

  /**
   * Attaches observers to detected payment fields and overlays a
   * "Secured by CredLock" badge on each.
   *
   * @param {{ element: HTMLInputElement, fieldId: string }[]} fields
   */
  attachFieldObservers(fields) {
    for (const { element, fieldId } of fields) {
      if (this.#observedFields.has(element)) continue;
      this.#observedFields.set(element, fieldId);
      this.#overlayField(element);
    }
  }

  /**
   * Marks fields as autofill-ready — applies a subtle green highlight.
   */
  markFieldsAutofillReady(fields) {
    for (const { element } of fields) {
      element.style.borderColor = "#00e676";
      element.style.boxShadow = "0 0 0 2px rgba(0,230,118,0.18)";
      element.title = "CredLock autofill ready";
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Finds a form element on the merchant page by field identifier.
   * Tries data-vault-field, autocomplete, name, and id attributes.
   */
  #findElementByFieldId(fieldId) {
    const id = fieldId.toLowerCase();

    const selectors = [
      `[data-vault-field="${id}"]`,
      `[autocomplete="${id}"]`,
      `[name="${id}"]`,
      `[name*="${id}"]`,
      `[id="${id}"]`,
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    for (const [el, fid] of this.#observedFields) {
      if (fid === id) return el;
    }

    return null;
  }

  /**
   * Uses the native HTMLInputElement value setter so React/Vue/Angular
   * synthetic event systems receive the change correctly.
   */
  #nativeSet(el, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    );
    if (descriptor?.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Overlays a security badge and makes the field read-only for direct input. */
  #overlayField(field) {
    if (field.parentNode?.classList?.contains("sv-field-wrapper")) return;

    const wrapper = document.createElement("div");
    wrapper.className = "sv-field-wrapper";
    wrapper.style.cssText = `position:relative;display:inline-block;width:${field.offsetWidth || 200}px;`;

    const badge = document.createElement("span");
    badge.textContent = "🔒 CredLock";
    badge.style.cssText = [
      "position:absolute",
      "top:50%",
      "right:8px",
      "transform:translateY(-50%)",
      "font-size:10px",
      "color:#00e676",
      "pointer-events:none",
      "white-space:nowrap",
      "z-index:9999",
    ].join(";");

    field.parentNode?.insertBefore(wrapper, field);
    wrapper.appendChild(field);
    wrapper.appendChild(badge);

    field.setAttribute("readonly", "true");
    field.style.background = "#f0fdf4";
  }
}
