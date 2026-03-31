/*
 * test_crypto.c
 * CredLock — Unit Tests for crypto_engine.c + key_derivation.c
 *
 * Build and run (no Emscripten needed):
 *   make test-c
 */

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <stdlib.h>
#include "src/wasm/crypto_types.h"

extern int  sv_derive_key(const uint8_t *pass, size_t pass_len,
                          const uint8_t *salt, uint8_t *out_key);
extern int  sv_hkdf(const uint8_t *master_key,
                    const uint8_t *context, size_t context_len,
                    uint8_t *out_key);
extern int  sv_hash(const uint8_t *data, size_t len, uint8_t out[32]);
extern void sv_zeroize(uint8_t *buf, size_t len);
extern int  sv_encrypt(const crypto_context_t *ctx,
                       const uint8_t *plain,  size_t plen,
                             uint8_t *cipher, uint8_t *tag);
extern int  sv_decrypt(const crypto_context_t *ctx,
                       const uint8_t *cipher, size_t clen,
                       const uint8_t *tag,    uint8_t *plain);

static int passed = 0, failed = 0;
#define PASS(name) do { printf("  PASS  %s\n", name); passed++; } while(0)
#define FAIL(name, ...) do { printf("  FAIL  %s — ", name); printf(__VA_ARGS__); printf("\n"); failed++; } while(0)
#define ASSERT(name, cond) do { if(cond) PASS(name); else FAIL(name, "condition false"); } while(0)

static void test_sha256(void) {
    printf("\n[SHA-256]\n");
    uint8_t out[32];
    const uint8_t expected_abc[32] = {
        0xba,0x78,0x16,0xbf,0x8f,0x01,0xcf,0xea,0x41,0x41,0x40,0xde,0x5d,0xae,0x22,0x23,
        0xb0,0x03,0x61,0xa3,0x96,0x17,0x7a,0x9c,0xb4,0x10,0xff,0x61,0xf2,0x00,0x15,0xad
    };
    sv_hash((const uint8_t *)"abc", 3, out);
    if (memcmp(out, expected_abc, 32) == 0) PASS("SHA-256(\"abc\") NIST vector");
    else FAIL("SHA-256(\"abc\") NIST vector", "digest mismatch");

    const uint8_t expected_empty[32] = {
        0xe3,0xb0,0xc4,0x42,0x98,0xfc,0x1c,0x14,0x9a,0xfb,0xf4,0xc8,0x99,0x6f,0xb9,0x24,
        0x27,0xae,0x41,0xe4,0x64,0x9b,0x93,0x4c,0xa4,0x95,0x99,0x1b,0x78,0x52,0xb8,0x55
    };
    sv_hash((const uint8_t *)"", 0, out);
    if (memcmp(out, expected_empty, 32) == 0) PASS("SHA-256(\"\") NIST vector");
    else FAIL("SHA-256(\"\") NIST vector", "digest mismatch");

    ASSERT("sv_hash NULL data", sv_hash(NULL, 0, out) == SV_ERR_NULLPTR);
    ASSERT("sv_hash NULL out",  sv_hash((const uint8_t *)"x", 1, NULL) == SV_ERR_NULLPTR);
}

static void test_pbkdf2(void) {
    printf("\n[PBKDF2-HMAC-SHA256]\n");
    uint8_t key[SV_KEY_SIZE], key2[SV_KEY_SIZE], key3[SV_KEY_SIZE];
    uint8_t salt[SV_SALT_SIZE], salt2[SV_SALT_SIZE];
    memset(salt, 0x42, SV_SALT_SIZE);
    memset(salt2, 0x99, SV_SALT_SIZE);
    sv_derive_key((const uint8_t *)"hunter2", 7, salt, key);
    sv_derive_key((const uint8_t *)"hunter2", 7, salt, key2);
    ASSERT("PBKDF2 deterministic", memcmp(key, key2, SV_KEY_SIZE) == 0);
    sv_derive_key((const uint8_t *)"hunter3", 7, salt, key3);
    ASSERT("PBKDF2 different passwords differ", memcmp(key, key3, SV_KEY_SIZE) != 0);
    sv_derive_key((const uint8_t *)"hunter2", 7, salt2, key3);
    ASSERT("PBKDF2 different salts differ", memcmp(key, key3, SV_KEY_SIZE) != 0);
    ASSERT("sv_derive_key NULL pass", sv_derive_key(NULL, 7, salt, key) == SV_ERR_NULLPTR);
    ASSERT("sv_derive_key NULL salt", sv_derive_key((const uint8_t *)"p", 1, NULL, key) == SV_ERR_NULLPTR);
    ASSERT("sv_derive_key NULL out",  sv_derive_key((const uint8_t *)"p", 1, salt, NULL) == SV_ERR_NULLPTR);
}

