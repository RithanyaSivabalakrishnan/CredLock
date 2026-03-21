/**
 * popup_ui.js
 * Main entry point for the vault UI (popup and side-panel modes).
 *
 * Responsibilities:
 *  1. Apply sizing constraints for popup vs side-panel
 *  2. Load the Shadow DOM vault container
 *  3. Initialise VaultModel
 *  4. Listen for messages from the background service worker
 *  5. After unlock, request saved cards and populate the card list
 *  6. Offer autofill selection to the user
 */

import { VaultModel }      from '../model/vault_model.js';
import { VaultUiBinding }  from '../model/vault_ui_binding.js';
import { VaultUnlockFlow } from '../../auth/vault_unlock_flow.js';
import { VaultLockFlow }   from '../../auth/vault_lock_flow.js';
import { VirtualPadCore }  from '../input/virtual_pad_core.js';
import { VirtualPadView }  from '../input/virtual_pad_view.js';
import { UiNoiseLayer }    from '../input/ui_noise_layer.js';

// ── Sizing: detect popup vs side-panel context ────────────────────────────

const isSidePanel = window.innerWidth > 500;

if (isSidePanel) {
  document.documentElement.style.setProperty('--shell-w',    '100%');
  document.documentElement.style.setProperty('--shell-min-h','100vh');
  document.body.style.cssText = 'width:100%;min-height:100vh;overflow-y:auto;';
} else {
  document.documentElement.style.setProperty('--shell-w',    '340px');
  document.documentElement.style.setProperty('--shell-min-h','480px');
  document.body.style.cssText = 'width:340px;min-height:480px;max-height:600px;overflow-y:auto;';
}

// ── Shadow DOM container ──────────────────────────────────────────────────

const shadowHost = document.getElementById('sv-shadow-host');
const shadowRoot = shadowHost
  ? shadowHost.attachShadow({ mode: 'closed' })
  : null;

// ── Module instances ──────────────────────────────────────────────────────

const model      = new VaultModel();
const uiBinding  = new VaultUiBinding(model);
const unlockFlow = new VaultUnlockFlow(model);
const lockFlow   = new VaultLockFlow(model);
const padCore    = new VirtualPadCore(4);
const padViewMain = new VirtualPadView(padCore,
  document.getElementById('sv-virtual-pad-mount'), 'otp');
const padViewAdd  = new VirtualPadView(padCore,
  document.getElementById('sv-cvv-pad-mount'), 'cvv');
const noiseLayer  = new UiNoiseLayer(document.getElementById('sv-noise-canvas'));

// ── View helpers ──────────────────────────────────────────────────────────

const VIEWS = {
  unlock:  document.getElementById('sv-view-unlock'),
  main:    document.getElementById('sv-view-main'),
  addCard: document.getElementById('sv-view-add-card'),
};

function showView(name) {
  Object.entries(VIEWS).forEach(([k, el]) => {
    if (el) el.classList.toggle('active', k === name);
  });
}

function setStatus(locked) {
  const dot  = document.getElementById('sv-status-dot');
  const text = document.getElementById('sv-status-text');
  if (dot)  dot.className   = locked ? 'dot-locked' : 'dot-unlocked';
  if (text) text.textContent = locked ? 'Vault Locked' : 'Vault Unlocked';
}

// ── Post-unlock card list load ────────────────────────────────────────────

async function onUnlocked() {
  setStatus(false);
  showView('main');

  // Populate the card list so the user can select one for autofill
  await uiBinding.bindCardsToUI(
    document.getElementById('sv-profile-list'),
    document.getElementById('sv-autofill-btn')
  );

  // Notify background that vault is unlocked and autofill is ready
  chrome.runtime.sendMessage({
    type:    'vault_unlocked',
    payload: { autofillEnabled: true },
  }).catch(() => {});
}

// ── Background message listener ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'VAULT_READY':
      // Background confirmed payment page is active
      console.log('[popup_ui] VAULT_READY — origin:', msg.payload?.origin);
      break;

    case 'VAULT_LOCKED':
      setStatus(true);
      showView('unlock');
      break;
  }
});

// ── Button wiring ─────────────────────────────────────────────────────────

document.getElementById('sv-google-unlock-btn')
  ?.addEventListener('click', async () => {
    const ok = await unlockFlow.unlockWithGoogle();
    if (ok) await onUnlocked();
  });

document.getElementById('sv-biometric-unlock-btn')
  ?.addEventListener('click', async () => {
    const ok = await unlockFlow.unlockWithBiometric();
    if (ok) await onUnlocked();
  });

document.getElementById('sv-lock-btn')
  ?.addEventListener('click', async () => {
    await lockFlow.lock();
    setStatus(true);
    showView('unlock');
  });

document.getElementById('sv-add-profile-btn')
  ?.addEventListener('click', () => {
    showView('addCard');
    padViewAdd.render();
  });

document.getElementById('sv-back-btn')
  ?.addEventListener('click', () => showView('main'));

document.getElementById('sv-save-card-btn')
  ?.addEventListener('click', async () => {
    await uiBinding.saveCurrentCard(shadowRoot);
    showView('main');
    await uiBinding.bindCardsToUI(
      document.getElementById('sv-profile-list'),
      document.getElementById('sv-autofill-btn')
    );
  });

// ── Boot ──────────────────────────────────────────────────────────────────

async function boot() {
  noiseLayer.start();
  padViewMain.render();

  const locked = await model.isLocked();
  setStatus(locked);
  showView(locked ? 'unlock' : 'main');

  if (!locked) {
    // Vault was already unlocked (e.g. popup reopened) — load cards immediately
    await uiBinding.bindCardsToUI(
      document.getElementById('sv-profile-list'),
      document.getElementById('sv-autofill-btn')
    );
  }
}

boot();