/*
 * crypto_engine.c
 * SecureVault — AES-256-GCM Encryption Engine
 *
 * Implements:
 *   - AES-256 key schedule
 *   - AES-256 block cipher (encrypt only — GCM uses CTR mode)
 *   - AES-256-CTR stream cipher
 *   - GHASH over GF(2^128) for GCM authentication
 *   - AES-256-GCM authenticated encryption / decryption
 *
 * All functions are pure C, WASM-safe, no OS dependencies.
 * Key derivation lives in key_derivation.c — this module only
 * consumes already-derived keys via crypto_context_t.
 *
 * Exported to JavaScript via Emscripten:
 *   _sv_encrypt  — AES-256-GCM encrypt
 *   _sv_decrypt  — AES-256-GCM decrypt + tag verify
 *
 * Build:
 *   emcc crypto_engine.c key_derivation.c \
 *     -o vault_crypto.js \
 *     -s EXPORTED_FUNCTIONS='["_sv_encrypt","_sv_decrypt","_sv_derive_key","_sv_hkdf","_sv_hash","_sv_zeroize","_malloc","_free"]' \
 *     -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8"]' \
 *     -s MODULARIZE=1 -s EXPORT_NAME="VaultCrypto" \
 *     -O2 --no-entry
 */

#include "crypto_types.h"
#include <string.h>
#include <stdlib.h>

/* Forward declarations of derivation-module functions needed here */
extern void sv_zeroize(uint8_t *buf, size_t len);

/* ═══════════════════════════════════════════════════════════════════════════════
 *  AES S-Box and round constants
 * ═══════════════════════════════════════════════════════════════════════════════ */

static const uint8_t SBOX[256] = {
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
};

static const uint8_t RCON[11] = {
    0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36
};

/* ─── GF(2^8) multiply — used in MixColumns ──────────────────────────────── */

static uint8_t gmul(uint8_t a, uint8_t b) {
    uint8_t p = 0;
    for (int i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        uint8_t hi = a & 0x80;
        a <<= 1;
        if (hi) a ^= 0x1b;   /* AES irreducible polynomial */
        b >>= 1;
    }
    return p;
}

/* ═══════════════════════════════════════════════════════════════════════════════
 *  AES-256 Key Schedule
 *  Produces 15 round keys × 16 bytes = 240 bytes stored in rk[].
 * ═══════════════════════════════════════════════════════════════════════════════ */

static void aes256_key_schedule(const uint8_t key[SV_KEY_SIZE], uint8_t rk[240]) {
    memcpy(rk, key, SV_KEY_SIZE);
    for (int i = 8; i < 60; i++) {
        uint8_t tmp[4];
        memcpy(tmp, rk + (i-1)*4, 4);
        if (i % 8 == 0) {
            /* RotWord + SubWord + Rcon */
            uint8_t t = tmp[0];
            tmp[0] = SBOX[tmp[1]] ^ RCON[i/8];
            tmp[1] = SBOX[tmp[2]];
            tmp[2] = SBOX[tmp[3]];
            tmp[3] = SBOX[t];
        } else if (i % 8 == 4) {
            /* SubWord only */
            for (int j=0;j<4;j++) tmp[j] = SBOX[tmp[j]];
        }
        for (int j=0;j<4;j++) rk[i*4+j] = rk[(i-8)*4+j] ^ tmp[j];
    }
}

/* ─── AES round functions ─────────────────────────────────────────────────── */

static void add_round_key(uint8_t s[16], const uint8_t *rk) {
    for (int i=0;i<16;i++) s[i] ^= rk[i];
}

static void sub_bytes(uint8_t s[16]) {
    for (int i=0;i<16;i++) s[i] = SBOX[s[i]];
}

static void shift_rows(uint8_t s[16]) {
    uint8_t t;
    /* Row 1: left-rotate by 1 */
    t=s[1]; s[1]=s[5]; s[5]=s[9]; s[9]=s[13]; s[13]=t;
    /* Row 2: left-rotate by 2 */
    t=s[2]; s[2]=s[10]; s[10]=t; t=s[6]; s[6]=s[14]; s[14]=t;
    /* Row 3: left-rotate by 3 (= right-rotate by 1) */
    t=s[15]; s[15]=s[11]; s[11]=s[7]; s[7]=s[3]; s[3]=t;
}

static void mix_columns(uint8_t s[16]) {
    for (int c=0;c<4;c++) {
        uint8_t *col = s + c*4;
        uint8_t a0=col[0],a1=col[1],a2=col[2],a3=col[3];
        col[0] = gmul(a0,2)^gmul(a1,3)^a2^a3;
        col[1] = a0^gmul(a1,2)^gmul(a2,3)^a3;
        col[2] = a0^a1^gmul(a2,2)^gmul(a3,3);
        col[3] = gmul(a0,3)^a1^a2^gmul(a3,2);
    }
}

/*
 * aes256_encrypt_block — encrypt exactly one 16-byte block.
 *
 * This is the core AES-256 block cipher. It is only ever called in
 * forward (encrypt) direction because GCM-CTR mode uses encrypt for
 * both directions. We do not implement the inverse cipher.
 */
