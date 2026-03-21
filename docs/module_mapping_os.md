# Module → OS Concept Mapping

Every CredLock module maps to a well-understood OS concept.
This document explains the design rationale for each analogy.

---

## Background Process Group (Service Worker)

### `extension_main.js` → OS Init Process (`/sbin/init`, `systemd`)
- First code to run when the extension installs or the browser starts
- Bootstraps `ExtensionHost` and `SandboxPolicy` (analogous to starting kernel subsystems)
- Owns the `chrome.runtime.onMessage` bus — the extension's IPC router
- Handles lifecycle events: `onInstalled`, `onStartup`, `tabs.onUpdated`

### `extension_host.js` → Process Manager / Syscall Dispatcher
- Maintains a `#vaultSessions` Map (analogous to the kernel process table)
- Routes IPC messages by type to the correct handler (analogous to a syscall dispatch table)
- Handles `vault_requested`, `vault_unlocked`, `vault_data_filled`, `MASKED_DATA_READY`
- Enforces the site allowlist via `SandboxPolicy.isAllowed()` before opening sessions

### `sandbox_policy.js` → Security Policy Engine (SELinux / AppArmor)
- Exports `isAllowed(domain)` — the primary site allowlist check
- Exports `isAllowedField(fieldId)` and `ALLOWED_FIELDS` Set — field-level policy
- Persists policy to `chrome.storage.local` (analogous to loading SELinux policy modules)
- Controls UI mode (`popup` vs `sidepanel`) per policy

---

## Content Script Group (User-Space)

### `merchant_site.js` → User-Space Application / System-Call Shim
- Runs in the untrusted merchant renderer (analogous to an unprivileged user process)
- Communicates with the background via `chrome.runtime.sendMessage` —
  the exact analogy of a **system call** crossing the user→kernel boundary
- Checks `chrome.storage.local` for saved cards before the vault opens (`hasSavedCards`)
- Relays `vault_data_filled` confirmation back to the background after injection

