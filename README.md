# CredLock — OS-Inspired Sandboxed Payment Vault

A Chrome Extension that mimics **OS-level process isolation and memory encryption**
to protect payment card data from malicious merchant pages.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  User Browser                                               │
│                                                             │
│  ┌──────────────┐     IPC (chrome.runtime)                  │
│  │  Background  │ ◄─────────────────────────────────────┐  │
│  │  (SW / init) │                                       │  │
│  └──────────────┘                                       │  │
│         │ vault_requested / vault_unlocked              │  │
│  ┌──────▼───────┐   Shadow DOM    ┌───────────────────┐ │  │
│  │  Vault UI    │ ──isolates──►   │  Payment Vault    │ │  │
│  │  (Popup/SP)  │                 │  (Encapsulated)   │ │  │
│  └──────────────┘                 └───────────────────┘ │  │
│                                           │              │  │
│  ┌───────────────────────────────────┐    │              │  │
│  │  Content Script (merchant page)   │◄───┘ masked data │  │
│  │  Detects fields, injects tokens   │──────────────────┘  │
│  └───────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

### OS Analogies

| OS Concept                     | CredLock Module                              |
|--------------------------------|-------------------------------------------------|
| Init process (`systemd`)       | `extension_main.js`                             |
| Process manager                | `extension_host.js`                             |
| Security policy (SELinux)      | `sandbox_policy.js`                             |
| User-space syscall shim        | `merchant_site.js`                              |
| Device driver / I/O adapter    | `merchant_dom_adapter.js`                       |
| Window manager                 | `vault_container.js` (Shadow DOM)               |
| Session manager (popup)        | `popup_ui.js`                                   |
| Session manager (side panel)   | `side_panel_ui.js`                              |
| Heap / process memory          | `vault_model.js`                                |
| File inode (site profile)      | `vault_profile.js` → `VaultProfile`             |
| File inode (card record)       | `vault_profile.js` → `CardRecord`               |
| Encrypted filesystem           | `vault_storage.js` (`chrome.storage.local`)     |
| Filesystem superblock          | `vault_storage_schemas.js`                      |
| Privileged write syscall       | `dom_injector.js`                               |
| Secure keyboard driver         | `virtual_pad_core.js`                           |
| Display driver                 | `virtual_pad_view.js`                           |
| Interrupt controller           | `virtual_pad_events.js`                         |
| ASLR / memory noise            | `ui_noise_layer.js`                             |
| Kernel crypto (`AF_ALG`)       | `wasm_crypto.js` + `crypto_engine.c`            |
| Kernel module bindings         | `wasm_crypto_bindings.js`                       |
| TPM / KMS                      | `webcrypto_key_manager.js`                      |
| HSM firmware                   | `key_derivation.c` (PBKDF2 + HKDF)             |
| Kernel ABI header              | `crypto_types.h`                                |
| PAM Google SSO module          | `auth_chrome_identity.js`                       |
| PAM biometric module           | `auth_biometric_stub.js`                        |
| `pam_authenticate`             | `vault_unlock_flow.js`                          |
| `loginctl terminate-session`   | `vault_lock_flow.js`                            |

---

## Security Design

### Process Isolation
- The vault UI runs in a Chrome Extension popup/side-panel — a **separate renderer
  process** from the merchant page.
- The payment vault DOM is encapsulated in a **closed Shadow DOM** root
  (`attachShadow({ mode: 'closed' })`), inaccessible to `document.querySelector`
  from the merchant page or any injected scripts.

### Memory Encryption
- Raw card data (PAN, CVV) exists in the JS heap for **milliseconds only** —
  encrypted immediately via AES-GCM-256 in `CardRecord.fromRaw()`.
- The session key is `extractable: false` — it cannot be serialised or read
  back from the `CryptoKey` object by any JavaScript code.
- On lock, the session key is nulled and the card array cleared.

### Key Derivation
- Keys derived from auth tokens via **PBKDF2-SHA256** (200,000 iterations,
  32-byte random salt stored in `chrome.storage.local`).
- Per-profile sub-keys derived via **HKDF-SHA256** using the profile ID as
  context, tying all keys to a single master key.
- The WASM module (`crypto_engine.c`) provides C-native PBKDF2 and HKDF.

