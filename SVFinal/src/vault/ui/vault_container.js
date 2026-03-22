/**
 * vault_container.js
 * OS analog: "Window Manager / Compositor"
 * Mounts the Shadow DOM payment vault and wires top-level view transitions.
 */

import { VaultModel }     from '../model/vault_model.js';
import { VaultUiBinding } from '../model/vault_ui_binding.js';
import { VaultUnlockFlow } from '../../auth/vault_unlock_flow.js';
import { VaultLockFlow }   from '../../auth/vault_lock_flow.js';
import { VirtualPadCore }  from '../input/virtual_pad_core.js';
import { VirtualPadView }  from '../input/virtual_pad_view.js';
import { UiNoiseLayer }    from '../input/ui_noise_layer.js';

// ── Shadow DOM isolation ──────────────────────────────────────────────────

const shadowHost = document.getElementById('sv-shadow-host');
const shadowRoot = shadowHost.attachShadow({ mode: 'closed' });

// The vault "inner" lives in Shadow DOM; merchant page cannot reach it
const vaultInner = document.createElement('div');
vaultInner.id = 'sv-vault-inner';
shadowRoot.appendChild(vaultInner);

// ── Module instances ──────────────────────────────────────────────────────

const model       = new VaultModel();
const unlockFlow  = new VaultUnlockFlow(model);
const lockFlow    = new VaultLockFlow(model);
const uiBinding   = new VaultUiBinding(model);
const noiseLayer  = new UiNoiseLayer(document.getElementById('sv-noise-canvas'));

// ── Virtual numpad (CVV / OTP) ────────────────────────────────────────────

const padCore     = new VirtualPadCore();
const padViewMain = new VirtualPadView(padCore,
  document.getElementById('sv-virtual-pad-mount'), 'otp');
const padViewAdd  = new VirtualPadView(padCore,
  document.getElementById('sv-cvv-pad-mount'), 'cvv');

// ── View helpers ──────────────────────────────────────────────────────────

const VIEWS = {
  unlock:  document.getElementById('sv-view-unlock'),
  main:    document.getElementById('sv-view-main'),
  addCard: document.getElementById('sv-view-add-card'),
};

function showView(name) {
  Object.entries(VIEWS).forEach(([k, el]) => {
    el.classList.toggle('active', k === name);
  });
}

// ── Status bar helpers ────────────────────────────────────────────────────

const statusDot  = document.getElementById('sv-status-dot');
const statusText = document.getElementById('sv-status-text');

function setStatus(locked) {
  statusDot.className  = locked ? 'dot-locked' : 'dot-unlocked';
  statusText.textContent = locked ? 'Vault Locked' : 'Vault Unlocked';
}

// ── Init ──────────────────────────────────────────────────────────────────

async function boot() {
  noiseLayer.start();

  const isLocked = await model.isLocked();
  setStatus(isLocked);
  showView(isLocked ? 'unlock' : 'main');

  if (!isLocked) {
    await uiBinding.renderProfiles(
      document.getElementById('sv-profile-list')
    );
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────

document.getElementById('sv-google-unlock-btn').addEventListener('click', async () => {
  const ok = await unlockFlow.unlockWithGoogle();
  if (ok) {
    setStatus(false);
    showView('main');
    await uiBinding.renderProfiles(document.getElementById('sv-profile-list'));
  }
});

document.getElementById('sv-biometric-unlock-btn').addEventListener('click', async () => {
  const ok = await unlockFlow.unlockWithBiometric();
  if (ok) {
    setStatus(false);
    showView('main');
    await uiBinding.renderProfiles(document.getElementById('sv-profile-list'));
  }
});

document.getElementById('sv-lock-btn').addEventListener('click', async () => {
  await lockFlow.lock();
  setStatus(true);
  showView('unlock');
});

document.getElementById('sv-add-profile-btn').addEventListener('click', () => {
  showView('addCard');
  padViewAdd.render();
});

document.getElementById('sv-back-btn').addEventListener('click', () => {
  showView('main');
});

document.getElementById('sv-save-card-btn').addEventListener('click', async () => {
  await uiBinding.saveCurrentCard(shadowRoot);
  showView('main');
  await uiBinding.renderProfiles(document.getElementById('sv-profile-list'));
});

document.getElementById('sv-autofill-btn').addEventListener('click', async () => {
  await uiBinding.autofillSelected();
});

padViewMain.render();

boot();