/**
 * wasm_crypto_bindings.js
 * Low-level bridge between JavaScript and the C/WebAssembly crypto engine.
 *
 * Exports typed-array wrappers and memory management helpers so that
 * wasm_crypto.js can pass data to and from the WASM module without memory leaks.
 *
 * WASM exports used:
 *   sv_alloc(size)                                        → ptr
 *   sv_free(ptr)                                          → void
 *   sv_aes_gcm_encrypt(keyPtr, ivPtr, plainPtr, plainLen, outPtr) → int32
 *   sv_aes_gcm_decrypt(keyPtr, ivPtr, ciphPtr, ciphLen, outPtr)   → int32
 *   sv_pbkdf2(passPtr, passLen, saltPtr, saltLen, iters, outPtr)  → void
 *   sv_hkdf(ikmPtr, infoPtr, infoLen, saltPtr, saltLen, outPtr)   → void
 *
 * Memory layout (WASM linear memory):
 *   Pointers are i32 byte offsets from memory base.
 *   All data is copied in/out via Uint8Array views — no aliasing from JS.
 */

export class WasmCryptoBindings {
  #instance = null;
  #memory   = null;

  // ── Load ──────────────────────────────────────────────────────────────────

  /**
   * Loads and instantiates the WASM module.
   * Path resolution tries dist/wasm/ first (production), then src/wasm/ (dev).
   */
  async load() {
    const wasmUrl = this.#resolveWasmUrl();
    const resp    = await fetch(wasmUrl);

    if (!resp.ok) {
      throw new Error(`[WasmCryptoBindings] Failed to fetch WASM: ${resp.status} ${wasmUrl}`);
    }

    const bytes = await resp.arrayBuffer();

    const sharedMemory = new WebAssembly.Memory({ initial: 16, maximum: 256 });

    const { instance } = await WebAssembly.instantiate(bytes, {
      env: {
        memory: sharedMemory,
        sv_abort: (_msg, _file, line, col) => {
          throw new Error(`[WASM] abort at line ${line}:${col}`);
        },
      }
    });

    this.#instance = instance;
    // Prefer the memory exported by the module; fall back to the shared one
    this.#memory   = instance.exports.memory ?? sharedMemory;
    console.log('[WasmCryptoBindings] WASM instance ready');
  }

  // ── PBKDF2 ────────────────────────────────────────────────────────────────

  /**
   * Derives a 32-byte AES-GCM key from a passphrase via PBKDF2-SHA256.
   * Delegates to sv_pbkdf2 in the WASM module.
   *
   * @param {string}     passphrase
   * @param {Uint8Array} salt
   * @param {number}     iterations
   * @returns {Promise<CryptoKey>}  non-extractable AES-GCM-256 key
   */
  async pbkdf2(passphrase, salt, iterations) {
    this.#assertLoaded();
    const exports   = this.#instance.exports;
    const enc       = new TextEncoder();
    const passBytes = enc.encode(passphrase);
    const saltBytes = salt instanceof Uint8Array ? salt : enc.encode(String(salt));

    const passPtr = exports.sv_alloc(passBytes.length);
    const saltPtr = exports.sv_alloc(saltBytes.length);
    const keyPtr  = exports.sv_alloc(32);

    try {
      this.#writeBytes(passPtr, passBytes);
      this.#writeBytes(saltPtr, saltBytes);

      exports.sv_pbkdf2(
        passPtr, passBytes.length,
        saltPtr, saltBytes.length,
        iterations,
        keyPtr
      );

      const keyBytes = this.#readBytes(keyPtr, 32);

      return crypto.subtle.importKey(
        'raw', keyBytes,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    } finally {
      exports.sv_free(passPtr);
      exports.sv_free(saltPtr);
      exports.sv_free(keyPtr);
    }
  }

  // ── HKDF ─────────────────────────────────────────────────────────────────

  /**
   * Derives a 32-byte per-profile sub-key from a master key via HKDF-SHA256.
   * The `info` parameter should be the profileId as UTF-8 bytes.
   *
   * @param {Uint8Array}       ikm      — input key material (master key, 32 bytes)
   * @param {string|Uint8Array} info    — context (profileId)
   * @param {Uint8Array|null}   salt    — optional HKDF salt
   * @returns {Promise<CryptoKey>}
   */
  async hkdf(ikm, info, salt = null) {
    this.#assertLoaded();
    const exports    = this.#instance.exports;
    const enc        = new TextEncoder();
    const infoBytes  = info instanceof Uint8Array ? info : enc.encode(String(info));
    const saltBytes  = salt ?? new Uint8Array(0);

    const ikmPtr  = exports.sv_alloc(32);
    const infoPtr = exports.sv_alloc(infoBytes.length || 1);
    const saltPtr = exports.sv_alloc(saltBytes.length || 1);
    const okmPtr  = exports.sv_alloc(32);

    try {
      this.#writeBytes(ikmPtr,  ikm instanceof Uint8Array ? ikm : new Uint8Array(ikm));
      this.#writeBytes(infoPtr, infoBytes);
      if (saltBytes.length) this.#writeBytes(saltPtr, saltBytes);

      exports.sv_hkdf(
        ikmPtr,
        infoPtr, infoBytes.length,
        saltBytes.length ? saltPtr : 0, saltBytes.length,
        okmPtr
      );

      const okmBytes = this.#readBytes(okmPtr, 32);

      return crypto.subtle.importKey(
        'raw', okmBytes,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    } finally {
      exports.sv_free(ikmPtr);
      exports.sv_free(infoPtr);
      exports.sv_free(saltPtr);
      exports.sv_free(okmPtr);
    }
  }

  // ── AES-GCM (hybrid — WebCrypto does encryption, WASM does post-processing) ─

  /**
   * AES-GCM encryption stub.
   * Full native WASM AES requires an extractable key which we intentionally
   * avoid. The JS layer (wasm_crypto.js) handles AES-GCM via WebCrypto;
   * this method is reserved for future integration with libsodium-wasm.
   */
  async encryptAesGcm(_key, _iv, _plaintext) {
    throw new Error(
      '[WasmCryptoBindings] Native WASM AES-GCM not implemented. ' +
      'wasm_crypto.js uses WebCrypto fallback.'
    );
  }

  async decryptAesGcm(_key, _iv, _ciphertext) {
    throw new Error(
      '[WasmCryptoBindings] Native WASM AES-GCM not implemented. ' +
      'wasm_crypto.js uses WebCrypto fallback.'
    );
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Resolves the WASM file URL.
   * In production (dist/ context): wasm/crypto_engine.wasm
   * In development (source tree):  src/wasm/crypto_engine.wasm
   * Both paths are registered in manifest.json web_accessible_resources.
   */
  #resolveWasmUrl() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      // Try dist path first (production build), then source path (dev)
      try {
        return chrome.runtime.getURL('wasm/crypto_engine.wasm');
      } catch {
        return chrome.runtime.getURL('src/wasm/crypto_engine.wasm');
      }
    }
    // Test/Node environment fallback
    return '/src/wasm/crypto_engine.wasm';
  }

  #assertLoaded() {
    if (!this.#instance) throw new Error('[WasmCryptoBindings] WASM not loaded — call load() first');
  }

  #writeBytes(ptr, bytes) {
    new Uint8Array(this.#memory.buffer).set(bytes, ptr);
  }

  #readBytes(ptr, length) {
    return new Uint8Array(this.#memory.buffer, ptr, length).slice();
  }
}