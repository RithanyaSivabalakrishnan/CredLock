/**
 * background.js
 * SecureVault — Background Service Worker (bundled entry point)
 *
 * This file is the esbuild output of src/background/extension_main.js.
 * Run `npm run build` from the project root to regenerate it.
 *
 * What this module does at runtime:
 *  - Bootstraps ExtensionHost (session table, IPC dispatcher)
 *  - Bootstraps SandboxPolicy (site allowlist, field policy)
 *  - Wires chrome.action.onClicked → popup or side-panel
 *  - Wires chrome.tabs.onUpdated  → vault_requested signal to content scripts
 *  - Wires chrome.runtime.onMessage → ExtensionHost.dispatch()
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STUB NOTICE
 * This is a pre-build stub that logs a clear error if loaded without building.
 * Replace by running:
 *
 *   npm install
 *   npm run build
 *
 * The build will produce the real bundled output at this path.
 * ─────────────────────────────────────────────────────────────────────────────
 */

console.warn(
  '[SecureVault] background.js is a pre-build stub. ' +
  'Run `npm run build` to generate the real bundle.'
);

// Minimal heartbeat so Chrome does not error on the service worker registration
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', () => clients.claim());

self.addEventListener('message', (event) => {
  event.source?.postMessage({
    type:  'STUB_RESPONSE',
    error: 'Extension not built. Run `npm run build`.',
  });
});