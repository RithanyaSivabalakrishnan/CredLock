/**
 * auth_biometric_stub.js
 * OS analog: "PAM biometric module"
 *
 * Uses the WebAuthn API (navigator.credentials) for device-bound
 * biometric authentication.  In Chrome extensions, WebAuthn is available
 * in popup / side-panel pages.
 *
 * Flow:
 *   1. First use  → register a resident key (stored on device authenticator)
 *   2. Subsequent → authenticate (returns assertion) → derive vault key
 *
 * The credential ID is persisted in chrome.storage.local.
 */

const CRED_ID_KEY = 'sv_webauthn_cred_id';
const RP_ID       = chrome.runtime.id;  // Extension origin as relying party
const RP_NAME     = 'CredLock';

export class AuthBiometricStub {

  /**
   * Returns a biometric-derived token (base64 of assertion signature).
   * Registers on first call, authenticates on subsequent calls.
   *
   * @returns {Promise<string|null>}  token string or null on failure/cancel
   */
  async authenticate() {
    const existingCredId = await this.#getStoredCredId();

    if (!existingCredId) {
      return this.#register();
    }
    return this.#assert(existingCredId);
  }

  // ── Private ───────────────────────────────────────────────────────────

  async #register() {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId    = crypto.getRandomValues(new Uint8Array(16));

    let credential;
    try {
      credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp:   { id: RP_ID, name: RP_NAME },
          user: { id: userId, name: 'vault-user', displayName: 'Vault User' },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7  },  // ES256
            { type: 'public-key', alg: -257 }, // RS256
          ],
          authenticatorSelection: {
            userVerification:       'required',
            residentKey:            'preferred',
            requireResidentKey:     false,
          },
          timeout: 60000,
          attestation: 'none',
        }
      });
    } catch (err) {
      console.warn('[AuthBiometricStub] Registration failed:', err.message);
      return null;
    }

    // Persist credential ID
    const credIdB64 = btoa(String.fromCharCode(
      ...new Uint8Array(credential.rawId)
    ));
    await chrome.storage.local.set({ [CRED_ID_KEY]: credIdB64 });

    // Return the clientDataJSON hash as the "token"
    return this.#digestToToken(credential.response.clientDataJSON);
  }

  async #assert(credIdB64) {
    const credIdBin = atob(credIdB64);
    const credIdBuf = new Uint8Array(credIdBin.length);
    for (let i = 0; i < credIdBin.length; i++) {
      credIdBuf[i] = credIdBin.charCodeAt(i);
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32));

    let assertion;
    try {
      assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ type: 'public-key', id: credIdBuf.buffer }],
          userVerification: 'required',
          timeout: 60000,
        }
      });
    } catch (err) {
      console.warn('[AuthBiometricStub] Assertion failed:', err.message);
      return null;
    }

    return this.#digestToToken(assertion.response.authenticatorData);
  }

  async #getStoredCredId() {
    const res = await chrome.storage.local.get(CRED_ID_KEY);
    return res[CRED_ID_KEY] ?? null;
  }

  /** Produces a stable string token from raw bytes (SHA-256 → base64) */
  async #digestToToken(buffer) {
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return btoa(String.fromCharCode(...new Uint8Array(hash)));
  }
}