### Anti-Clickjacking
- Virtual numeric pad **shuffles key positions** on every render (Fisher-Yates),
  defeating click-pattern recording.
- **UI noise layer** emits synthetic pointer events, randomises button positions
  (±3px per tick), and inserts temporary decoy buttons.

### Masked Injection
- Only **masked tokens** (e.g. `•••• •••• •••• 4242`) are injected into the
  merchant DOM via `DomInjector`.
- Injection is gated through `ALLOWED_FIELDS` — arbitrary form fields cannot
  be targeted.
- The merchant page never sees a raw PAN or CVV.

### IPC Message Types

| Direction              | Type                | Payload                              |
|------------------------|---------------------|--------------------------------------|
| Content → Background   | `vault_requested`   | `{ origin, fieldsFound, hasSavedCards }` |
| Background → Content   | `VAULT_READY`       | `{ origin, fieldsFound }`            |
| Vault UI → Background  | `vault_unlocked`    | `{ autofillEnabled, cardCount }`     |
| Background → Content   | `VAULT_UNLOCKED`    | `{ autofillReady }`                  |
| Vault UI → Background  | `MASKED_DATA_READY` | `[{ fieldName, maskedValue }]`       |
| Background → Content   | `INJECT_MASKED`     | `[{ fieldName, maskedValue }]`       |
| Content → Background   | `vault_data_filled` | `{ fields: string[] }`               |

---

## Quick Start

### Prerequisites
- Node.js ≥ 18
- Emscripten SDK (for WASM build only — optional, WebCrypto fallback is used otherwise)
- Chrome ≥ 116

### Install & Build

```bash
# Install bundler dependencies
npm install

# Build JS bundles and copy all statics to dist/
npm run build

# Watch mode (incremental rebuilds)
npm run build:watch

# (Optional) Build WASM crypto engine
cd src/wasm
emcc crypto_engine.c key_derivation.c \
     -I. -O2 -s WASM=1 \
     -s EXPORTED_FUNCTIONS='["_sv_alloc","_sv_free","_sv_pbkdf2","_sv_hkdf","_sv_aes_gcm_encrypt","_sv_aes_gcm_decrypt"]' \
     -s ALLOW_MEMORY_GROWTH=1 \
     -o ../../dist/wasm/crypto_engine.wasm
```

### Load in Chrome

1. Run `npm run build` to produce the `dist/` folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** → select the `dist/` folder.
5. Navigate to a checkout or banking page.
6. Click the **CredLock ⬡** icon in the toolbar.

### OAuth Setup

