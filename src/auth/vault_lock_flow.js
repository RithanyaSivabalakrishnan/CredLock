/**
 * vault_lock_flow.js
 * OS analog: "Session termination / memory wiper"
 *
 * Cleanly locks the vault:
 *   1. Calls VaultModel.lock() to zero in-memory secrets
 *   2. Optionally revokes the cached Google auth token
 *   3. Notifies any listening tabs
 */

import { AuthChromeIdentity } from './auth_chrome_identity.js';

export class VaultLockFlow {
  #model;
  #googleAuth = new AuthChromeIdentity();

  constructor(model) {
    this.#model = model;
  }

  /**
   * Locks the vault, zeroing all in-memory sensitive state.
   *
   * @param {{ revokeToken?: boolean }} options
   */
  async lock({ revokeToken = false } = {}) {
    await this.#model.lock();

    if (revokeToken) {
      try {
        const token = await this.#googleAuth.getToken(false);
        if (token) await this.#googleAuth.revokeToken(token);
      } catch (_) {
        // Silently ignore — vault is already locked
      }
    }

    // Notify background service worker
    try {
      await chrome.runtime.sendMessage({ type: 'VAULT_CLOSE' });
    } catch (_) {
      // Service worker may already be inactive — that's fine
    }

    console.log('[LockFlow] Vault locked and memory cleared');
  }

  /**
   * Schedules an auto-lock after a timeout period.
   * Returns a cancel function.
   *
   * @param {number}   ms          — milliseconds until auto-lock
   * @param {Function} onLocked    — callback invoked after lock
   * @returns {Function}           — cancel function
   */
  scheduleAutoLock(ms, onLocked) {
    const timer = setTimeout(async () => {
      await this.lock();
      onLocked?.();
    }, ms);

    return () => clearTimeout(timer);
  }
}