/**
 * sandbox_policy.js
 * OS analog: "Security Policy / SELinux rules"
 *
 * Defines per-site domain allowlists, allowed form fields, and UI-mode
 * decisions.  Exports isAllowed(domain) as the primary public API.
 */

// ── Default allowed domains (exact hostname match) ────────────────────────

const DEFAULT_ALLOWED_DOMAINS = [
  // Major global banks
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citibank.com',
  'usbank.com', 'capitalone.com', 'tdbank.com', 'pnc.com',
  'hsbc.com', 'barclays.co.uk', 'lloydsbank.com', 'natwest.com',
  'santander.co.uk', 'rbs.co.uk', 'halifax.co.uk',
  'sbi.co.in', 'hdfcbank.com', 'icicibank.com', 'axisbank.com',
  // Payment gateways / processors
  'stripe.com', 'paypal.com', 'razorpay.com', 'payu.com',
  'braintreegateway.com', 'squareup.com', 'checkout.com',
  'adyen.com', 'klarna.com', 'affirm.com', 'afterpay.com',
  // Major e-commerce checkout domains
  'amazon.com', 'amazon.in', 'amazon.co.uk',
  'flipkart.com', 'shopify.com', 'ebay.com',
];

// ── Keyword patterns (substring match on hostname) ────────────────────────

const DEFAULT_HOSTNAME_PATTERNS = [
  'bank', 'checkout', 'payment', 'pay', 'wallet', 'finance', 'secure',
];

// ── Allowed form field identifiers ────────────────────────────────────────

/**
 * Set of autocomplete / name / data-vault-field values the vault
 * is permitted to interact with on a merchant form.
 * Exported so merchant_dom_adapter.js can filter its selectors.
 */
export const ALLOWED_FIELDS = new Set([
  'cc-number',
  'cardnumber',
  'card-number',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-csc',
  'cvv',
  'cvc',
  'expiry',
  'expiration',
  'otp',
  'one-time-password',
  'cardholder-name',
  'cardholder',
  'billing-name',
]);

const STORAGE_KEY = 'sandbox_policy_v1';

export class SandboxPolicy {
  #allowedDomains = new Set(DEFAULT_ALLOWED_DOMAINS);
  #patterns       = [...DEFAULT_HOSTNAME_PATTERNS];
  #uiMode         = 'popup'; // 'popup' | 'sidepanel'

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async loadDefaults() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      if (stored[STORAGE_KEY]) {
        const saved = stored[STORAGE_KEY];
        this.#uiMode = saved.uiMode ?? 'popup';
        if (Array.isArray(saved.domains))   this.#allowedDomains = new Set(saved.domains);
        if (Array.isArray(saved.patterns))  this.#patterns = saved.patterns;
      } else {
        await this.#persist();
      }
    } catch (err) {
      console.warn('[SandboxPolicy] Failed to load persisted policy:', err.message);
    }
    console.log('[SandboxPolicy] Loaded', this.#allowedDomains.size, 'domains,',
      this.#patterns.length, 'keyword patterns');
  }

  // ── Primary API ───────────────────────────────────────────────────────────

  /**
   * Returns true if the vault can activate for the given domain.
   * Accepts a bare hostname ("chase.com") or a full URL string.
   *
   * @param {string} domain  — hostname or full URL
   * @returns {boolean}
   */
  isAllowed(domain) {
    if (!domain) return false;
    const hostname = this.#extractHostname(domain);

    // Exact match
    if (this.#allowedDomains.has(hostname)) return true;

    // Subdomain match — "secure.chase.com" matches "chase.com"
    for (const allowed of this.#allowedDomains) {
      if (hostname.endsWith('.' + allowed)) return true;
    }

    // Keyword pattern match
    return this.#patterns.some(p => hostname.includes(p));
  }

  /**
   * Alias — accepts a full URL; extracts hostname internally.
   * Used by extension_main.js tab.onUpdated handler.
   */
  isAllowedSite(url) {
    return this.isAllowed(url);
  }

  /**
   * Returns true if a form field identifier is on the vault's allowlist.
   * @param {string} fieldId  — autocomplete value, name attr, or data-vault-field
   */
  isAllowedField(fieldId) {
    if (!fieldId) return false;
    return ALLOWED_FIELDS.has(fieldId.toLowerCase().trim());
  }

  /** Returns preferred UI mode ('popup' | 'sidepanel') */
  getUiMode(_url) {
    return this.#uiMode;
  }

  // ── Mutation ──────────────────────────────────────────────────────────────

  async addDomain(domain) {
    this.#allowedDomains.add(domain.toLowerCase());
    await this.#persist();
  }

  async removeDomain(domain) {
    this.#allowedDomains.delete(domain.toLowerCase());
    await this.#persist();
  }

  async setUiMode(mode) {
    this.#uiMode = mode;
    await this.#persist();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  #extractHostname(input) {
    try {
      const url = input.startsWith('http') ? new URL(input) : new URL('https://' + input);
      return url.hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return input.toLowerCase().replace(/^www\./, '');
    }
  }

  async #persist() {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        domains:  [...this.#allowedDomains],
        patterns: this.#patterns,
        uiMode:   this.#uiMode,
      }
    });
  }
}