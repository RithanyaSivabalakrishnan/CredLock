/**
 * auth_chrome_identity.js
 * OS analog: "Credential manager / PAM Google SSO module"
 *
 * Wraps the Chrome Identity API to obtain OAuth tokens.
 * The autofill feature only allows decryption and display of saved cards
 * after this module successfully authenticates the user.
 *
 * Exports:
 *   login()           — interactive sign-in, returns token or null
 *   getAuthToken()    — silent token retrieval; prompts if needed
 *   revokeToken(tok)  — revoke a cached token
 *   getProfileInfo()  — returns { email, id } for the signed-in account
 */

export class AuthChromeIdentity {

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Performs an interactive login and returns a Google OAuth token.
   * Called by VaultUnlockFlow when the user taps "Sign in with Google".
   *
   * @returns {Promise<string|null>}  OAuth token, or null on failure / cancel
   */
  async login() {
    return this.#requestToken(true);
  }

  /**
   * Returns a cached or freshly-requested OAuth token.
   * Tries silently first; prompts interactively if no cached token exists.
   *
   * This is the primary entry point used by vault_unlock_flow.js.
   *
   * @param {boolean} [interactive=true]
   * @returns {Promise<string|null>}
   */
  async getAuthToken(interactive = true) {
    // Try silent first
    const silent = await this.#requestToken(false);
    if (silent) return silent;

    // Fall back to interactive if caller allows it
    if (interactive) return this.#requestToken(true);
    return null;
  }

  /**
   * Revokes a cached token, forcing re-authentication on the next unlock.
   *
   * @param {string} token
   * @returns {Promise<void>}
   */
  async revokeToken(token) {
    if (!token) return;
    return new Promise((resolve) => {
      chrome.identity.removeCachedAuthToken({ token }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[AuthChromeIdentity] revokeToken:', chrome.runtime.lastError.message);
        }
        resolve();
      });
    });
  }

  /**
   * Returns the signed-in user's account info (email + Google account ID).
   * Useful for displaying a lock-screen "hello" message in the vault UI.
   *
   * @returns {Promise<{ email: string, id: string }|null>}
   */
  async getProfileInfo() {
    return new Promise((resolve) => {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
        if (chrome.runtime.lastError) {
          console.warn('[AuthChromeIdentity] getProfileInfo:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(info ?? null);
        }
      });
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async #requestToken(interactive) {
    return new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError) {
          console.warn('[AuthChromeIdentity] getAuthToken:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(token ?? null);
        }
      });
    });
  }
}