static void test_hkdf(void) {
    printf("\n[HKDF-SHA256]\n");
    uint8_t master[SV_KEY_SIZE]; memset(master, 0xAB, SV_KEY_SIZE);
    uint8_t k1[SV_KEY_SIZE], k2[SV_KEY_SIZE], k3[SV_KEY_SIZE];
    sv_hkdf(master, (const uint8_t *)"ecampus.psgtech.ac.in", 21, k1);
    sv_hkdf(master, (const uint8_t *)"github.com", 10, k2);
    sv_hkdf(master, (const uint8_t *)"ecampus.psgtech.ac.in", 21, k3);
    ASSERT("HKDF different contexts differ", memcmp(k1, k2, SV_KEY_SIZE) != 0);
    ASSERT("HKDF same context deterministic", memcmp(k1, k3, SV_KEY_SIZE) == 0);
    ASSERT("HKDF subkey != master", memcmp(k1, master, SV_KEY_SIZE) != 0);
    ASSERT("sv_hkdf NULL master",  sv_hkdf(NULL, (const uint8_t *)"ctx", 3, k1) == SV_ERR_NULLPTR);
    ASSERT("sv_hkdf NULL context", sv_hkdf(master, NULL, 0, k1) == SV_ERR_NULLPTR);
    ASSERT("sv_hkdf NULL out",     sv_hkdf(master, (const uint8_t *)"ctx", 3, NULL) == SV_ERR_NULLPTR);
}

static void test_gcm(void) {
    printf("\n[AES-256-GCM]\n");
    uint8_t key[SV_KEY_SIZE]; memset(key, 0x00, SV_KEY_SIZE);
    uint8_t iv[SV_IV_SIZE];   memset(iv,  0x00, SV_IV_SIZE);
    const char *plaintext = "CredLock test payload";
    size_t plen = strlen(plaintext);
    uint8_t cipher[64]={0}, tag[SV_TAG_SIZE], decrypted[64]={0};
    crypto_context_t ctx = { key, iv, NULL, 0 };

    ASSERT("sv_encrypt OK", sv_encrypt(&ctx, (const uint8_t *)plaintext, plen, cipher, tag) == SV_OK);
    ASSERT("sv_decrypt OK", sv_decrypt(&ctx, cipher, plen, tag, decrypted) == SV_OK);
    ASSERT("Round-trip matches", memcmp(decrypted, plaintext, plen) == 0);

    uint8_t tampered[64]; memcpy(tampered, cipher, plen); tampered[0] ^= 0xff;
    ASSERT("Tampered ciphertext -> AUTH err", sv_decrypt(&ctx, tampered, plen, tag, decrypted) == SV_ERR_AUTH);

    uint8_t bad_tag[SV_TAG_SIZE]; memcpy(bad_tag, tag, SV_TAG_SIZE); bad_tag[7] ^= 0x01;
    ASSERT("Tampered tag -> AUTH err", sv_decrypt(&ctx, cipher, plen, bad_tag, decrypted) == SV_ERR_AUTH);

    const char *domain = "ecampus.psgtech.ac.in";
    crypto_context_t ctx_aad = { key, iv, (const uint8_t *)domain, strlen(domain) };
    uint8_t ca[64]={0}, ta[SV_TAG_SIZE], da[64]={0};
    sv_encrypt(&ctx_aad, (const uint8_t *)plaintext, plen, ca, ta);
    ASSERT("GCM AAD round-trip OK", sv_decrypt(&ctx_aad, ca, plen, ta, da) == SV_OK);
    ASSERT("GCM AAD plaintext matches", memcmp(da, plaintext, plen) == 0);

    crypto_context_t ctx_waad = { key, iv, (const uint8_t *)"github.com", 10 };
    ASSERT("Wrong AAD -> AUTH err", sv_decrypt(&ctx_waad, ca, plen, ta, da) == SV_ERR_AUTH);

    uint8_t key2[SV_KEY_SIZE]; memset(key2, 0xFF, SV_KEY_SIZE);
    crypto_context_t ctx2 = { key2, iv, NULL, 0 };
    uint8_t c2[64]={0}, t2[SV_TAG_SIZE];
    sv_encrypt(&ctx2, (const uint8_t *)plaintext, plen, c2, t2);
    ASSERT("Different keys -> different ciphertexts", memcmp(cipher, c2, plen) != 0);

    ASSERT("sv_encrypt NULL ctx", sv_encrypt(NULL, (const uint8_t *)"x", 1, cipher, tag) == SV_ERR_NULLPTR);
    ASSERT("sv_decrypt NULL ctx", sv_decrypt(NULL, cipher, plen, tag, decrypted) == SV_ERR_NULLPTR);
}

