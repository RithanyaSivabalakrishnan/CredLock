/**
 * wasm_crypto_bindings.js
 * Loads crypto_engine.wasm and exposes its exported functions to JS.
 *
 * The WASM module exports:
 *   - sv_aes_gcm_encrypt(keyPtr, keyLen, ivPtr, plainPtr, plainLen) → ciphertextPtr
 *   - sv_aes_gcm_decrypt(keyPtr, keyLen, ivPtr, ciphPtr, ciphLen)   → plaintextPtr
 *   - sv_pbkdf2(passphrasePtr, passLen, saltPtr, saltLen, iters)    → keyPtr
 *   - sv_free(ptr)
 *
 * Memory layout: The WASM linear memory is shared; pointers are i32 offsets.
 * All data is copied in/out via DataView — no direct memory aliasing from JS.
 */

export class WasmCryptoBindings {
  #instance = null;
  #memory   = null;

  async load() {
    const wasmUrl = chrome.runtime.getURL('src/wasm/crypto_engine.wasm');
    const resp    = await fetch(wasmUrl);
    const bytes   = await resp.arrayBuffer();

    const { instance } = await WebAssembly.instantiate(bytes, {
      env: {
        // WASM imports — memory and abort handler
        memory: new WebAssembly.Memory({ initial: 16 }),  // 1 MB
        sv_abort: (msg, file, line, col) => {
          throw new Error(`[WASM] abort at ${file}:${line}:${col} — ${msg}`);
        },
      }
    });

    this.#instance = instance;
    this.#memory   = instance.exports.memory ?? new WebAssembly.Memory({ initial: 16 });
    console.log('[WasmCryptoBindings] WASM instance ready');
  }

  // ── High-level wrappers ────────────────────────────────────────────────

  /**
   * AES-GCM encryption via WASM.
   * NOTE: The WASM module handles the actual AES operation;
   *       this bridge copies data into/out of linear memory.
   */
  async encryptAesGcm(key, iv, plaintext) {
    if (!this.#instance) throw new Error('WASM not loaded');

    const exports = this.#instance.exports;

    // Export CryptoKey raw bytes (requires extractable key — see key manager)
    // In practice we call WebCrypto encrypt and pass the result to WASM for
    // any additional processing (e.g. HMAC tagging).  Full WASM AES requires
    // an extractable key, which we avoid; so this hybrid approach is used.
    throw new Error('Full WASM AES-GCM not yet implemented — use WebCrypto fallback');
  }

  async decryptAesGcm(key, iv, ciphertext) {
    throw new Error('Full WASM AES-GCM not yet implemented — use WebCrypto fallback');
  }

  /**
   * PBKDF2 key derivation via WASM.
   * Mirrors the C function: sv_pbkdf2(pass, passLen, salt, saltLen, iterations) → 32-byte key.
   */
  async pbkdf2(passphrase, salt, iterations) {
    if (!this.#instance) throw new Error('WASM not loaded');

    const exports   = this.#instance.exports;
    const mem       = new Uint8Array(this.#memory.buffer);
    const enc       = new TextEncoder();

    const passBytes = enc.encode(passphrase);
    const saltBytes = salt instanceof Uint8Array ? salt : enc.encode(salt);

    // Allocate WASM memory
    const passPtr = exports.sv_alloc(passBytes.length);
    const saltPtr = exports.sv_alloc(saltBytes.length);
    const keyPtr  = exports.sv_alloc(32);

    mem.set(passBytes, passPtr);
    mem.set(saltBytes, saltPtr);

    exports.sv_pbkdf2(passPtr, passBytes.length, saltPtr, saltBytes.length, iterations, keyPtr);

    // Read derived key bytes
    const keyBytes = new Uint8Array(this.#memory.buffer, keyPtr, 32).slice();

    // Free WASM memory
    exports.sv_free(passPtr);
    exports.sv_free(saltPtr);
    exports.sv_free(keyPtr);

    // Import as WebCrypto key (non-extractable)
    return crypto.subtle.importKey(
      'raw', keyBytes,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ── Low-level memory helpers ───────────────────────────────────────────

  #writeBytes(ptr, bytes) {
    new Uint8Array(this.#memory.buffer).set(bytes, ptr);
  }

  #readBytes(ptr, length) {
    return new Uint8Array(this.#memory.buffer, ptr, length).slice();
  }
}