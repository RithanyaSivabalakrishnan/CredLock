/*
 * crypto_types.h
 * Shared type definitions for the SecureVault WASM crypto engine.
 *
 * These structs match the JavaScript schema defined in vault_storage_schemas.js:
 *   - vault_record_t   ↔  VaultRecordSchema
 *   - key_t            ↔  WebCryptoKeyManager key bytes
 *   - crypto_context_t ↔  per-operation AES-GCM context
 *
 * Compile with: emcc crypto_engine.c key_derivation.c \
 *   -I. -O2 -s WASM=1 \
 *   -s EXPORTED_FUNCTIONS='["_sv_alloc","_sv_free","_sv_pbkdf2","_sv_hkdf","_sv_aes_gcm_encrypt","_sv_aes_gcm_decrypt"]' \
 *   -s ALLOW_MEMORY_GROWTH=1 -o crypto_engine.wasm
 */

#ifndef CRYPTO_TYPES_H
#define CRYPTO_TYPES_H

#include <stdint.h>
#include <stddef.h>

/* ── Error codes ─────────────────────────────────────────────────────────── */

#define SV_OK                0
#define SV_ERR_INVALID_KEY  -1
#define SV_ERR_INVALID_IV   -2
#define SV_ERR_AUTH_FAIL    -3   /* GCM tag verification failed          */
#define SV_ERR_OVERFLOW     -4   /* Output buffer too small              */
#define SV_ERR_INVALID_LEN  -5   /* Plaintext / ciphertext length error  */
#define SV_ERR_NULL_PTR     -6   /* Required pointer is NULL             */

/* ── Size constants (must match vault_storage_schemas.js CRYPTO_LAYOUT) ─── */

#define SV_AES_KEY_BYTES    32   /* 256-bit AES key                      */
#define SV_GCM_IV_BYTES     12   /* 96-bit GCM IV                        */
#define SV_GCM_TAG_BYTES    16   /* 128-bit GCM authentication tag       */
#define SV_PBKDF2_DK_BYTES  32   /* PBKDF2 derived key length            */
#define SV_HKDF_OKM_BYTES   32   /* HKDF output key material length      */
#define SV_PBKDF2_MIN_ITER  100000
#define SV_MAX_PROFILE_ID   64   /* max profileId string length          */
#define SV_MAX_PLAINTEXT    4096 /* max plaintext bytes for a card record */

/* ── key_t — 256-bit AES key ─────────────────────────────────────────────── */

typedef struct {
    uint8_t  bytes[SV_AES_KEY_BYTES];
    uint32_t len;                        /* always SV_AES_KEY_BYTES      */
} key_t;

/* ── iv_t — 96-bit GCM initialisation vector ────────────────────────────── */

typedef struct {
    uint8_t bytes[SV_GCM_IV_BYTES];
} iv_t;

/* ── tag_t — 128-bit GCM authentication tag ─────────────────────────────── */

typedef struct {
    uint8_t bytes[SV_GCM_TAG_BYTES];
} tag_t;

/* ── crypto_context_t — per-operation AES-GCM state ─────────────────────── */

typedef struct {
    key_t    key;
    iv_t     iv;
    tag_t    tag;
    uint32_t plaintext_len;
    uint32_t ciphertext_len;
    int32_t  status;             /* SV_OK or SV_ERR_* code               */
} crypto_context_t;

/* ── vault_record_t — matches VaultRecordSchema in vault_storage_schemas.js  */
/*    Represents one encrypted vault record passed to/from the WASM module.   */

typedef struct {
    char     profile_id[SV_MAX_PROFILE_ID];  /* null-terminated string   */
    uint8_t  encrypted[SV_MAX_PLAINTEXT + SV_GCM_IV_BYTES + SV_GCM_TAG_BYTES];
    uint32_t encrypted_len;
    uint8_t  iv[SV_GCM_IV_BYTES];            /* copy of prepended IV     */
    uint8_t  tag[SV_GCM_TAG_BYTES];          /* GCM auth tag             */
    uint32_t updated_at;                     /* unix timestamp (s)       */
} vault_record_t;

/* ── pbkdf2_params_t — PBKDF2 key derivation parameters ─────────────────── */

typedef struct {
    const uint8_t* password;
    uint32_t       password_len;
    const uint8_t* salt;
    uint32_t       salt_len;
    uint32_t       iterations;
    uint8_t        out_key[SV_PBKDF2_DK_BYTES];
} pbkdf2_params_t;

/* ── hkdf_params_t — HKDF per-profile key derivation ────────────────────── */
/*    Derives a profile-specific sub-key from a master key + context string.  */

typedef struct {
    uint8_t        ikm[SV_AES_KEY_BYTES];    /* input key material (master key) */
    const uint8_t* info;                     /* context: profileId bytes         */
    uint32_t       info_len;
    uint8_t        salt[SV_GCM_IV_BYTES];    /* optional HKDF salt               */
    uint32_t       salt_len;
    uint8_t        okm[SV_HKDF_OKM_BYTES];  /* output key material              */
} hkdf_params_t;

/* ── Function prototypes ─────────────────────────────────────────────────── */

/* Memory management */
void*   sv_alloc(uint32_t size);
void    sv_free(void* ptr);

/* AES-GCM encrypt / decrypt */
int32_t sv_aes_gcm_encrypt(
    const uint8_t* key_ptr,    /* SV_AES_KEY_BYTES                        */
    const uint8_t* iv_ptr,     /* SV_GCM_IV_BYTES                         */
    const uint8_t* plain_ptr,
    uint32_t       plain_len,
    uint8_t*       out_ptr     /* plain_len + SV_GCM_TAG_BYTES            */
);

int32_t sv_aes_gcm_decrypt(
    const uint8_t* key_ptr,
    const uint8_t* iv_ptr,
    const uint8_t* ciph_ptr,   /* ciphertext + tag                        */
    uint32_t       ciph_len,
    uint8_t*       out_ptr     /* plaintext output                        */
);

/* PBKDF2-SHA256 — passphrase → derived key */
void sv_pbkdf2(
    const uint8_t* pass,
    uint32_t       pass_len,
    const uint8_t* salt,
    uint32_t       salt_len,
    uint32_t       iterations,
    uint8_t*       out_key    /* SV_PBKDF2_DK_BYTES bytes                 */
);

/* HKDF-SHA256 — master key + profileId context → profile sub-key */
void sv_hkdf(
    const uint8_t* ikm,        /* SV_AES_KEY_BYTES input key material     */
    const uint8_t* info,       /* context bytes (e.g. profileId UTF-8)    */
    uint32_t       info_len,
    const uint8_t* salt,       /* optional; pass NULL for no salt         */
    uint32_t       salt_len,
    uint8_t*       okm         /* SV_HKDF_OKM_BYTES output                */
);

#endif /* CRYPTO_TYPES_H */