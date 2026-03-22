/*
 * key_derivation.c
 * SecureVault — Key Derivation Module
 *
 * Implements:
 *   - SHA-256 (full NIST-compliant implementation)
 *   - HMAC-SHA256
 *   - PBKDF2-HMAC-SHA256  (master password → vault key)
 *   - HKDF-SHA256         (vault key + profile_id → domain-specific subkey)
 *
 * All functions are pure C, WASM-safe, no OS dependencies.
 *
 * Exported to JavaScript:
 *   _sv_derive_key  — PBKDF2: master password + salt → AES-256 key
 *   _sv_hkdf        — HKDF:   master key + context   → subkey
 *   _sv_hash        — SHA-256 of arbitrary data
 *   _sv_zeroize     — volatile memory wipe
 */

#include "crypto_types.h"
#include <string.h>
#include <stdlib.h>

/* ═══════════════════════════════════════════════════════════════════════════════
 *  SHA-256
 * ═══════════════════════════════════════════════════════════════════════════════ */

static const uint32_t SHA256_K[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,
    0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
    0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,
    0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,
    0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
    0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,
    0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,
    0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

#define ROTR32(x,n) (((x)>>(n))|((x)<<(32-(n))))
#define CH(x,y,z)   (((x)&(y))^(~(x)&(z)))
#define MAJ(x,y,z)  (((x)&(y))^((x)&(z))^((y)&(z)))
#define SIG0(x)     (ROTR32(x,2)^ROTR32(x,13)^ROTR32(x,22))
#define SIG1(x)     (ROTR32(x,6)^ROTR32(x,11)^ROTR32(x,25))
#define sig0(x)     (ROTR32(x,7)^ROTR32(x,18)^((x)>>3))
#define sig1(x)     (ROTR32(x,17)^ROTR32(x,19)^((x)>>10))

typedef struct {
    uint32_t state[8];
    uint8_t  buf[64];
    uint64_t bits;
} SHA256_CTX;

static void sha256_init(SHA256_CTX *ctx) {
    ctx->state[0] = 0x6a09e667; ctx->state[1] = 0xbb67ae85;
    ctx->state[2] = 0x3c6ef372; ctx->state[3] = 0xa54ff53a;
    ctx->state[4] = 0x510e527f; ctx->state[5] = 0x9b05688c;
    ctx->state[6] = 0x1f83d9ab; ctx->state[7] = 0x5be0cd19;
    ctx->bits = 0;
    memset(ctx->buf, 0, 64);
}

static void sha256_transform(SHA256_CTX *ctx, const uint8_t *block) {
    uint32_t w[64], a,b,c,d,e,f,g,h,t1,t2;
    for (int i = 0; i < 16; i++)
        w[i] = ((uint32_t)block[i*4]<<24)|((uint32_t)block[i*4+1]<<16)
              |((uint32_t)block[i*4+2]<<8)|(uint32_t)block[i*4+3];
    for (int i = 16; i < 64; i++)
        w[i] = sig1(w[i-2]) + w[i-7] + sig0(w[i-15]) + w[i-16];
    a=ctx->state[0]; b=ctx->state[1]; c=ctx->state[2]; d=ctx->state[3];
    e=ctx->state[4]; f=ctx->state[5]; g=ctx->state[6]; h=ctx->state[7];
    for (int i = 0; i < 64; i++) {
        t1 = h + SIG1(e) + CH(e,f,g) + SHA256_K[i] + w[i];
        t2 = SIG0(a) + MAJ(a,b,c);
        h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
    }
    ctx->state[0]+=a; ctx->state[1]+=b; ctx->state[2]+=c; ctx->state[3]+=d;
    ctx->state[4]+=e; ctx->state[5]+=f; ctx->state[6]+=g; ctx->state[7]+=h;
}

static void sha256_update(SHA256_CTX *ctx, const uint8_t *data, size_t len) {
    size_t idx = (ctx->bits / 8) % 64;
    ctx->bits += (uint64_t)len * 8;
    for (size_t i = 0; i < len; i++) {
        ctx->buf[idx++] = data[i];
        if (idx == 64) { sha256_transform(ctx, ctx->buf); idx = 0; }
    }
}

static void sha256_final(SHA256_CTX *ctx, uint8_t out[32]) {
    size_t idx = (ctx->bits / 8) % 64;
    ctx->buf[idx++] = 0x80;
    if (idx > 56) { memset(ctx->buf+idx,0,64-idx); sha256_transform(ctx,ctx->buf); idx=0; }
    memset(ctx->buf+idx, 0, 56-idx);
    uint64_t bits = ctx->bits;
    for (int i = 7; i >= 0; i--) { ctx->buf[56+i] = bits & 0xff; bits >>= 8; }
    sha256_transform(ctx, ctx->buf);
    for (int i = 0; i < 8; i++) {
        out[i*4]   = (ctx->state[i]>>24)&0xff;
        out[i*4+1] = (ctx->state[i]>>16)&0xff;
        out[i*4+2] = (ctx->state[i]>>8) &0xff;
        out[i*4+3] =  ctx->state[i]     &0xff;
    }
}

/* ═══════════════════════════════════════════════════════════════════════════════
 *  HMAC-SHA256
 * ═══════════════════════════════════════════════════════════════════════════════ */

void hmac_sha256(
    const uint8_t *key,  size_t key_len,
    const uint8_t *msg,  size_t msg_len,
    uint8_t        out[SV_HASH_SIZE])
{
    uint8_t k[64], ipad[64], opad[64], inner[SV_HASH_SIZE];
    memset(k, 0, 64);
    if (key_len > 64) {
        SHA256_CTX c; sha256_init(&c);
        sha256_update(&c, key, key_len);
        sha256_final(&c, k);
    } else {
        memcpy(k, key, key_len);
    }
    for (int i=0;i<64;i++) { ipad[i]=k[i]^0x36; opad[i]=k[i]^0x5c; }
    SHA256_CTX c;
    sha256_init(&c); sha256_update(&c,ipad,64); sha256_update(&c,msg,msg_len);  sha256_final(&c,inner);
    sha256_init(&c); sha256_update(&c,opad,64); sha256_update(&c,inner,SV_HASH_SIZE); sha256_final(&c,out);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 *  PBKDF2-HMAC-SHA256
 *
 *  Derives a key of arbitrary length from a master password and salt.
 *  Used by sv_derive_key() to turn the user's master password into an
 *  AES-256 key for the vault.
 * ═══════════════════════════════════════════════════════════════════════════════ */

static void pbkdf2_hmac_sha256(
    const uint8_t *pass,  size_t pass_len,
    const uint8_t *salt,  size_t salt_len,
    uint32_t       iter,
    uint8_t       *out,   size_t out_len)
{
    uint32_t block_num = 1;
    while (out_len > 0) {
        /* U1 = HMAC(pass, salt || INT(block_num)) */
        uint8_t *tmp = (uint8_t *)malloc(salt_len + 4);
        if (!tmp) return;
        memcpy(tmp, salt, salt_len);
        tmp[salt_len]   = (block_num >> 24) & 0xff;
        tmp[salt_len+1] = (block_num >> 16) & 0xff;
        tmp[salt_len+2] = (block_num >>  8) & 0xff;
        tmp[salt_len+3] =  block_num        & 0xff;

        uint8_t u[SV_HASH_SIZE], f[SV_HASH_SIZE];
        hmac_sha256(pass, pass_len, tmp, salt_len+4, u);
        free(tmp);
        memcpy(f, u, SV_HASH_SIZE);

        for (uint32_t j = 1; j < iter; j++) {
            uint8_t u2[SV_HASH_SIZE];
            hmac_sha256(pass, pass_len, u, SV_HASH_SIZE, u2);
            for (int k = 0; k < SV_HASH_SIZE; k++) f[k] ^= u2[k];
            memcpy(u, u2, SV_HASH_SIZE);
        }

        size_t copy = out_len < SV_HASH_SIZE ? out_len : SV_HASH_SIZE;
        memcpy(out, f, copy);
        out     += copy;
        out_len -= copy;
        block_num++;
    }
}

/* ═══════════════════════════════════════════════════════════════════════════════
 *  HKDF-SHA256
 *
 *  RFC 5869 — two-step: Extract then Expand.
 *  Used to derive a unique per-profile subkey from the master vault key
 *  and a context string (e.g. the profile_id / domain name).
 *
 *  This means:
 *    master_key + "ecampus.psgtech.ac.in" → unique subkey for that domain
 *    master_key + "github.com"            → different subkey
 *  Both are derived from the same master, but neither leaks the other.
 * ═══════════════════════════════════════════════════════════════════════════════ */

static void hkdf_extract(
    const uint8_t *salt,     size_t salt_len,
    const uint8_t *ikm,      size_t ikm_len,
    uint8_t        prk[SV_HASH_SIZE])
{
    /* If no salt provided, use a string of zeroes (RFC 5869 §2.2) */
    uint8_t zero_salt[SV_HASH_SIZE];
    if (!salt || salt_len == 0) {
        memset(zero_salt, 0, SV_HASH_SIZE);
        salt     = zero_salt;
        salt_len = SV_HASH_SIZE;
    }
    hmac_sha256(salt, salt_len, ikm, ikm_len, prk);
}

static void hkdf_expand(
    const uint8_t *prk,    size_t prk_len,
    const uint8_t *info,   size_t info_len,
    uint8_t       *okm,    size_t okm_len)
{
    uint8_t t[SV_HASH_SIZE];
    uint8_t *prev = NULL;
    size_t   prev_len = 0;
    uint8_t  counter  = 1;
    size_t   offset   = 0;

    while (offset < okm_len) {
        /* T(i) = HMAC(PRK, T(i-1) || info || counter) */
        size_t   in_len = prev_len + info_len + 1;
        uint8_t *in     = (uint8_t *)malloc(in_len);
        if (!in) return;

        if (prev) memcpy(in, prev, prev_len);
        memcpy(in + prev_len, info, info_len);
        in[prev_len + info_len] = counter++;

        hmac_sha256(prk, prk_len, in, in_len, t);
        free(in);

        size_t copy = (okm_len - offset < SV_HASH_SIZE) ? (okm_len - offset) : SV_HASH_SIZE;
        memcpy(okm + offset, t, copy);
        offset   += copy;
        prev      = t;
        prev_len  = SV_HASH_SIZE;
    }
}

/* ═══════════════════════════════════════════════════════════════════════════════
 *  Exported API
 * ═══════════════════════════════════════════════════════════════════════════════ */

/*
 * sv_derive_key — PBKDF2-HMAC-SHA256
 *
 * Derives the 256-bit AES vault key from the user's master password.
 * The salt must be SV_SALT_SIZE (32) bytes of cryptographically random data,
 * stored alongside the vault blob in chrome.storage.local.
 *
 * Parameters:
 *   pass      [in]  master password bytes (UTF-8)
 *   pass_len  [in]  byte length of pass
 *   salt      [in]  SV_SALT_SIZE random bytes
 *   out_key   [out] SV_KEY_SIZE  bytes — the derived AES-256 key
 *
 * Returns: SV_OK, SV_ERR_NULLPTR
 */
int sv_derive_key(
    const uint8_t *pass, size_t pass_len,
    const uint8_t *salt,
          uint8_t *out_key)
{
    if (!pass || !salt || !out_key) return SV_ERR_NULLPTR;
    pbkdf2_hmac_sha256(
        pass, pass_len,
        salt, SV_SALT_SIZE,
        PBKDF2_ITERATIONS,
        out_key, SV_KEY_SIZE
    );
    return SV_OK;
}

/*
 * sv_hkdf — HKDF-SHA256 subkey derivation
 *
 * Derives a domain-specific subkey from the master vault key.
 * Each vault profile gets a unique key; compromising one subkey
 * does not expose the master or other profiles.
 *
 * Parameters:
 *   master_key  [in]  SV_KEY_SIZE bytes — the master vault key
 *   context     [in]  arbitrary context bytes (e.g. profile_id or domain)
 *   context_len [in]  byte length of context
 *   out_key     [out] SV_KEY_SIZE bytes — the derived subkey
 *
 * Returns: SV_OK, SV_ERR_NULLPTR
 */
int sv_hkdf(
    const uint8_t *master_key,
    const uint8_t *context,  size_t context_len,
          uint8_t *out_key)
{
    if (!master_key || !context || !out_key) return SV_ERR_NULLPTR;

    uint8_t prk[SV_HASH_SIZE];
    /* Extract: PRK = HMAC-SHA256(master_key, master_key) */
    hkdf_extract(master_key, SV_KEY_SIZE, master_key, SV_KEY_SIZE, prk);
    /* Expand:  OKM = HKDF-Expand(PRK, context, SV_KEY_SIZE) */
    hkdf_expand(prk, SV_HASH_SIZE, context, context_len, out_key, SV_KEY_SIZE);
    return SV_OK;
}

/*
 * sv_hash — SHA-256 of arbitrary data
 *
 * Parameters:
 *   data  [in]  input buffer
 *   len   [in]  length in bytes
 *   out   [out] SV_HASH_SIZE (32) byte digest
 *
 * Returns: SV_OK, SV_ERR_NULLPTR
 */
int sv_hash(const uint8_t *data, size_t len, uint8_t out[SV_HASH_SIZE]) {
    if (!data || !out) return SV_ERR_NULLPTR;
    SHA256_CTX ctx;
    sha256_init(&ctx);
    sha256_update(&ctx, data, len);
    sha256_final(&ctx, out);
    return SV_OK;
}

/*
 * sv_zeroize — securely wipe a memory region
 *
 * Volatile write prevents the compiler from optimising this away,
 * which it is legally permitted to do with a plain memset.
 */
void sv_zeroize(uint8_t *buf, size_t len) {
    if (!buf) return;
    volatile uint8_t *p = buf;
    while (len--) *p++ = 0;
}
