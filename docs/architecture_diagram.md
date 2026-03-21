# CredLock — Architecture Diagram

## Component Interaction Flow

```
User (Browser)
     │
     │  Visits bank / checkout page
     ▼
Merchant Website (HTML + JS)   ◄──── Renders page ─────────────────────────┐
     │                                                                       │
     │  Content script injected (matches payment URL patterns)               │
     ▼                                                                       │
Content Script                                                              │
  merchant_site.js          ──── vault_requested (IPC) ────►               │
  merchant_dom_adapter.js                                                   │
     │                                               Background             │
     │  getFormFields() + hasSavedCards check         Service Worker        │
     ▼                                                                       │
Extension Background (Chrome SW)                                            │
  extension_main.js                                                         │
  extension_host.js         ──── Opens popup / ──────────►  Extension UI   │
  sandbox_policy.js               side panel             (Popup / SidePanel)│
     │                                                   popup_ui.js        │
     │  vault_unlocked / MASKED_DATA_READY (IPC)        side_panel_ui.js   │
     ▼                                                        │              │
Extension UI                                                  │              │
     │                                                        │              │
     │  Encapsulates vault in closed Shadow DOM               │              │
     ▼                                                        │              │
Shadow DOM Payment Vault (Encapsulated)                       │              │
  vault_container.js                                          │              │
     │                                                        │              │
     ├── Decoy buttons + canvas noise ──►  UiNoiseLayer       │              │
     │                                    ui_noise_layer.js   │              │
     │                                                        │              │
     └── Shuffled virtual pad ──►  VirtualPadCore/View/Events │              │
                                   virtual_pad_core.js        │              │
                                                              │              │
     │  Google OAuth or WebAuthn biometric                    │              │
     ▼                                                        │              │
Auth Layer                                                    │              │
  vault_unlock_flow.js                                        │              │
  auth_chrome_identity.js  ──►  chrome.identity.getAuthToken()│              │
  auth_biometric_stub.js   ──►  navigator.credentials.get()   │              │
     │                                                        │              │
     │  auth token → PBKDF2-SHA256 (200k iterations)         │              │
     ▼                                                        │              │
Crypto Layer                                                  │              │
  webcrypto_key_manager.js ──►  Web Crypto API               │              │
  wasm_crypto.js                AES-GCM-256 (non-extractable) │              │
  wasm_crypto_bindings.js  ──►  crypto_engine.wasm            │              │
     │                                                        │              │
     │  sessionKey (CryptoKey, extractable: false)            │              │
     ▼                                                        │              │
Vault Model (In-Memory)                                       │              │
  vault_model.js                                              │              │
  vault_profile.js (CardRecord + VaultProfile)                │              │
  vault_ui_binding.js                                         │              │
     │                                                        │              │
     │  readAllCards / saveAllCards                           │              │
     ▼                                                        │              │
Storage Layer                                                 │              │
  vault_storage.js         ──►  chrome.storage.local          │              │
  vault_storage_schemas.js      key: sv_cards_v1              │              │
  dom_injector.js               key: sv_vault_<profileId>     │              │
     │                                                        │              │
     │  MASKED_DATA_READY → content script                    │              │
     ▼                                                        │              │
Content Script: merchant_dom_adapter.setAutofilledData() ─────────────────►  │
                                                 Sends masked tokens to form  │
     │                                                                        │
     └──────────────────────────── Merchant DOM (Untrusted) ─────────────────┘
```

---

## Data Flow: Card Entry

```
User taps digit on Virtual Pad (shuffled layout)
         │
         ▼
virtual_pad_core.pressKey(digit)
         │   (Fisher-Yates shuffled position map)
         ▼
vault_ui_binding.saveCurrentCard()
         │
         ▼
vault_model.addCard(rawCardData)
         │
         ├── CardRecord.fromRaw(rawCardData, sessionKey, crypto)
         │       │
         │       ├── wasm_crypto.encrypt(sessionKey, JSON.stringify({pan, cvv, expiry}))
         │       │       │
         │       │       └── AES-GCM-256: random IV → [IV (12B) | ciphertext | tag (16B)]
         │       │
         │       └── Zero rawCardData.pan, rawCardData.cvv immediately
         │
         └── vault_storage.saveAllCards(cards, sessionKey, crypto)
                 │
                 └── CardRecord.toStorable() → base64(encryptedBlob)
                         │
                         └── chrome.storage.local.set({ sv_cards_v1: [...] })
```

---

## Data Flow: Autofill

