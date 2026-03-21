# Security Limitations & Threat Model

## Threat Model

### Assets to Protect

| Asset | Sensitivity | Where it lives |
|-------|-------------|----------------|
| Raw PAN (Primary Account Number) | Critical | JS heap, milliseconds only |
| CVV / CVC | Critical | JS heap, milliseconds only |
| Expiry date | High | JS heap transiently; masked in storage |
| Cardholder name | Medium | Stored unencrypted (safe to store) |
| Session key (AES-GCM-256) | Critical | `CryptoKey { extractable: false }` in heap |
| PBKDF2 salt | Low | `chrome.storage.local` — public, per-device |
| WebAuthn credential ID | Low | `chrome.storage.local` — identifies device |
| Encrypted card blobs | Medium | `chrome.storage.local` — ciphertext only |

### Trust Boundaries

| Zone | Trust Level | Notes |
|------|-------------|-------|
| Chrome Extension process | High | Separate renderer from merchant page |
| Closed Shadow DOM | High | `mode: 'closed'` — no external JS reference |
| Background service worker | High | No shared memory with content scripts |
| Merchant DOM | Untrusted | May contain malicious scripts |
| `chrome.storage.local` | Medium | Encrypted blobs only; accessible to extension |
| WASM linear memory | Medium | Isolated from JS heap; not OS-level encrypted |
| OS kernel / Chrome process | Out-of-scope | Assumed non-compromised |

---

## Known Limitations

### 1. JavaScript Memory Is Not Physically Encrypted
JavaScript provides no true memory encryption. A compromised Chrome process,
a kernel-level attacker, or a cold-boot attack could read heap contents.
Raw card data (`pan`, `cvv`) exists in the JS heap for the duration of
`CardRecord.fromRaw()` and `getMaskedTokensForAutofill()` — both complete
within milliseconds.

**Mitigation:** Raw values are overwritten after use (e.g. `raw.pan = '000...'`).
This is best-effort in V8 — the JIT compiler may keep copies in registers or
optimise away the overwrite. The session key is `extractable: false`, which
prevents extraction via the WebCrypto API but not via process memory inspection.

---

### 2. WASM Crypto Engine Is a Reference Implementation
`crypto_engine.c` contains a reference AES-GCM **stub** (the encrypt/decrypt
functions copy bytes without actually encrypting) and a PBKDF2-SHA256
implementation. The AES stub delegates to the WebCrypto API at the JS layer.
The PBKDF2 implementation is not constant-time (it processes iterations with
a standard loop and HMAC that may be vulnerable to timing side-channels on
shared hardware).

**Mitigation for production:** Replace with `libsodium-wasm` or `mbedTLS`,
compiled with `-O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2`. Use
`crypto_secretbox_xsalsa20poly1305` (libsodium) or `mbedtls_aes_crypt_gcm`
(mbedTLS) for the AES-GCM implementation, and `crypto_pwhash` for key derivation.

---

### 3. Biometric Token Is Not Stable Across Sessions
`auth_biometric_stub.js` derives the key-derivation token from a SHA-256 hash
of `authenticatorData`. This field includes a **signature counter** that
increments on every assertion. This means:

- Two unlocks via biometrics will produce **different tokens** → **different session keys**
- A card saved during one biometric unlock **cannot be decrypted** on the next biometric unlock
- The biometric and Google Identity paths produce incompatible keys, so cards saved
  via one path are unreadable via the other

**Mitigation for production:** Use only the stable fields of `authenticatorData`
(the `rpIdHash` + `flags`, excluding the counter) when computing the token, or
store a separately-encrypted master key per auth method:
- Wrap the master key with the Google-derived key (stored in `chrome.storage.local`)
- Wrap the same master key with the biometric-derived key (stored separately)
- On unlock, unwrap via whichever method was used
This is equivalent to how LUKS stores multiple key slots for the same volume.

---

### 4. Auth Token as the Sole Key Derivation Input
The session key is derived exclusively from the Google OAuth token (a short,
opaque string). If the OAuth token is intercepted — for example by a malicious
Chrome extension with the `identity` permission — an attacker could derive the
same session key and decrypt the stored card blobs.

**Mitigation:** Combine the auth token with a user-supplied PIN:
`PBKDF2(token + ":" + pin, salt, 200000)`. The PIN never leaves the device and
is not stored anywhere. This raises the attack requirement to token + PIN knowledge.

