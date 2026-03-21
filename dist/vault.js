/**
 * vault.js
 * SecureVault — Vault UI Bundle (bundled entry point)
 *
 * This file is the esbuild output of src/vault/ui/vault_container.js,
 * which includes the full vault UI, VaultModel, VaultUiBinding,
 * VirtualPadCore/View/Events, UiNoiseLayer, WasmCrypto, and all auth flows.
 *
 * Run `npm run build` from the project root to regenerate it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STUB NOTICE — run `npm run build` to replace with the real bundle.
 * ─────────────────────────────────────────────────────────────────────────────
 */

console.warn(
  '[SecureVault] vault.js is a pre-build stub. ' +
  'Run `npm run build` to generate the real bundle.'
);

// Display a visible error in the popup/side-panel so the developer
// knows to run the build step.
document.addEventListener('DOMContentLoaded', function () {
  const shell = document.getElementById('sv-shell');
  if (!shell) return;

  const banner = document.createElement('div');
  banner.style.cssText = [
    'padding:20px 16px',
    'font-family:monospace',
    'font-size:12px',
    'color:#ef5350',
    'background:#1a0000',
    'border:1px solid #ef5350',
    'border-radius:8px',
    'margin:16px',
    'line-height:1.6',
  ].join(';');

  banner.innerHTML = [
    '<strong style="color:#ef5350">Build required</strong><br>',
    'vault.js is a stub. Run:<br>',
    '<code style="color:#e8f0fe">npm install &amp;&amp; npm run build</code><br>',
    'then reload the extension.',
  ].join('');

  shell.prepend(banner);
});