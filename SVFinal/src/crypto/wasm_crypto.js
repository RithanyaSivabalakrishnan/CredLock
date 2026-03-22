/**
 * wasm_crypto.js
 * OS analog: "Kernel crypto subsystem"
 *
 * High-level encrypt / decrypt interface.  Tries the C/WASM engine first;
 * falls back to the Web Crypto API if the WASM module is unavailable.
 *
 * Exports:
 *   encrypt(key, plaintext, iv?)      → ArrayBuffer  [IV | ciphertext | tag]
 *   decrypt(key, ciphertext, iv, tag) → string       (UTF-8 plaintext)
 *   deriveKey(passphrase, salt, iter) → CryptoKey
 *   init()                            → void
 *   generateId()                      → string UUID
 */

import { WasmCryptoBindings }  from './wasm_crypto_bindings.js';
import { WebCryptoKeyManager }  from './webcrypto_key_manager.js';

export const IV_BYTES  = 12; // AES-GCM 96-bit IV
export const TAG_BYTES = 16; // AES-GCM 128-bit authentication tag

/** Generates a UUID using the platform API. */
export function generateId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

export class WasmCrypto {
  #bindings  = null;
  #useWasm   = false;
  #subtle    = (typeof crypto !== 'undefined') ? crypto.subtle : null;
  #keyMgr    = new WebCryptoKeyManager();

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Attempts to load the WASM crypto engine.
   * Falls back silently to WebCrypto on failure.
   */
  async init() {
    // Only attempt WASM load if the file actually exists (post emcc build)
    try {
      const wasmUrl = chrome.runtime.getURL('src/wasm/crypto_engine.wasm');
      const probe   = await fetch(wasmUrl, { method: 'HEAD' });
      if (!probe.ok) throw new Error('WASM not built');

      this.#bindings = new WasmCryptoBindings();
      await this.#bindings.load();
      this.#useWasm  = true;
      console.log('[WasmCrypto] WASM engine ready');
    } catch (_) {
      // Expected in development — WASM not compiled yet, using WebCrypto
      this.#useWasm = false;
    }
  }

  // ── encrypt ───────────────────────────────────────────────────────────────

  /**
   * Encrypts a UTF-8 string with AES-GCM-256.
   *
   * If `iv` is supplied it is used; otherwise a random 12-byte IV is generated.
   * The returned ArrayBuffer has the layout:
   *   [ IV (12 bytes) | ciphertext | GCM tag (16 bytes) ]
   *
   * @param {CryptoKey}     key        — non-extractable AES-GCM key
   * @param {string}        plaintext  — UTF-8 string to encrypt
   * @param {Uint8Array}   [iv]        — optional 12-byte IV; generated if omitted
   * @returns {Promise<ArrayBuffer>}
   */
  async encrypt(key, plaintext, iv = null) {
    const actualIv  = iv ?? crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encoded   = new TextEncoder().encode(plaintext);

    let cipherWithTag;
    if (this.#useWasm && this.#bindings?.encryptAesGcm) {
      cipherWithTag = await this.#bindings.encryptAesGcm(key, actualIv, encoded);
    } else {
      cipherWithTag = await this.#subtle.encrypt(
        { name: 'AES-GCM', iv: actualIv },
        key,
        encoded
      );
    }

    // Layout: [IV | ciphertext+tag]
    const result = new Uint8Array(IV_BYTES + cipherWithTag.byteLength);
    result.set(actualIv, 0);
    result.set(new Uint8Array(cipherWithTag), IV_BYTES);
    return result.buffer;
  }

  // ── decrypt ───────────────────────────────────────────────────────────────

  /**
   * Decrypts an ArrayBuffer produced by encrypt().
   *
   * Accepts two calling conventions:
   *   1. decrypt(key, buffer)              — buffer = [IV | ciphertext | tag]
   *   2. decrypt(key, ciphertext, iv, tag) — explicit separate params
   *
   * @param {CryptoKey}             key
   * @param {ArrayBuffer|Uint8Array} ciphertext  — packed buffer OR raw ciphertext
   * @param {Uint8Array}            [iv]         — explicit IV (optional)
   * @param {Uint8Array}            [tag]        — explicit GCM tag (optional, unused by WebCrypto)
   * @returns {Promise<string>}
   */
  async decrypt(key, ciphertext, iv = null, tag = null) {
    let actualIv, cipherBody;

    if (iv) {
      // Explicit params: caller supplied iv (and optionally tag) separately
      actualIv   = iv;
      cipherBody = ciphertext instanceof Uint8Array
        ? ciphertext
        : new Uint8Array(ciphertext);
    } else {
      // Packed buffer: [IV (12) | ciphertext+tag]
      const data = new Uint8Array(ciphertext instanceof ArrayBuffer ? ciphertext : ciphertext.buffer);
      actualIv   = data.slice(0, IV_BYTES);
      cipherBody = data.slice(IV_BYTES);
    }

    let plainBytes;
    if (this.#useWasm && this.#bindings?.decryptAesGcm) {
      plainBytes = await this.#bindings.decryptAesGcm(key, actualIv, cipherBody);
    } else {
      plainBytes = await this.#subtle.decrypt(
        { name: 'AES-GCM', iv: actualIv },
        key,
        cipherBody
      );
    }

    return new TextDecoder().decode(plainBytes);
  }

  // ── Key derivation ────────────────────────────────────────────────────────

  /**
   * Derives a 256-bit AES-GCM key from a passphrase via PBKDF2.
   * Delegates to the WASM engine if available, else WebCrypto.
   *
   * @param {string}     passphrase
   * @param {Uint8Array} salt
   * @param {number}     [iterations=200000]
   * @returns {Promise<CryptoKey>}
   */
  async deriveKey(passphrase, salt, iterations = 200_000) {
    if (this.#useWasm && this.#bindings?.pbkdf2) {
      return this.#bindings.pbkdf2(passphrase, salt, iterations);
    }
    return this.#keyMgr.deriveKeyFromPassphrase(passphrase, salt, iterations);
  }

  /** Exposes the key manager for modules that need createMasterKey() etc. */
  get keyManager() { return this.#keyMgr; }
}