---

### 5. PBKDF2 Salt Is Stored Unencrypted
The PBKDF2 salt (`sv_pbkdf2_salt`) is stored in `chrome.storage.local` as
base64-encoded plaintext. The salt is intended to be public (it prevents
pre-computation attacks, not online attacks), so this is by design. However,
if the salt is exfiltrated along with the encrypted blobs, an attacker can
mount a targeted PBKDF2 brute-force with 200,000 iterations per guess.

**Mitigation:** The 200,000-iteration count significantly raises the cost of
brute-force. For high-security deployments, consider storing the salt in a
hardware-backed store (e.g. Chrome OS TPM-backed `chrome.storage.session`) or
deriving part of the salt from a hardware secret.

---

### 6. Extension Storage Is Not Sync-Encrypted at the Google Account Level
`chrome.storage.local` is local-only as implemented. If a user enables Chrome
profile sync and the extension uses `chrome.storage.sync`, the ciphertext
would transit Google's servers. The current implementation explicitly uses
`storage.local` to prevent this.

**Mitigation:** Confirmed use of `chrome.storage.local` only. Never call
`chrome.storage.sync` in this extension.

---

### 7. Clickjacking / UI Redressing on Virtual Pad
The virtual pad renders inside the extension popup or side panel. While the
merchant page cannot overlay elements over Chrome's native popup chrome, a
sophisticated adversary who can inject into the extension popup context
(e.g. via a compromised extension) could potentially intercept pad clicks.

**Mitigation:** The `UiNoiseLayer` randomises button positions by ±3px per tick
and injects decoy buttons, making automated click-pattern analysis unreliable.
The popup runs in a separate OS window; the merchant page has no position control over it.

---

### 8. Side-Panel Auto-Lock Relies on JavaScript Timers
`side_panel_ui.js` uses `setTimeout` to schedule auto-lock after 5 minutes of
inactivity. JavaScript timers can be delayed by tab throttling, background
tab policies, or system sleep. If the timer fires late, the vault may remain
unlocked longer than intended.

**Mitigation:** Add a `chrome.alarms` based backup in the background service
worker (alarms survive tab throttling). The current `scheduleAutoLock()` in
`vault_lock_flow.js` is a best-effort UI-layer timer; a production implementation
should pair it with a service-worker alarm.

---

### 9. Content Script Runs in an Isolated World, Not a Sandboxed Process
Content scripts share the DOM with the merchant page but run in an isolated
JavaScript context. They cannot be read by merchant page scripts, but they
**can read the DOM** — including any values the merchant page has written to
input fields. The `merchant_dom_adapter` only writes masked values and does
not read sensitive data, but the architectural boundary is weaker than a
true process isolation.

**Mitigation:** Never pass raw card data to any content script module.
All data flowing through the content script boundary must be masked tokens only,
as enforced by `DomInjector.injectCardData()` and the `ALLOWED_FIELDS` check.

---

## Recommended Production Hardening

1. **Replace WASM AES stub** with `libsodium-wasm` (`crypto_secretbox`) or
   `mbedTLS` compiled to WASM with `-fstack-protector-strong`.

2. **Fix biometric key stability** — derive the token from stable `authenticatorData`
   fields only (excluding counter), or implement per-method key wrapping (LUKS-style).

3. **Add user PIN** as a second PBKDF2 input factor.

4. **Rate-limit unlock attempts** — lock for 30 seconds after 5 consecutive failures;
   persist the attempt counter in `chrome.storage.local`.

5. **Audit log** — write lock/unlock events with timestamps to `chrome.storage.local`;
   surface them in a settings page.

6. **Key rotation** — re-encrypt all cards with a fresh IV on each unlock session.

7. **Auto-lock via `chrome.alarms`** — supplement the `setTimeout` with a
   `chrome.alarms.create()` in the service worker for reliable background locking.

8. **CSP hardening** — audit all `'wasm-unsafe-eval'` usages and replace with
   streaming instantiation (`WebAssembly.instantiateStreaming`) which does not
   require `unsafe-eval` in Chrome 95+.

9. **Certificate Transparency** — for any backend API calls added in the future,
   require CT-verified TLS certificates.

10. **WebAuthn userVerification enforcement** — ensure `authenticatorSelection.userVerification`
    is always `'required'` (never `'preferred'`) so biometric cannot be bypassed by PIN fallback
    on shared devices.