Replace `YOUR_GOOGLE_OAUTH_CLIENT_ID` in `manifest.json` and `dist/manifest.json`
with your real client ID from the
[Google Cloud Console](https://console.cloud.google.com)
→ APIs & Services → Credentials → Create OAuth 2.0 Client ID
(Application type: **Chrome App**, Package name: your extension ID).

---

## Project Structure

```
secure-payment-vault/
├── manifest.json               ← Source-tree manifest (dev loading)
├── build.mjs                   ← esbuild bundler (copies + rewrites paths)
├── package.json
├── jest.config.mjs
│
├── src/
│   ├── background/             ← Service worker (OS init + IPC)
│   │   ├── extension_main.js   ← Init process
│   │   ├── extension_host.js   ← Process manager / IPC dispatcher
│   │   └── sandbox_policy.js   ← SELinux-style allowlist + field policy
│   │
│   ├── content/                ← Merchant page bridge
│   │   ├── merchant_site.js    ← User-space syscall shim
│   │   └── merchant_dom_adapter.js ← I/O adapter / device driver
│   │
│   ├── vault/
│   │   ├── ui/
│   │   │   ├── vault_container.html ← Popup / side-panel shell
│   │   │   ├── vault_container.css  ← Vault UI styles
│   │   │   ├── vault_container.js   ← Window manager (Shadow DOM)
│   │   │   ├── popup_ui.js          ← Session manager (popup mode)
│   │   │   └── side_panel_ui.js     ← Session manager (side-panel mode)
│   │   │
│   │   ├── input/
│   │   │   ├── virtual_pad_core.js    ← Secure keyboard driver
│   │   │   ├── virtual_pad_view.js    ← Display driver
│   │   │   ├── virtual_pad_events.js  ← Interrupt controller
│   │   │   └── ui_noise_layer.js      ← ASLR / UI noise
│   │   │
│   │   ├── model/
│   │   │   ├── vault_model.js         ← Heap manager (addCard, getCards, …)
│   │   │   ├── vault_profile.js       ← VaultProfile + CardRecord
│   │   │   └── vault_ui_binding.js    ← Model → DOM binding
│   │   │
│   │   └── storage/
│   │       ├── vault_storage.js         ← Encrypted filesystem (dm-crypt)
│   │       ├── vault_storage_schemas.js ← Superblock / schema registry
│   │       └── dom_injector.js          ← Privileged write syscall
│   │
│   ├── crypto/
│   │   ├── wasm_crypto.js           ← Kernel crypto API
│   │   ├── wasm_crypto_bindings.js  ← Kernel module bindings
│   │   └── webcrypto_key_manager.js ← TPM / KMS
│   │
│   ├── wasm/                        ← C → WebAssembly sources
│   │   ├── crypto_engine.c          ← AES-GCM stub + sv_alloc/sv_free
│   │   ├── key_derivation.c         ← PBKDF2-SHA256 + HKDF-SHA256
│   │   └── crypto_types.h           ← Kernel ABI header
│   │
│   └── auth/
│       ├── auth_chrome_identity.js  ← Google OAuth PAM module
│       ├── auth_biometric_stub.js   ← WebAuthn PAM module
│       ├── vault_unlock_flow.js     ← pam_authenticate orchestrator
│       └── vault_lock_flow.js       ← Session termination
│
├── dist/                            ← Built extension (load this in Chrome)
│   ├── manifest.json                ← Dist-relative paths
│   ├── background.js                ← Bundled service worker
│   ├── content.js                   ← Bundled content script
│   ├── vault.js                     ← Bundled vault UI
│   ├── ui/                          ← Copied HTML + CSS
│   ├── assets/                      ← Icons + images
│   └── wasm/                        ← Compiled WASM (if built)
│
├── assets/
│   ├── icons/                       ← 16.png, 48.png, 128.png
│   └── images/
│       └── banner.png               ← Web Store promotional banner (1280×640)
│
├── tests/
│   ├── unit/
│   │   ├── vault_model.test.js      ← VaultModel + VaultProfile unit tests
│   │   └── crypto_engine.test.js   ← WasmCrypto + WebCryptoKeyManager tests
│   └── integration/
│       └── e2e_vault_flow.test.js   ← 18-phase full lifecycle integration tests
│
└── docs/
    ├── architecture_diagram.md      ← Component + data flow diagrams
    ├── module_mapping_os.md         ← OS analogy documentation
    └── security_limitations.md      ← Threat model + known limitations
```

---

## Testing

```bash
npm test              # All tests (unit + integration)
npm run test:unit     # Unit tests only
npm run test:e2e      # Integration tests only
```

---

## Storage Key Reference

| Key                         | Value type | Contents                               |
|-----------------------------|------------|----------------------------------------|
| `sv_cards_v1`               | Array      | All `CardRecord.toStorable()` objects  |
| `sv_vault_<profileId>`      | Object     | Per-profile encrypted blob             |
| `sv_profiles_v1`            | Array      | `VaultProfile.toStorable()` records    |
| `sv_meta_v1`                | Object     | Version, lastUnlocked, unlockCount     |
| `sv_pbkdf2_salt`            | String     | Base64 random 32-byte PBKDF2 salt      |
| `sv_webauthn_cred_id`       | String     | Base64 WebAuthn credential ID          |
| `sandbox_policy_v1`         | Object     | Persisted domain allowlist + UI mode   |

---

## Security Limitations

See [`docs/security_limitations.md`](docs/security_limitations.md) for the full
threat model and known limitations. Key points:

- JS memory is **not physically encrypted** — the OS kernel or a compromised
  Chrome process could read heap contents.
- The WASM AES-GCM implementation is a **stub** — production builds must replace
  it with `libsodium-wasm` or `mbedTLS`.
- The **biometric token is not stable across sessions** (WebAuthn counter increments
  each use) — cards saved via one auth method cannot be decrypted by the other.
  See `docs/security_limitations.md` §3 for the LUKS-style mitigation.

---

## License

MIT — see `LICENSE`.