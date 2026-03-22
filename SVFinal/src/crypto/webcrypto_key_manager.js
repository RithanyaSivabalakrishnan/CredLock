/**
 * webcrypto_key_manager.js
 * OS analog: "Key Management Service / TPM interface"
 *
 * Generates and manages the master key for the vault using the Web Crypto API.
 * Keys are non-extractable and never stored in plain text.
 *
 * Exports:
 *   createMasterKey()                           → CryptoKey  (AES-GCM-256)
 *   exportKey(key, wrappingKey)                 → ArrayBuffer (wrapped)
 *   importKey(wrappedKeyBuffer, wrappingKey)    → CryptoKey
 *   deriveKeyFromToken(token)                   → CryptoKey
 *   deriveKeyFromPassphrase(pass, salt, iters)  → CryptoKey
 */

const PBKDF2_ITERATIONS = 200_000;
const KEY_USAGES        = ['encrypt', 'decrypt'];
const WRAP_USAGES       = ['wrapKey', 'unwrapKey'];
const SALT_STORAGE_KEY  = 'sv_pbkdf2_salt';

export class WebCryptoKeyManager {
  #subtle = (typeof crypto !== 'undefined') ? crypto.subtle : null;

  // ── Master key ─────────────────────────────────────────────────────────────

  /**
   * Generates a fresh non-extractable AES-GCM-256 master key.
   * Used when first creating a vault or rotating the master key.
   *
   * @returns {Promise<CryptoKey>}
   */
  async createMasterKey() {
    return this.#subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,       // non-extractable
      KEY_USAGES
    );
  }

  // ── Export / import (key wrapping) ────────────────────────────────────────

  /**
   * Wraps (exports) a CryptoKey using a wrapping key (AES-KW).
   * The wrapped key can be stored safely in chrome.storage.
   *
   * @param {CryptoKey} key          — the key to wrap (must be extractable)
   * @param {CryptoKey} wrappingKey  — AES-KW wrapping key
   * @returns {Promise<ArrayBuffer>} — wrapped key bytes
   */
  async exportKey(key, wrappingKey) {
    return this.#subtle.wrapKey('raw', key, wrappingKey, 'AES-KW');
  }

  /**
   * Unwraps (imports) a previously wrapped key.
   *
   * @param {ArrayBuffer} wrappedKeyBuffer
   * @param {CryptoKey}   wrappingKey
   * @returns {Promise<CryptoKey>}  — non-extractable AES-GCM key
   */
  async importKey(wrappedKeyBuffer, wrappingKey) {
    return this.#subtle.unwrapKey(
      'raw',
      wrappedKeyBuffer,
      wrappingKey,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      false,         // non-extractable after import
      KEY_USAGES
    );
  }

  // ── Key derivation ─────────────────────────────────────────────────────────

  /**
   * Derives a non-extractable AES-GCM-256 key from an auth token
   * (Google OAuth token or WebAuthn assertion digest).
   * Uses PBKDF2-SHA-256 with a persisted random salt.
   *
   * This is the primary method called by VaultModel.unlock().
   *
   * @param {string} token — auth token string
   * @returns {Promise<CryptoKey>}
   */
  async deriveKeyFromToken(token) {
    const salt = await this.#getOrCreateSalt();
    return this.#pbkdf2(token, salt, PBKDF2_ITERATIONS);
  }

  /**
   * Alias kept for backward compatibility with existing call sites
   * that use deriveSessionKey(token).
   */
  async deriveSessionKey(token) {
    return this.deriveKeyFromToken(token);
  }

  /**
   * Derives a key from an explicit passphrase, salt, and iteration count.
   * Used by WasmCrypto.deriveKey() and key_derivation.c companion code.
   *
   * @param {string}     passphrase
   * @param {Uint8Array} salt
   * @param {number}     [iterations=200000]
   * @returns {Promise<CryptoKey>}
   */
  async deriveKeyFromPassphrase(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
    return this.#pbkdf2(passphrase, salt, iterations);
  }

  // ── Wrapping key generation ────────────────────────────────────────────────

  /**
   * Generates an AES-KW key suitable for wrapping / unwrapping other keys.
   * In a production implementation this would be derived from a hardware-
   * backed credential (e.g. device TPM).
   *
   * @returns {Promise<CryptoKey>}
   */
  async createWrappingKey() {
    return this.#subtle.generateKey(
      { name: 'AES-KW', length: 256 },
      false,
      WRAP_USAGES
    );
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async #pbkdf2(passphrase, salt, iterations) {
    const keyMaterial = await this.#subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return this.#subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,   // non-extractable — key never leaves WebCrypto subsystem
      KEY_USAGES
    );
  }

  async #getOrCreateSalt() {
    const stored = await chrome.storage.local.get(SALT_STORAGE_KEY);
    if (stored[SALT_STORAGE_KEY]) {
      const bin = atob(stored[SALT_STORAGE_KEY]);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return buf;
    }
    const salt = crypto.getRandomValues(new Uint8Array(32));
    await chrome.storage.local.set({
      [SALT_STORAGE_KEY]: btoa(String.fromCharCode(...salt)),
    });
    return salt;
  }
}