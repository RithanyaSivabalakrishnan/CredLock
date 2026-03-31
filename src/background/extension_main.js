/**
 * extension_main.js
 * Background Service Worker — OS-style "init process"
 * Bootstraps all background modules and routes messages.
 */

import { ExtensionHost } from './extension_host.js';
import { SandboxPolicy }  from './sandbox_policy.js';

const host   = new ExtensionHost();
const policy = new SandboxPolicy();

// ── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[CredLock] Installed:', details.reason);
  await host.init();
  await policy.loadDefaults();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[CredLock] Browser startup — re-initialising host');
  await host.init();
});

// ── Side-panel wiring ──────────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
  .catch(err => console.warn('[CredLock] sidePanel API:', err));

chrome.action.onClicked.addListener(async (tab) => {
  // Toggle between popup (default) and side-panel based on policy
  const mode = await policy.getUiMode(tab.url);
  if (mode === 'sidepanel') {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
  // If mode === 'popup', the manifest default_popup handles it automatically
});

// ── Message bus (IPC) ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  host.dispatch(msg, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ ok: false, error: err.message }));
  return true; // keep channel open for async response
});

// ── Tab / navigation hooks ─────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  const allowed = await policy.isAllowedSite(tab.url);
  if (!allowed) return;

  // Notify content script that vault is available
  chrome.tabs.sendMessage(tabId, { type: 'VAULT_READY' }).catch(() => {});
});