### `merchant_dom_adapter.js` → Device Driver / I/O Adapter
- Abstracts the merchant DOM (the "hardware") behind a typed interface
- Exports `getFormFields()`, `setMaskedValue()`, `setAutofilledData()` — the driver API
- Filters writes through `ALLOWED_FIELDS` (analogous to a driver's I/O permission bitmap)
- Uses the native `HTMLInputElement` value setter to trigger framework events correctly

---

## Vault Group (Sandboxed Process)

### `popup_ui.js` → Session Manager / Login UI (popup mode)
- Full entry point for popup context: initialises model, auth flows, pad, noise layer
- Applies 340×480px sizing constraints suitable for Chrome's popup window
- Listens for `VAULT_READY` and `VAULT_LOCKED` background messages
- Calls `bindCardsToUI()` after unlock to load saved cards for autofill

### `side_panel_ui.js` → Session Manager / Login UI (side-panel mode)
- Full entry point for side-panel context — same responsibilities as `popup_ui.js`
- Applies full-width / full-height layout (side panels stay open indefinitely)
- Injects an **active-site badge** showing the origin of the triggering payment page
- Schedules **auto-lock** after 5 minutes of inactivity via `lockFlow.scheduleAutoLock()`
- Provides a **search/filter bar** for navigating many saved cards
- Renders saved cards in a **two-column grid** to use the wider canvas efficiently

### `vault_container.js` → Window Manager / Compositor
- Mounts a `closed` Shadow DOM (analogous to a process address space boundary)
- Coordinates view transitions (unlock → main → add-card)
- Wires `VaultModel`, `VaultUiBinding`, `VaultUnlockFlow`, `VaultLockFlow`, pads, and noise

### Shadow DOM (mode: 'closed') → Process Address Space Boundary
- `attachShadow({ mode: 'closed' })` — external JS cannot obtain the shadow root reference
- Analogous to separate virtual address spaces: merchant page's `document.querySelector`
  cannot penetrate this boundary any more than a user process can read kernel memory
- Card numbers, CVV, and the session key exist only inside this boundary

### `vault_model.js` → Heap / Process Memory Manager
- Owns all sensitive in-memory state: `#sessionKey` (CryptoKey), `#cards` (CardRecord[])
- `lock()` nulls the session key and clears the card array — analogous to `munmap` + `memset`
- `extractable: false` on the CryptoKey — analogous to marking pages kernel-only (`PROT_NONE`)
- Exports the full CRUD API: `addCard`, `updateCard`, `removeCard`, `getCards`,
  `loadVault(profileId)`, `saveVault(profileId)`, `getMaskedTokensForAutofill`

### `vault_profile.js` → Two-level inode structure
Exports **two distinct classes** — unlike typical file inodes, payments have two
granularities of record:

- **`VaultProfile`** → Directory inode (site-level)
  - Represents a bank or shop: `createProfile(name, siteOrigin)`
  - Controls whether autofill is enabled: `setAutofillEnabled()` / `isAutofillEnabled()`
  - Stored in `sv_profiles_v1`

- **`CardRecord`** → File inode (card-level)
  - Represents one encrypted payment card
  - `fromRaw()` encrypts immediately; raw PAN/CVV zeroed after construction
  - `decrypt()` for transient decryption during autofill only
  - Stored as an entry in `sv_cards_v1` or `sv_vault_<profileId>`

### `vault_storage.js` → Encrypted Filesystem / Block Device
- Persists only ciphertext to `chrome.storage.local` — no plaintext ever reaches disk
- `createVault(profileId)` / `readVault(profileId)` / `updateVault(profileId)` / `deleteVault(profileId)` — full CRUD keyed by profile
- `readAllCards()` / `saveAllCards()` — flat list for the default profile
- Analogous to `dm-crypt` transparent disk encryption: callers see plaintext, disk has ciphertext

### `vault_storage_schemas.js` → Filesystem Superblock / Schema Registry
- Exports typed schema objects: `EncryptedCardRecordSchema`, `VaultRecordSchema`,
  `VaultProfileSchema`, `VaultMetaSchema` with field-level validation
- Exports `VAULT_STORAGE_KEYS` — the central registry of all chrome.storage key names
- Exports `CRYPTO_LAYOUT` constants that match `crypto_types.h` (IV=12, TAG=16, KEY=32)
- `validateRecord(record, schema)` — analogous to a filesystem consistency check (fsck)

### `dom_injector.js` → Privileged Write System Call (`write(2)` with capability check)
- The **only** module that writes card data into the merchant DOM
- `injectCardData(cardData)` — writes masked tokens (last-4 PAN, masked CVV)
- `injectMaskedCardData(cardData)` — writes fully opaque placeholder values
- Delegates to `MerchantDomAdapter.setAutofilledData()` which enforces `ALLOWED_FIELDS`
- Analogous to a `write(2)` syscall that checks file capabilities before proceeding

---

## Input Group

### `virtual_pad_core.js` → Secure Keyboard Driver
- Manages digit entry state in `#buffer` — a private field never exposed to the DOM
- `pressKey()`, `clear()`, `submit()` — the driver's command interface
- `reshuffle()` randomises key layout (Fisher-Yates) — analogous to ASLR for input positions
- Emits typed events (`input`, `complete`, `submit`, `cleared`) — analogous to kernel input events

### `virtual_pad_view.js` → Terminal Emulator / Display Driver
- Renders the shuffled key grid to the DOM
- Purely presentational: reads `core.layout`, renders buttons, wires click → `core.pressKey()`
- Re-shuffles on every `render()` call to ensure a fresh random layout

### `virtual_pad_events.js` → Interrupt Controller / Input Filter
- Captures physical keydown/keyup in the capture phase — blocks leakage to merchant page
- Enforces per-mode length limits: CVV `{min:3, max:3}`, OTP `{min:4, max:8}`
- `cancel()` clears and reshuffles without emitting any value
- Analogous to a hardware interrupt controller that filters and routes IRQs

### `ui_noise_layer.js` → ASLR / Memory Noise Generator
- Three obfuscation mechanisms: canvas pixel noise, synthetic pointer events,
  and CSS `transform` jitter on pad buttons (±3px per tick)
- Inserts temporary decoy buttons (25% chance per tick, auto-removed after 400ms)
- Does not affect autofill — operates on DOM presentation only
- Analogous to ASLR + heap randomisation: makes predictable click-pattern
  attacks statistically unreliable

---

## Crypto Group (Kernel Subsystem)

### `wasm_crypto.js` → Kernel Crypto API (`/dev/crypto`, `AF_ALG`)
- Primary encrypt/decrypt interface for all vault modules
- `encrypt(key, plaintext, iv?)` — AES-GCM-256; packs `[IV | ciphertext | tag]`
- `decrypt(key, buffer)` and `decrypt(key, ciphertext, iv, tag)` — both calling conventions
- Falls back from WASM to WebCrypto gracefully (analogous to software fallback when AES-NI unavailable)
- Exposes `keyManager` getter for modules needing direct key management

### `wasm_crypto_bindings.js` → Kernel Module / Device Driver Bindings
- Loads `crypto_engine.wasm` via `WebAssembly.instantiate()`
- Manages WASM linear memory: `sv_alloc` / `sv_free` (analogous to `kmalloc`/`kfree`)
- Bridges JS typed arrays ↔ WASM pointer offsets (analogous to `copy_to_user` / `copy_from_user`)
- PBKDF2 via `bindings.pbkdf2()` delegates to the C `sv_pbkdf2` export

### `webcrypto_key_manager.js` → Key Management Service / TPM Interface
- `createMasterKey()` — generates a non-extractable AES-GCM-256 key
- `deriveKeyFromToken(token)` — PBKDF2-SHA256 with 200,000 iterations + persisted salt
- `deriveKeyFromPassphrase(pass, salt, iters)` — explicit params for WASM companion
- `exportKey(key, wrappingKey)` / `importKey(buf, wrappingKey)` — AES-KW wrapping roundtrip
- `extractable: false` — the derived key cannot leave the WebCrypto subsystem,
  analogous to a TPM's sealed key that cannot be extracted from hardware

### `crypto_engine.c` → Kernel Crypto Module
- `sv_aes_gcm_encrypt` / `sv_aes_gcm_decrypt` — AES-GCM with WASM-native memory layout
- Compiled to `crypto_engine.wasm` via Emscripten
- Runs in WASM linear memory — isolated from the JS heap
- Analogous to a `CONFIG_CRYPTO_AES` kernel module running in ring-0 address space

### `key_derivation.c` → Hardware Security Module Firmware
- `sv_pbkdf2(pass, salt, iters, out_key)` — PBKDF2-SHA256 (RFC 2898)
- `sv_hkdf(ikm, info, salt, okm)` — HKDF-SHA256 (RFC 5869) for per-profile sub-keys
  - `info` parameter = profileId bytes → each profile gets a cryptographically independent key
  - All keys tied to the same master key (analogous to hardware-derived key hierarchy)
- Full SHA-256 + HMAC-SHA256 implemented in C for use inside WASM linear memory

### `crypto_types.h` → Kernel ABI Header (`linux/crypto.h`)
- `vault_record_t` — matches `VaultRecordSchema` (IV, tag, encrypted blob, profileId, updatedAt)
- `key_t` — 256-bit AES key with length field
- `crypto_context_t` — per-operation state (key + IV + tag + lengths + status)
- `pbkdf2_params_t` / `hkdf_params_t` — typed parameter structs for derivation functions
- Constants `SV_GCM_IV_BYTES=12`, `SV_GCM_TAG_BYTES=16` match `CRYPTO_LAYOUT` in schemas

---

## Auth Group (Login Subsystem)

### `auth_chrome_identity.js` → PAM Module (Google SSO / `pam_google`)
- `login()` — interactive OAuth sign-in
- `getAuthToken(interactive?)` — silent-first with interactive fallback
- `revokeToken(token)` — forces re-authentication (analogous to `pam_end` + credential revocation)
- `getProfileInfo()` — returns signed-in account email/ID for the lock screen

### `auth_biometric_stub.js` → PAM Biometric Module (`pam_fprintd`)
- Uses WebAuthn `navigator.credentials` — hardware-bound to the device authenticator
- First call: `credentials.create()` (analogous to `fprint enroll`)
- Subsequent calls: `credentials.get()` with `userVerification: 'required'` (analogous to `fprintd-verify`)
- Credential ID persisted to `chrome.storage.local` (`sv_webauthn_cred_id`)
- Returns a SHA-256 digest of `authenticatorData` as the key-derivation token

### `vault_unlock_flow.js` → `pam_authenticate` Orchestrator / Login Service
- `unlockWithGoogle()` — Google Identity path
- `unlockWithBiometric()` — WebAuthn path
- `unlock()` — tries Google first, falls back to biometric
- `#postUnlock()` — loads cards, preloads default card (`model.selectedCardId = cards[0].id`),
  notifies background with `vault_unlocked`
- Analogous to `pam_authenticate` → `pam_open_session` → notify PAM subsystem

### `vault_lock_flow.js` → Session Termination / `loginctl terminate-session`
- `lock()` — calls `model.lock()` (zeros key + cards) + optionally revokes OAuth token
- `scheduleAutoLock(ms, cb)` — idle-timeout lock; returns a cancel function
  (analogous to `xscreensaver` / session timeout daemon)
- Sends `VAULT_CLOSE` to background (analogous to `SIGHUP` to session leader)