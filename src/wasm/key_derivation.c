/*
 * key_derivation.c
 * SecureVault WASM — Key Derivation Module
 *
 * Implements:
 *   sv_pbkdf2 — PBKDF2-SHA256 (passphrase / token → vault key)
 *   sv_hkdf   — HKDF-SHA256   (master key + profileId → per-profile key)
 *
 * The autofill feature uses sv_hkdf to derive a unique AES-GCM key for
 * each vault profile while keeping all keys tied to a single master key.
 *
 * References: RFC 2898 (PBKDF2), RFC 5869 (HKDF)
 *
 * NOTE: This is a reference implementation for learning purposes.
 * For production, replace with libsodium or mbedTLS constant-time variants.
 */

#include <stdint.h>
#include <string.h>
#include "crypto_types.h"

/* ════════════════════════════════════════════════════════════════════════════
 * SHA-256 (RFC 6234)
 * ════════════════════════════════════════════════════════════════════════════ */

#define SHA256_BLOCK_BYTES  64
#define SHA256_DIGEST_BYTES 32

static const uint32_t SHA256_K[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,
    0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
    0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,
    0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,
    0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
    0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,
    0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c085,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,
    0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

#define ROTR32(x,n) (((x)>>(n))|((x)<<(32-(n))))
#define S0(x) (ROTR32(x,2)  ^ ROTR32(x,13) ^ ROTR32(x,22))
#define S1(x) (ROTR32(x,6)  ^ ROTR32(x,11) ^ ROTR32(x,25))
#define G0(x) (ROTR32(x,7)  ^ ROTR32(x,18) ^ ((x)>>3))
#define G1(x) (ROTR32(x,17) ^ ROTR32(x,19) ^ ((x)>>10))
#define CH(x,y,z)  (((x)&(y))^(~(x)&(z)))
#define MAJ(x,y,z) (((x)&(y))^((x)&(z))^((y)&(z)))

typedef struct {
    uint8_t  data[SHA256_BLOCK_BYTES];
    uint32_t datalen;
    uint64_t bitlen;
    uint32_t state[8];
} sha256_ctx_t;

static void sha256_init(sha256_ctx_t *ctx) {
    ctx->datalen = 0; ctx->bitlen = 0;
    ctx->state[0]=0x6a09e667; ctx->state[1]=0xbb67ae85;
    ctx->state[2]=0x3c6ef372; ctx->state[3]=0xa54ff53a;
    ctx->state[4]=0x510e527f; ctx->state[5]=0x9b05688c;
    ctx->state[6]=0x1f83d9ab; ctx->state[7]=0x5be0cd19;
}

static void sha256_transform(sha256_ctx_t *ctx, const uint8_t *d) {
    uint32_t a,b,c,e,f,g,h,t1,t2,m[64]; uint32_t i,j;
    for (i=0,j=0;i<16;i++,j+=4)
        m[i]=((uint32_t)d[j]<<24)|((uint32_t)d[j+1]<<16)|((uint32_t)d[j+2]<<8)|d[j+3];
    for (;i<64;i++) m[i]=G1(m[i-2])+m[i-7]+G0(m[i-15])+m[i-16];
    a=ctx->state[0];b=ctx->state[1];c=ctx->state[2];uint32_t dd=ctx->state[3];
    e=ctx->state[4];f=ctx->state[5];g=ctx->state[6];h=ctx->state[7];
    for (i=0;i<64;i++){
        t1=h+S1(e)+CH(e,f,g)+SHA256_K[i]+m[i];
        t2=S0(a)+MAJ(a,b,c);
        h=g;g=f;f=e;e=dd+t1;dd=c;c=b;b=a;a=t1+t2;
    }
    ctx->state[0]+=a;ctx->state[1]+=b;ctx->state[2]+=c;ctx->state[3]+=dd;
    ctx->state[4]+=e;ctx->state[5]+=f;ctx->state[6]+=g;ctx->state[7]+=h;
}

static void sha256_update(sha256_ctx_t *ctx, const uint8_t *data, uint32_t len) {
    for (uint32_t i=0;i<len;i++){
        ctx->data[ctx->datalen++]=data[i];
        if(ctx->datalen==SHA256_BLOCK_BYTES){
            sha256_transform(ctx,ctx->data);
            ctx->bitlen+=512; ctx->datalen=0;
        }
    }
}

static void sha256_final(sha256_ctx_t *ctx, uint8_t *hash) {
    uint32_t i=ctx->datalen;
    ctx->data[i++]=0x80;
    if(ctx->datalen<56){while(i<56)ctx->data[i++]=0;}
    else{while(i<64)ctx->data[i++]=0;sha256_transform(ctx,ctx->data);memset(ctx->data,0,56);}
    ctx->bitlen+=ctx->datalen*8;
    uint64_t bl=ctx->bitlen;
    for(int k=7;k>=0;k--){ctx->data[56+k]=(uint8_t)(bl&0xff);bl>>=8;}
    sha256_transform(ctx,ctx->data);
    for(i=0;i<4;i++)
        for(int j=0;j<8;j++) hash[i+j*4]=(ctx->state[j]>>(24-i*8))&0xff;
}

/* ════════════════════════════════════════════════════════════════════════════
 * HMAC-SHA256
 * ════════════════════════════════════════════════════════════════════════════ */

static void hmac_sha256(
    const uint8_t *key, uint32_t key_len,
    const uint8_t *msg, uint32_t msg_len,
    uint8_t *out /* SHA256_DIGEST_BYTES */
) {
    uint8_t k0[SHA256_BLOCK_BYTES];
    uint8_t inner[SHA256_DIGEST_BYTES];
    sha256_ctx_t ctx;

    memset(k0, 0, SHA256_BLOCK_BYTES);
    if (key_len > SHA256_BLOCK_BYTES) {
        sha256_init(&ctx); sha256_update(&ctx,key,key_len); sha256_final(&ctx,k0);
    } else {
        memcpy(k0, key, key_len);
    }

    uint8_t ipad[SHA256_BLOCK_BYTES], opad[SHA256_BLOCK_BYTES];
    for(int i=0;i<SHA256_BLOCK_BYTES;i++){ipad[i]=k0[i]^0x36;opad[i]=k0[i]^0x5c;}

    sha256_init(&ctx);
    sha256_update(&ctx,ipad,SHA256_BLOCK_BYTES);
    sha256_update(&ctx,msg,msg_len);
    sha256_final(&ctx,inner);

    sha256_init(&ctx);
    sha256_update(&ctx,opad,SHA256_BLOCK_BYTES);
    sha256_update(&ctx,inner,SHA256_DIGEST_BYTES);
    sha256_final(&ctx,out);
}

/* ════════════════════════════════════════════════════════════════════════════
 * PBKDF2-SHA256 (RFC 2898 §5.2)
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * sv_pbkdf2
 * Derives a vault key from an auth token/passphrase.
 * Used by wasm_crypto_bindings.js pbkdf2() method.
 *
 * @param pass      passphrase bytes
 * @param pass_len  passphrase length
 * @param salt      random salt bytes (32 bytes recommended)
 * @param salt_len  salt length
 * @param iterations PBKDF2 iteration count (≥ SV_PBKDF2_MIN_ITER)
 * @param out_key   output buffer, SV_PBKDF2_DK_BYTES bytes
 */
void sv_pbkdf2(
    const uint8_t *pass, uint32_t pass_len,
    const uint8_t *salt, uint32_t salt_len,
    uint32_t iterations,
    uint8_t  *out_key
) {
    /* Single block (dk_len = 32 = SHA256_DIGEST_BYTES, block index = 1) */
    uint8_t salt_block[256];
    if (salt_len > 252) salt_len = 252;
    memcpy(salt_block, salt, salt_len);
    /* Append big-endian block counter = 1 */
    salt_block[salt_len+0] = 0;
    salt_block[salt_len+1] = 0;
    salt_block[salt_len+2] = 0;
    salt_block[salt_len+3] = 1;

    uint8_t U[SHA256_DIGEST_BYTES], T[SHA256_DIGEST_BYTES];
    hmac_sha256(pass, pass_len, salt_block, salt_len+4, U);
    memcpy(T, U, SHA256_DIGEST_BYTES);

    for (uint32_t c=1; c<iterations; c++) {
        hmac_sha256(pass, pass_len, U, SHA256_DIGEST_BYTES, U);
        for (int i=0; i<SHA256_DIGEST_BYTES; i++) T[i] ^= U[i];
    }

    memcpy(out_key, T, SHA256_DIGEST_BYTES);
}

/* ════════════════════════════════════════════════════════════════════════════
 * HKDF-SHA256 (RFC 5869)
 * Derives a per-profile sub-key from a master key + profileId context.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * sv_hkdf
 * Derives a profile-specific 256-bit key from the vault master key.
 *
 * The `info` parameter should be the UTF-8 bytes of the profileId string.
 * This ensures each profile gets a cryptographically independent key while
 * all keys remain tied to the same master key.
 *
 * @param ikm       input key material (master key, SV_AES_KEY_BYTES)
 * @param info      context bytes, typically profileId UTF-8 string
 * @param info_len  length of info
 * @param salt      optional salt (pass NULL for zero salt)
 * @param salt_len  length of salt (0 if salt is NULL)
 * @param okm       output key material buffer (SV_HKDF_OKM_BYTES bytes)
 */
void sv_hkdf(
    const uint8_t *ikm,
    const uint8_t *info,  uint32_t info_len,
    const uint8_t *salt,  uint32_t salt_len,
    uint8_t       *okm
) {
    /* ── Extract phase: PRK = HMAC-SHA256(salt, IKM) ── */
    uint8_t zero_salt[SHA256_DIGEST_BYTES];
    const uint8_t *actual_salt;
    uint32_t actual_salt_len;

    if (salt == NULL || salt_len == 0) {
        memset(zero_salt, 0, SHA256_DIGEST_BYTES);
        actual_salt     = zero_salt;
        actual_salt_len = SHA256_DIGEST_BYTES;
    } else {
        actual_salt     = salt;
        actual_salt_len = salt_len;
    }

    uint8_t prk[SHA256_DIGEST_BYTES];
    hmac_sha256(actual_salt, actual_salt_len, ikm, SV_AES_KEY_BYTES, prk);

    /* ── Expand phase: T(1) = HMAC-SHA256(PRK, info || 0x01) ── */
    /* We need exactly 32 bytes (one HMAC block is sufficient).  */
    uint8_t expand_input[512];
    uint32_t expand_len = 0;

    if (info && info_len > 0) {
        uint32_t copy_len = info_len < 490 ? info_len : 490;
        memcpy(expand_input, info, copy_len);
        expand_len += copy_len;
    }
    expand_input[expand_len++] = 0x01; /* block counter */

    hmac_sha256(prk, SHA256_DIGEST_BYTES, expand_input, expand_len, okm);
}