```
User clicks "Autofill & Pay"
         │
         ▼
vault_ui_binding.autofillSelected()
         │
         ▼
chrome.runtime.sendMessage({ type: 'MASKED_DATA_READY', payload: tokens })
         │
         ▼
extension_host.dispatch('MASKED_DATA_READY')
         │
         ├── vault_model.getMaskedTokensForAutofill(cardId)
         │       │
         │       ├── CardRecord.decrypt(sessionKey, crypto)
         │       │       └── wasm_crypto.decrypt → raw {pan, cvv, expiry}
         │       │
         │       ├── Build masked tokens:
         │       │     { fieldName: 'cc-number',  maskedValue: '•••• •••• •••• 1111' }
         │       │     { fieldName: 'cardnumber', maskedValue: '•••• •••• •••• 1111' }
         │       │     { fieldName: 'cc-exp',     maskedValue: '12/27'               }
         │       │     { fieldName: 'cvv',         maskedValue: '•••'                }
         │       │
         │       └── Zero raw object: pan='0000...', cvv='000'
         │
         └── chrome.tabs.sendMessage(tabId, { type: 'INJECT_MASKED', payload: tokens })
                 │
                 ▼
         Content Script: merchant_site.js
                 │
                 ├── merchant_dom_adapter.injectMaskedInputs(tokens)
                 │       └── setAutofilledData(tokens) — only ALLOWED_FIELDS written
                 │               └── native HTMLInputElement value setter
                 │                   (triggers React/Vue/Angular synthetic events)
                 │
                 └── chrome.runtime.sendMessage({ type: 'vault_data_filled' })
```

---

## Data Flow: Per-Profile Vault (saveVault / loadVault)

```
vault_model.saveVault(profileId)
         │
         ▼
vault_storage.writeVault(profileId, cards, sessionKey, crypto)
         │
         ├── Serialize: cards.map(c => c.toStorable())  → JSON string
         ├── wasm_crypto.encrypt(sessionKey, jsonString) → ArrayBuffer
         └── chrome.storage.local.set({ sv_vault_<profileId>: { encryptedB64, ... } })

vault_model.loadVault(profileId)
         │
         ▼
vault_storage.readVault(profileId, sessionKey, crypto)
         │
         ├── chrome.storage.local.get('sv_vault_<profileId>')
         ├── wasm_crypto.decrypt(sessionKey, encryptedBlob) → JSON string
         └── JSON.parse → CardRecord.fromStorable[] → merged into #cards
```

---

## Security Boundaries

```
┌──────────────────────────────────────────────────────────────────┐
│  Chrome Extension Process (trusted renderer)                     │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Vault UI  (popup_ui.js / side_panel_ui.js)                │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  Closed Shadow DOM  ← merchant JS cannot reach here  │  │  │
│  │  │  ┌────────────────────────────────────────────────┐  │  │  │
│  │  │  │  vault_model.js — #sessionKey, #cards          │  │  │  │
│  │  │  │  CryptoKey { extractable: false }              │  │  │  │
│  │  │  │  CardRecord — #encryptedBlob only              │  │  │  │
│  │  │  └────────────────────────────────────────────────┘  │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Background Service Worker (extension_host.js)             │  │
│  │  chrome.runtime IPC — messages only, no shared memory      │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘

        chrome.tabs.sendMessage — MASKED TOKENS ONLY (never raw PAN)
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Merchant Page Renderer (untrusted)                              │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Content Script (isolated world — no shared JS scope)      │  │
│  │  merchant_dom_adapter.setAutofilledData()                  │  │
│  │  Writes only to ALLOWED_FIELDS, only masked values         │  │
│  └────────────────────────────────────────────────────────────┘  │
│                           │                                      │
│  ┌────────────────────────▼───────────────────────────────────┐  │
│  │  Merchant DOM — receives •••• •••• •••• 4242 only          │  │
│  │  Raw PAN and CVV are never written here                     │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Storage Key Map

| Key                         | Type     | Contents                                    |
|-----------------------------|----------|---------------------------------------------|
| `sv_cards_v1`               | Array    | All `CardRecord.toStorable()` objects       |
| `sv_vault_<profileId>`      | Object   | Per-profile encrypted blob + metadata       |
| `sv_profiles_v1`            | Array    | `VaultProfile.toStorable()` site profiles   |
| `sv_meta_v1`                | Object   | Vault metadata (version, lastUnlocked, etc) |
| `sv_pbkdf2_salt`            | String   | Base64 random 32-byte PBKDF2 salt           |
| `sv_webauthn_cred_id`       | String   | Base64 WebAuthn credential ID               |
| `sandbox_policy_v1`         | Object   | Persisted SandboxPolicy domains + uiMode    |