static void aes256_encrypt_block(
    const uint8_t in[16],
    uint8_t       out[16],
    const uint8_t rk[240])
{
    uint8_t s[16];
    memcpy(s, in, 16);
    add_round_key(s, rk);
    for (int r = 1; r < 14; r++) {
        sub_bytes(s);
        shift_rows(s);
        mix_columns(s);
        add_round_key(s, rk + r*16);
    }
    /* Final round — no MixColumns */
    sub_bytes(s);
    shift_rows(s);
    add_round_key(s, rk + 14*16);
    memcpy(out, s, 16);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 *  AES-256-CTR
 *
 *  Used as the stream cipher inside GCM. The counter occupies the last
 *  4 bytes of the 16-byte counter block in big-endian order.
 *  GCM convention: counter 0 = EKY0 (used for tag), counter 1 = first
 *  keystream block. We accept initial_counter so callers can set this.
 * ═══════════════════════════════════════════════════════════════════════════════ */

static void aes256_ctr_crypt(
    const uint8_t *key,
    const uint8_t  iv[SV_IV_SIZE],
    uint32_t       initial_counter,
    const uint8_t *in,
    uint8_t       *out,
    size_t         len)
{
    uint8_t rk[240];
    aes256_key_schedule(key, rk);

    uint8_t ctr_block[16];
    memcpy(ctr_block, iv, SV_IV_SIZE);

    uint32_t ctr = initial_counter;
    size_t   offset = 0;

    while (offset < len) {
        /* Big-endian counter in bytes 12–15 */
        ctr_block[12] = (ctr >> 24) & 0xff;
        ctr_block[13] = (ctr >> 16) & 0xff;
        ctr_block[14] = (ctr >>  8) & 0xff;
        ctr_block[15] =  ctr        & 0xff;

        uint8_t keystream[16];
        aes256_encrypt_block(ctr_block, keystream, rk);

        size_t block_len = (len - offset < 16) ? (len - offset) : 16;
        for (size_t i = 0; i < block_len; i++)
            out[offset+i] = in[offset+i] ^ keystream[i];

        offset += block_len;
        ctr++;
    }

    sv_zeroize(rk, 240);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 *  GHASH — GCM authentication over GF(2^128)
 *
 *  Standard GCM GHASH function. Processes:
 *    1. AAD (additional authenticated data) in 16-byte blocks
 *    2. Ciphertext in 16-byte blocks
 *    3. Length block: len(AAD) || len(CT) in bits, big-endian 64+64
 * ═══════════════════════════════════════════════════════════════════════════════ */

static void ghash_mul(uint8_t x[16], const uint8_t h[16]) {
    uint8_t z[16] = {0}, v[16];
    memcpy(v, h, 16);
    for (int i = 0; i < 128; i++) {
        if ((x[i/8] >> (7 - i%8)) & 1) {
            for (int j=0;j<16;j++) z[j] ^= v[j];
        }
        uint8_t lsb = v[15] & 1;
        for (int j=15; j>0; j--) v[j] = (v[j]>>1)|((v[j-1]&1)<<7);
        v[0] >>= 1;
        if (lsb) v[0] ^= 0xe1;   /* GCM reduction polynomial */
    }
    memcpy(x, z, 16);
}

static void ghash(
    const uint8_t *h,
    const uint8_t *aad, size_t aad_len,
    const uint8_t *ct,  size_t ct_len,
    uint8_t        out[16])
{
    uint8_t x[16] = {0};

    /* Process AAD padded to 16-byte blocks */
    for (size_t i = 0; i < aad_len; i += 16) {
        uint8_t block[16] = {0};
        size_t n = (aad_len - i < 16) ? (aad_len - i) : 16;
        memcpy(block, aad + i, n);
        for (int j=0;j<16;j++) x[j] ^= block[j];
        ghash_mul(x, h);
    }

    /* Process ciphertext padded to 16-byte blocks */
    for (size_t i = 0; i < ct_len; i += 16) {
        uint8_t block[16] = {0};
        size_t n = (ct_len - i < 16) ? (ct_len - i) : 16;
        memcpy(block, ct + i, n);
        for (int j=0;j<16;j++) x[j] ^= block[j];
        ghash_mul(x, h);
    }

    /* Length block: aad_len||ct_len in bits, big-endian */
    uint8_t lb[16] = {0};
    uint64_t aad_bits = (uint64_t)aad_len * 8;
    uint64_t ct_bits  = (uint64_t)ct_len  * 8;
    for (int i=7;i>=0;i--) { lb[i]   = aad_bits & 0xff; aad_bits >>= 8; }
    for (int i=7;i>=0;i--) { lb[8+i] = ct_bits  & 0xff; ct_bits  >>= 8; }
    for (int j=0;j<16;j++) x[j] ^= lb[j];
    ghash_mul(x, h);
    memcpy(out, x, 16);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 *  AES-256-GCM  Encrypt / Decrypt
 *
 *  GCM construction:
 *    H    = AES(key, 0^128)
 *    EKY0 = AES(key, IV || 0x00000001)          — tag mask
 *    CT   = AES-CTR(key, IV, counter=2, PT)     — counter starts at 2
 *    tag  = GHASH(H, AAD, CT) XOR EKY0
 * ═══════════════════════════════════════════════════════════════════════════════ */

/*
 * sv_encrypt — AES-256-GCM authenticated encryption
 *
 * Parameters:
 *   ctx      [in]  key (32B), iv (12B), aad + aad_len (may be NULL/0)
 *   plain    [in]  plaintext buffer
 *   plen     [in]  plaintext length in bytes
 *   cipher   [out] ciphertext output (caller must allocate >= plen bytes)
 *   tag      [out] 16-byte GCM authentication tag
 *
 * Returns: SV_OK or SV_ERR_NULLPTR
 */
int sv_encrypt(
    const crypto_context_t *ctx,
    const uint8_t *plain,  size_t plen,
          uint8_t *cipher,
          uint8_t *tag)
{
    if (!ctx || !ctx->key || !ctx->iv) return SV_ERR_NULLPTR;
    if (!cipher || !tag)               return SV_ERR_NULLPTR;
    if (plen > 0 && !plain)            return SV_ERR_NULLPTR;

    uint8_t rk[240];
    aes256_key_schedule(ctx->key, rk);

    /* H = AES(key, 0^128) */
    uint8_t zero16[16] = {0}, h[16];
    aes256_encrypt_block(zero16, h, rk);

    /* EKY0 = AES(key, IV || 0x00000001) */
    uint8_t ctr0[16] = {0};
    memcpy(ctr0, ctx->iv, SV_IV_SIZE);
    ctr0[15] = 0x01;
    uint8_t eky0[16];
    aes256_encrypt_block(ctr0, eky0, rk);

    sv_zeroize(rk, 240);

    /* Encrypt plaintext — CTR counter starts at 2 */
    aes256_ctr_crypt(ctx->key, ctx->iv, 2, plain, cipher, plen);

    /* Compute and mask the GHASH tag */
    uint8_t gh[16];
    const uint8_t *aad     = ctx->aad     ? ctx->aad     : (const uint8_t *)"";
    size_t         aad_len = ctx->aad_len;
    ghash(h, aad, aad_len, cipher, plen, gh);
    for (int i=0;i<16;i++) tag[i] = gh[i] ^ eky0[i];

    return SV_OK;
}

/*
 * sv_decrypt — AES-256-GCM authenticated decryption
 *
 * Verifies the authentication tag BEFORE decrypting — tag verification
 * failure returns SV_ERR_AUTH immediately without producing any plaintext.
 * The tag comparison is constant-time to resist timing side-channels.
 *
 * Parameters:
 *   ctx      [in]  key (32B), iv (12B), aad + aad_len (may be NULL/0)
 *   cipher   [in]  ciphertext buffer
 *   clen     [in]  ciphertext length in bytes
 *   tag      [in]  16-byte GCM authentication tag to verify
 *   plain    [out] plaintext output (caller must allocate >= clen bytes)
 *
 * Returns: SV_OK, SV_ERR_NULLPTR, or SV_ERR_AUTH
 */
int sv_decrypt(
    const crypto_context_t *ctx,
    const uint8_t *cipher, size_t clen,
    const uint8_t *tag,
          uint8_t *plain)
{
    if (!ctx || !ctx->key || !ctx->iv) return SV_ERR_NULLPTR;
    if (!tag || !plain)                return SV_ERR_NULLPTR;
    if (clen > 0 && !cipher)          return SV_ERR_NULLPTR;

    uint8_t rk[240];
    aes256_key_schedule(ctx->key, rk);

    /* H = AES(key, 0^128) */
    uint8_t zero16[16] = {0}, h[16];
    aes256_encrypt_block(zero16, h, rk);

    /* EKY0 = AES(key, IV || 0x00000001) */
    uint8_t ctr0[16] = {0};
    memcpy(ctr0, ctx->iv, SV_IV_SIZE);
    ctr0[15] = 0x01;
    uint8_t eky0[16];
    aes256_encrypt_block(ctr0, eky0, rk);

    sv_zeroize(rk, 240);

    /* Compute expected tag */
    uint8_t gh[16], computed_tag[16];
    const uint8_t *aad     = ctx->aad     ? ctx->aad     : (const uint8_t *)"";
    size_t         aad_len = ctx->aad_len;
    ghash(h, aad, aad_len, cipher, clen, gh);
    for (int i=0;i<16;i++) computed_tag[i] = gh[i] ^ eky0[i];

    /* Constant-time tag comparison — prevents timing oracle attacks */
    uint8_t diff = 0;
    for (int i=0;i<16;i++) diff |= (computed_tag[i] ^ tag[i]);
    if (diff != 0) return SV_ERR_AUTH;

    /* Tag verified — now decrypt */
    aes256_ctr_crypt(ctx->key, ctx->iv, 2, cipher, plain, clen);
    return SV_OK;
}
