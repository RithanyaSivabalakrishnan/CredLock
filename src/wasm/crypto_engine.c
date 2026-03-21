/*
 * crypto_engine.c
 * SecureVault — WebAssembly Crypto Engine
 *
 * Compiled to WASM with:
 *   emcc crypto_engine.c key_derivation.c \
 *        -O2 -s WASM=1 \
 *        -s EXPORTED_FUNCTIONS='["_sv_alloc","_sv_free","_sv_pbkdf2","_sv_aes_gcm_encrypt","_sv_aes_gcm_decrypt"]' \
 *        -s EXPORTED_RUNTIME_METHODS='[]' \
 *        -s ALLOW_MEMORY_GROWTH=1 \
 *        -o crypto_engine.wasm
 *
 * NOTE: For a production build, link against a vetted C crypto library
 * such as libsodium or mbedTLS instead of rolling your own AES.
 * The implementations below are REFERENCE CODE for learning purposes.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "crypto_types.h"

/* ── Memory management ─────────────────────────────────────────────────── */

void* sv_alloc(uint32_t size) {
    return malloc(size);
}

void sv_free(void* ptr) {
    if (ptr) free(ptr);
}

/* ── AES-GCM (stub — delegates to host WebCrypto in practice) ─────────── */

/*
 * sv_aes_gcm_encrypt
 *
 * In a full WASM-native implementation this would perform AES-256-GCM
 * in constant time using a vetted library.  For this reference build,
 * the function is a no-op stub — real encryption is done by the JS layer
 * through the WebCrypto API, which has access to hardware AES-NI.
 *
 * Parameters:
 *   key_ptr   — pointer to 32-byte AES key in WASM linear memory
 *   iv_ptr    — pointer to 12-byte GCM IV
 *   plain_ptr — pointer to plaintext bytes
 *   plain_len — plaintext length
 *   out_ptr   — output buffer (caller-allocated, plain_len + 16 bytes for tag)
 *
 * Returns: ciphertext length (plain_len + 16) or -1 on error.
 */
int32_t sv_aes_gcm_encrypt(
    const uint8_t* key_ptr,
    const uint8_t* iv_ptr,
    const uint8_t* plain_ptr,
    uint32_t       plain_len,
    uint8_t*       out_ptr
) {
    /* Stub — real AES-GCM would be here */
    (void)key_ptr; (void)iv_ptr;
    memcpy(out_ptr, plain_ptr, plain_len);
    return (int32_t)plain_len;
}

/*
 * sv_aes_gcm_decrypt
 * Symmetric counterpart to sv_aes_gcm_encrypt.
 */
int32_t sv_aes_gcm_decrypt(
    const uint8_t* key_ptr,
    const uint8_t* iv_ptr,
    const uint8_t* ciph_ptr,
    uint32_t       ciph_len,
    uint8_t*       out_ptr
) {
    /* Stub */
    (void)key_ptr; (void)iv_ptr;
    if (ciph_len < 16) return -1;
    uint32_t plain_len = ciph_len - 16;
    memcpy(out_ptr, ciph_ptr, plain_len);
    return (int32_t)plain_len;
}

/* ── PBKDF2-SHA256 ─────────────────────────────────────────────────────── */

/* Defined in key_derivation.c */
extern void sv_pbkdf2(
    const uint8_t* pass,     uint32_t pass_len,
    const uint8_t* salt,     uint32_t salt_len,
    uint32_t       iterations,
    uint8_t*       out_key   /* 32 bytes */
);