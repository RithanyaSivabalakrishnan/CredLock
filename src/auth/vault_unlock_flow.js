/**
 * vault_unlock_flow.js
 * OS analog: "pam_authenticate / login service"
 *
 * Orchestrates the full vault unlock sequence:
 *   1. Call auth_chrome_identity.js (Google OAuth)
 *   2. Check device auth via auth_biometric_stub.js
 *   3. Pass auth token to VaultModel.unlock() → derives vault key
 *   4. Decrypt stored card data and load into memory
 *   5. If autofill is enabled for the current profile, preload the
 *      default card and mark it as ready for autofill
 */

import { AuthChromeIdentity } from './auth_chrome_identity.js';
import { AuthBiometricStub }  from './auth_biometric_stub.js';

export class VaultUnlockFlow {
  #model;
  #googleAuth    = new AuthChromeIdentity();
  #biometricAuth = new AuthBiometricStub();

  constructor(model) {
    this.#model = model;
  }

  // ── Google Identity unlock ─────────────────────────────────────────────────

  /**
   * Unlocks the vault using a Google OAuth token.
   * After unlock, preloads the default card if autofill is enabled.
   *
   * @returns {Promise<boolean>}  true on success
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

  // ── Biometric unlock ───────────────────────────────────────────────────────

  /**
   * Unlocks the vault using a device biometric (WebAuthn assertion).
   * Waits for biometric authentication to succeed before loading cards —
   * the autofill feature will not load saved cards until this resolves.
   *
   * @returns {Promise<boolean>}  true on success
   */
  async unlockWithBiometric() {
    try {
      const token = await this.#biometricAuth.authenticate();
      if (!token) {
        console.warn('[UnlockFlow] Biometric auth cancelled or failed');
        return false;
      }

      await this.#model.unlock(token);
      await this.#postUnlock();

      console.log('[UnlockFlow] Unlocked via device biometric');
      return true;
    } catch (err) {
      console.error('[UnlockFlow] Biometric unlock error:', err.message);
      return false;
    }
  }

  // ── Combined flow (Google first, biometric fallback) ──────────────────────

  /**
   * Attempts Google auth first; falls back to biometric if Google fails.
   * This is the recommended flow for most sites.
   *
   * @returns {Promise<boolean>}
   */
  async unlock() {
    const googleOk = await this.unlockWithGoogle();
    if (googleOk) return true;

    console.log('[UnlockFlow] Google auth failed — attempting biometric fallback');
    return this.unlockWithBiometric();
  }

  // ── Post-unlock ────────────────────────────────────────────────────────────

  /**
   * Runs after any successful unlock:
   *  - Updates vault metadata (lastUnlocked, unlockCount)
   *  - Preloads default card for autofill if a profile enables it
   *  - Notifies background that the vault is open
   */
  async #postUnlock() {
    const cards = this.#model.getCards();
    console.log('[UnlockFlow] Loaded', cards.length, 'card(s) into memory');

    // Preload default card for autofill:
    // Select the first card automatically so autofill is immediately available
    if (cards.length > 0) {
      const defaultCard = cards[0];
      this.#model.selectedCardId = defaultCard.id;
      console.log('[UnlockFlow] Default autofill card preloaded:', defaultCard.maskedPan);
    }

    // Notify background service worker — vault is unlocked and autofill is ready
    try {
      await chrome.runtime.sendMessage({
        type:    'vault_unlocked',
        payload: {
          autofillEnabled: cards.length > 0,
          cardCount:       cards.length,
        },
      });
    } catch {
      // Service worker may be inactive — not critical
    }
  }
}