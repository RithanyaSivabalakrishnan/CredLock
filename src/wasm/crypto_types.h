/*
 * crypto_types.h
 * SecureVault — Shared Crypto Types
 *
 * Defines all structs, constants, and return codes used across
 * crypto_engine.c and key_derivation.c.
 *
 * These types mirror vault_storage_schemas.js so the JS layer and
 * the Wasm layer agree on layout when passing encrypted blobs.
 */

#ifndef CRYPTO_TYPES_H
#define CRYPTO_TYPES_H

#include <stdint.h>
#include <stddef.h>

/* ─── Size constants ────────────────────────────────────────────────────────── */

#define SV_KEY_SIZE         32    /* AES-256 key: 256 bits                      */
#define SV_BLOCK_SIZE       16    /* AES block: 128 bits                        */
#define SV_IV_SIZE          12    /* GCM recommended nonce: 96 bits             */
#define SV_TAG_SIZE         16    /* GCM authentication tag: 128 bits           */
#define SV_SALT_SIZE        32    /* PBKDF2 salt: 256 bits                      */
#define SV_HASH_SIZE        32    /* SHA-256 digest: 256 bits                   */

#define PBKDF2_ITERATIONS   100000

/* ─── Return codes ──────────────────────────────────────────────────────────── */

#define SV_OK               0
#define SV_ERR_NULLPTR     -1    /* NULL pointer passed to a required argument  */
#define SV_ERR_LENGTH      -2    /* Buffer or length out of acceptable range    */
#define SV_ERR_AUTH        -3    /* GCM tag mismatch — ciphertext tampered      */
#define SV_ERR_ALLOC       -4    /* Memory allocation failure                   */

/* ─── key_t ─────────────────────────────────────────────────────────────────── */
/*
 * Holds a 256-bit AES key.
 * The 'active' flag is checked before use — ensures a zero-initialised
 * key_t is never silently accepted as a valid key.
 */
typedef struct {
    uint8_t  bytes[SV_KEY_SIZE];
    uint8_t  active;              /* 1 = key is set, 0 = uninitialized         */
} key_t;

/* ─── crypto_context_t ──────────────────────────────────────────────────────── */
/*
 * Passed into sv_encrypt / sv_decrypt so callers don't juggle
 * individual pointer arguments for IV, AAD, etc.
 */
typedef struct {
    const uint8_t *key;           /* SV_KEY_SIZE bytes                         */
    const uint8_t *iv;            /* SV_IV_SIZE  bytes                         */
    const uint8_t *aad;           /* Additional authenticated data (may be NULL)*/
    size_t         aad_len;
} crypto_context_t;

/* ─── vault_record_t ────────────────────────────────────────────────────────── */
/*
 * In-memory representation of one encrypted credential entry.
 * Matches the JS schema:
 *   { iv, ciphertext, tag }
 *
 * ciphertext and plaintext share the same max size — callers must
 * allocate at least 'data_len' bytes for both buffers.
 */
typedef struct {
    uint8_t  iv[SV_IV_SIZE];      /* Per-record random nonce                   */
    uint8_t  tag[SV_TAG_SIZE];    /* GCM authentication tag                    */
    uint8_t *ciphertext;          /* Caller-allocated, length = data_len        */
    uint8_t *plaintext;           /* Caller-allocated, length = data_len        */
    size_t   data_len;
} vault_record_t;

#endif /* CRYPTO_TYPES_H */
