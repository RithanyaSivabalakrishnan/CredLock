/**
 * vault_unlock_flow.js
 * Orchestrates vault unlock via Google OAuth only.
 * Biometric/device auth removed — Google Identity is the sole unlock path.
 */

import { AuthChromeIdentity } from './auth_chrome_identity.js';

export class VaultUnlockFlow {
  #model;
  #googleAuth = new AuthChromeIdentity();

  constructor(model) {
    this.#model = model;
  }

  /**
   * Unlocks the vault using a Google OAuth token.
   * @returns {Promise<boolean>}
   */
  async unlockWithGoogle() {
    try {
      const token = await this.#googleAuth.getAuthToken(true);
      if (!token) {
        console.warn('[UnlockFlow] Google auth cancelled or failed');
        return false;
      }
      await this.#model.unlock(token);
      await this.#postUnlock();
      console.log('[UnlockFlow] Unlocked via Google Identity');
      return true;
    } catch (err) {
      console.error('[UnlockFlow] Google unlock error:', err.message);
      return false;
    }
  }

  /** Primary entry point — Google only. */
  async unlock() {
    return this.unlockWithGoogle();
  }

  async #postUnlock() {
    const cards = this.#model.getCards();
    console.log('[UnlockFlow] Loaded', cards.length, 'card(s) into memory');
    if (cards.length > 0) {
      this.#model.selectedCardId = cards[0].id;
    }
    try {
      await chrome.runtime.sendMessage({
        type:    'vault_unlocked',
        payload: { autofillEnabled: cards.length > 0, cardCount: cards.length },
      });
    } catch { /* service worker inactive — fine */ }
  }
}
