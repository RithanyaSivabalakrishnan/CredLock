# dist/ — Built Extension

Load this folder in Chrome via `chrome://extensions` → **Developer mode** → **Load unpacked**.

---

## How to build

```bash
npm install        # install esbuild and jest
npm run build      # bundles src/ → dist/*.js + copies manifest
```

The `build.mjs` script uses **esbuild** and produces:

| File              | Source entry point                      | Role                              |
|-------------------|-----------------------------------------|-----------------------------------|
| `background.js`   | `src/background/extension_main.js`      | MV3 service worker                |
| `content.js`      | `src/content/merchant_site.js`          | Content script (merchant pages)   |
| `vault.js`        | `src/vault/ui/vault_container.js`       | Popup + side-panel vault UI       |
| `manifest.json`   | copied from project root                | Chrome extension manifest         |

---

## Directory layout (after build)

```
dist/
├── manifest.json          ← Chrome reads this first; all paths relative to dist/
├── background.js          ← Service worker (MV3)
├── content.js             ← Content script injected into payment pages
├── vault.js               ← Vault UI + model + crypto (bundled)
│
├── ui/
│   ├── vault_container.html   ← Popup / side-panel shell (action.default_popup)
│   └── vault_container.css    ← Vault UI stylesheet
│
├── assets/
│   ├── icons/
│   │   ├── 16.png         ← Favicon / tab strip icon
│   │   ├── 48.png         ← Extension management page icon
│   │   └── 128.png        ← Chrome Web Store / install dialog icon
│   └── images/
│       └── banner.png     ← Web Store promotional banner (1280×640)
│
└── wasm/
    └── crypto_engine.wasm ← Compiled from src/wasm/crypto_engine.c (see below)
```

---

## WASM build (optional)

The extension falls back to the Web Crypto API if `crypto_engine.wasm` is absent.
To build the WASM module:

```bash
# Requires Emscripten SDK: https://emscripten.org/docs/getting_started/downloads.html
cd src/wasm
emcc crypto_engine.c key_derivation.c \
     -I. -O2 -s WASM=1 \
     -s EXPORTED_FUNCTIONS='["_sv_alloc","_sv_free","_sv_pbkdf2","_sv_hkdf","_sv_aes_gcm_encrypt","_sv_aes_gcm_decrypt"]' \
     -s ALLOW_MEMORY_GROWTH=1 \
     -o ../../dist/wasm/crypto_engine.wasm
```

---

## Path resolution notes

All paths in `dist/manifest.json` are relative to `dist/` (the extension root):

| Manifest key                         | Resolved path               |
|--------------------------------------|-----------------------------|
| `background.service_worker`          | `dist/background.js`        |
| `content_scripts[].js`               | `dist/content.js`           |
| `action.default_popup`               | `dist/ui/vault_container.html` |
| `side_panel.default_path`            | `dist/ui/vault_container.html` |
| `icons["16"]`                        | `dist/assets/icons/16.png`  |
| `web_accessible_resources[].vault.js`| `dist/vault.js`             |
| `web_accessible_resources[].wasm`    | `dist/wasm/crypto_engine.wasm` |

The source-tree `manifest.json` (project root) uses `dist/background.js` and
`src/vault/ui/vault_container.html` — those paths work when loading from the
**project root** during development. The `dist/manifest.json` uses paths
relative to `dist/` for **production loading**.

---

## OAuth setup

Replace `YOUR_GOOGLE_OAUTH_CLIENT_ID` in `manifest.json` with your real
client ID from the [Google Cloud Console](https://console.cloud.google.com)
→ APIs & Services → Credentials → Create OAuth 2.0 Client ID
(Application type: **Chrome App**, Package name: your extension ID).