static void test_zeroize(void) {
    printf("\n[sv_zeroize]\n");
    uint8_t buf[32]; memset(buf, 0xAA, 32);
    sv_zeroize(buf, 32);
    uint8_t ok = 1;
    for (int i=0;i<32;i++) if (buf[i]) { ok=0; break; }
    ASSERT("sv_zeroize clears buffer", ok);
    sv_zeroize(NULL, 32);
    PASS("sv_zeroize NULL no-op");
}

static void test_vault_workflow(void) {
    printf("\n[Full vault workflow: derive -> hkdf -> encrypt -> decrypt]\n");
    const char *master_pw = "MyMasterPassword123!";
    uint8_t salt[SV_SALT_SIZE]; memset(salt, 0x7F, SV_SALT_SIZE);
    const char *domain = "ecampus.psgtech.ac.in";
    const char *credential = "s3cr3t_password";
    size_t clen = strlen(credential);

    uint8_t master_key[SV_KEY_SIZE];
    ASSERT("Vault: derive master key",
        sv_derive_key((const uint8_t *)master_pw, strlen(master_pw), salt, master_key) == SV_OK);

    uint8_t subkey[SV_KEY_SIZE];
    ASSERT("Vault: HKDF subkey",
        sv_hkdf(master_key, (const uint8_t *)domain, strlen(domain), subkey) == SV_OK);
    ASSERT("Vault: subkey != master", memcmp(subkey, master_key, SV_KEY_SIZE) != 0);

    uint8_t iv[SV_IV_SIZE]; memset(iv, 0x11, SV_IV_SIZE);
    uint8_t cipher[64]={0}, tag[SV_TAG_SIZE], decrypted[64]={0};
    crypto_context_t ctx = { subkey, iv, (const uint8_t *)domain, strlen(domain) };

    ASSERT("Vault: encrypt credential",
        sv_encrypt(&ctx, (const uint8_t *)credential, clen, cipher, tag) == SV_OK);
    ASSERT("Vault: decrypt credential",
        sv_decrypt(&ctx, cipher, clen, tag, decrypted) == SV_OK);
    ASSERT("Vault: decrypted matches original", memcmp(decrypted, credential, clen) == 0);

    uint8_t subkey2[SV_KEY_SIZE];
    sv_hkdf(master_key, (const uint8_t *)"github.com", 10, subkey2);
    crypto_context_t ctx_wrong = { subkey2, iv, (const uint8_t *)domain, strlen(domain) };
    ASSERT("Vault: wrong domain subkey cannot decrypt",
        sv_decrypt(&ctx_wrong, cipher, clen, tag, decrypted) == SV_ERR_AUTH);

    sv_zeroize(master_key, SV_KEY_SIZE);
    sv_zeroize(subkey,     SV_KEY_SIZE);
    sv_zeroize(subkey2,    SV_KEY_SIZE);
}

int main(void) {
    printf("CredLock Crypto Tests\n");
    printf("============================================\n");
    test_sha256();
    test_pbkdf2();
    test_hkdf();
    test_gcm();
    test_zeroize();
    test_vault_workflow();
    printf("\n============================================\n");
    printf("Results: %d passed, %d failed\n", passed, failed);
    return failed > 0 ? 1 : 0;
}
