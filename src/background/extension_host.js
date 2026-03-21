/**
 * extension_host.js
 * OS analog: "Process manager / kernel scheduler"
 *
 * Central coordinator between content scripts, vault UI, and background.
 * Handles all recognised message types, routes them to the correct handler,
 * and enforces the site allowlist via SandboxPolicy before any autofill.
 */

import { SandboxPolicy } from './sandbox_policy.js';

export class ExtensionHost {
  #vaultSessions = new Map(); // tabId → VaultSession
  #policy        = new SandboxPolicy();

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init() {
    await this.#policy.loadDefaults();

    // Pre-warm Google Identity token silently
    try {
      await chrome.identity.getAuthToken({ interactive: false });
    } catch (_) { /* not signed in yet — fine */ }

    console.log('[ExtensionHost] Initialised');
  }

  // ── Central IPC dispatcher ────────────────────────────────────────────────

  /**
   * Routes a chrome.runtime message to the correct handler.
   * Called from extension_main.js onMessage listener.
   *
   * @param {{ type: string, payload?: any }} msg
   * @param {chrome.runtime.MessageSender}   sender
   * @returns {Promise<object>}
   */
  async dispatch(msg, sender) {
    const { type, payload } = msg;
    const tabId = sender.tab?.id ?? null;

    switch (type) {

      // ── Content script: payment page detected ──────────────────────────
      case 'vault_requested':
        return this.#onVaultRequested(tabId, payload);

      // ── Vault UI: user completed unlock ───────────────────────────────
      case 'vault_unlocked':
        return this.#onVaultUnlocked(tabId, payload);

      // ── Content script: form fill confirmed ───────────────────────────
      case 'vault_data_filled':
        return this.#onVaultDataFilled(tabId, payload);

      // ── Vault UI: user explicitly closed vault ─────────────────────────
      case 'VAULT_CLOSE':
        return this.#closeSession(tabId);

      // ── Vault UI / content script: status query ────────────────────────
      case 'VAULT_STATUS':
        return this.#getStatus(tabId);

      // ── Masked data ready for injection into merchant DOM ──────────────
      case 'MASKED_DATA_READY':
        return this.#onMaskedDataReady(tabId, payload);

      default:
        console.warn('[ExtensionHost] Unknown message type:', type);
        return { ok: false, error: `Unknown message type: ${type}` };
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  /**
   * Merchant content script detected a payment page and is requesting vault.
   * Check allowlist before opening a session.
   */
  async #onVaultRequested(tabId, payload = {}) {
    const { origin = '', fieldsFound = 0, hasSavedCards = false } = payload;

    if (!this.#policy.isAllowed(origin)) {
      console.log('[ExtensionHost] vault_requested denied — origin not in allowlist:', origin);
      return { ok: false, allowed: false, reason: 'origin_not_allowed' };
    }

    if (!tabId) return { ok: false, error: 'No tabId' };

    this.#vaultSessions.set(tabId, {
      tabId,
      origin,
      fieldsFound,
      hasSavedCards,
      locked:      true,
      autofillReady: false,
      openedAt:    Date.now(),
    });

    console.log(`[ExtensionHost] vault_requested accepted — tab ${tabId}, origin: ${origin}`);

    // Notify the vault UI that autofill may be available
    this.#notifyVaultUI(tabId, {
      type:    'VAULT_READY',
      payload: { origin, fieldsFound, hasSavedCards },
    });

    return { ok: true, allowed: true, sessionId: `vsid-${tabId}-${Date.now()}` };
  }

  /**
   * Vault UI reports successful unlock.
   * Mark session as unlocked and signal content script to prepare form.
   */
  async #onVaultUnlocked(tabId, payload = {}) {
    const session = this.#vaultSessions.get(tabId);
    if (!session) return { ok: false, error: 'No session for tab' };

    session.locked        = false;
    session.autofillReady = payload.autofillEnabled ?? false;
    this.#vaultSessions.set(tabId, session);

    console.log(`[ExtensionHost] vault_unlocked — tab ${tabId}, autofill: ${session.autofillReady}`);

    // Tell content script the vault is unlocked and whether autofill is ready
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type:    'VAULT_UNLOCKED',
        payload: { autofillReady: session.autofillReady },
      }).catch(() => {});
    }

    return { ok: true };
  }

  /**
   * Content script confirms that vault data was successfully filled into form.
   */
  async #onVaultDataFilled(tabId, payload = {}) {
    const session = this.#vaultSessions.get(tabId);
    if (session) {
      session.lastFilled = Date.now();
      session.filledFields = payload.fields ?? [];
      this.#vaultSessions.set(tabId, session);
    }

    console.log(`[ExtensionHost] vault_data_filled — tab ${tabId}`, payload.fields);
    return { ok: true };
  }

  /**
   * Vault UI has prepared masked tokens; relay them to the content script.
   */
  async #onMaskedDataReady(tabId, payload) {
    if (!tabId) return { ok: false, error: 'No tabId' };

    chrome.tabs.sendMessage(tabId, {
      type:    'INJECT_MASKED',
      payload,
    }).catch(() => {});

    return { ok: true };
  }

  async #closeSession(tabId) {
    const removed = this.#vaultSessions.delete(tabId);
    return { ok: removed };
  }

  async #getStatus(tabId) {
    const session = this.#vaultSessions.get(tabId) ?? null;
    return { ok: true, session };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Best-effort notification to the vault popup/side-panel.
   * In MV3, the service worker cannot directly message a popup; we store
   * the pending notification in session state so the vault UI can poll it
   * via VAULT_STATUS on open, or receive it if already open.
   */
  #notifyVaultUI(tabId, msg) {
    // Attempt direct delivery (works if popup is currently open)
    chrome.runtime.sendMessage(msg).catch(() => {
      // Popup not open — store in session for it to pick up on next open
      const session = this.#vaultSessions.get(tabId);
      if (session) {
        session.pendingNotification = msg;
        this.#vaultSessions.set(tabId, session);
      }
    });
  }

  /**
   * Checks whether autofill is allowed for a given URL via the policy.
   * Can be called by other modules.
   */
  isAutofillAllowed(url) {
    return this.#policy.isAllowed(url);
  }
}