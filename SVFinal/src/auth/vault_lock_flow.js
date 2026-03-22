/**
 * vault_lock_flow.js
 * OS analog: "Session termination / loginctl terminate-session"
 *
 * Cleanly locks the vault:
 *   1. Calls VaultModel.lock() — zeros session key and card array
 *   2. Optionally revokes the cached Google OAuth token
 *   3. Sends VAULT_CLOSE to the background service worker
 *
 * Also provides scheduleAutoLock() for idle-timeout locking in side_panel_ui.js.
 */

import { AuthChromeIdentity } from './auth_chrome_identity.js';

export class VaultLockFlow {
  #model;
  #googleAuth = new AuthChromeIdentity();

  constructor(model) {
    this.#model = model;
  }

  // ── Lock ──────────────────────────────────────────────────────────────────

  /**
   * Locks the vault, zeroing all in-memory sensitive state.
   *
   * @param {{ revokeToken?: boolean }} [options]
   *   revokeToken — if true, also revokes the cached Google OAuth token,
   *                 forcing full re-authentication on the next unlock.
   */
  async lock({ revokeToken = false } = {}) {
    // 1. Zero session key and clear card array
    await this.#model.lock();

    // 2. Optionally revoke OAuth token
    if (revokeToken) {
      try {
        // getAuthToken(interactive=false) — silent only, no UI prompt
        const token = await this.#googleAuth.getAuthToken(false);
        if (token) await this.#googleAuth.revokeToken(token);
      } catch (_) {
        // Token may already be expired or absent — vault is locked regardless
      }
    }

    // 3. Notify background service worker
    try {
      await chrome.runtime.sendMessage({ type: 'VAULT_CLOSE' });
    } catch (_) {
      // Service worker may be inactive — not critical since vault is already locked
    }

    console.log('[LockFlow] Vault locked and memory cleared');
  }

  // ── Auto-lock ─────────────────────────────────────────────────────────────

  /**
   * Schedules an auto-lock after a timeout period of inactivity.
   * Used by side_panel_ui.js which keeps the panel open indefinitely.
   *
   * Returns a cancel function — call it to prevent the auto-lock from firing.
   *
   * @param {number}        ms        — milliseconds of inactivity before locking
   * @param {Function|null} onLocked  — callback invoked after lock completes
   * @returns {Function}              — cancel() function
   *
   * @example
   * const cancel = lockFlow.scheduleAutoLock(5 * 60_000, () => showView('unlock'));
   * document.addEventListener('click', cancel);  // reset on activity
   */
  scheduleAutoLock(ms, onLocked = null) {
    const timer = setTimeout(async () => {
      await this.lock();
      onLocked?.();
    }, ms);

    return () => clearTimeout(timer);
  }
}