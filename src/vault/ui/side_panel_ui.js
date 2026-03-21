/**
 * side_panel_ui.js
 * Entry point for the vault UI when opened as a Chrome Side Panel.
 *
 * Differences from popup_ui.js:
 *  - Full-width, full-height layout (not constrained to 340px popup width)
 *  - Two-column card grid for easier scanning of multiple saved cards
 *  - Active-site indicator: shows which payment page triggered the vault
 *  - Auto-lock timer: side panels stay open indefinitely, so we schedule
 *    an idle lock after 5 minutes of inactivity
 *  - Search / filter bar to find a card quickly when many are saved
 *  - Larger virtual pad suitable for the wider canvas
 *
 * Responsibilities (same as popup_ui.js):
 *  1. Apply side-panel sizing (100% width, 100vh height)
 *  2. Attach closed Shadow DOM vault container
 *  3. Initialise VaultModel
 *  4. Listen for background messages (VAULT_READY, VAULT_LOCKED)
 *  5. After unlock, load saved cards and offer autofill selection
 *  6. Schedule auto-lock and reset it on user activity
 */

import { VaultModel }      from '../model/vault_model.js';
import { VaultUiBinding }  from '../model/vault_ui_binding.js';
import { VaultUnlockFlow } from '../../auth/vault_unlock_flow.js';
import { VaultLockFlow }   from '../../auth/vault_lock_flow.js';
import { VirtualPadCore }  from '../input/virtual_pad_core.js';
import { VirtualPadView }  from '../input/virtual_pad_view.js';
import { UiNoiseLayer }    from '../input/ui_noise_layer.js';

// ── Side-panel sizing ─────────────────────────────────────────────────────

document.documentElement.style.setProperty('--shell-w',    '100%');
document.documentElement.style.setProperty('--shell-min-h','100vh');
document.body.style.cssText = [
  'width:100%',
  'min-height:100vh',
  'overflow-y:auto',
  'overflow-x:hidden',
].join(';');

// Extra side-panel layout overrides injected directly so vault_container.css
// does not need to know about the side-panel context.
const styleEl = document.createElement('style');
styleEl.textContent = `
  #sv-shell {
    width: 100% !important;
    min-height: 100vh !important;
    max-height: none !important;
    border-radius: 0 !important;
  }
  /* Two-column card grid for the side panel */
  .sv-profile-list {
    display: grid !important;
    grid-template-columns: 1fr 1fr !important;
    gap: 8px !important;
  }
  /* Wider form rows */
  .sv-form-row {
    gap: 16px !important;
  }
  /* Slightly more breathing room in views */
  .sv-view {
    padding: 24px 20px !important;
    max-width: 520px !important;
    margin: 0 auto !important;
  }
  /* Active site badge */
  #sv-site-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    font-size: 10px;
    letter-spacing: 0.08em;
    color: var(--accent, #00e676);
    border-bottom: 1px solid var(--border, rgba(0,230,118,0.12));
    background: var(--bg-surface, #111620);
    font-family: var(--mono, monospace);
  }
  #sv-site-badge .sv-site-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent, #00e676);
    flex-shrink: 0;
  }
  /* Search bar */
  #sv-card-search {
    width: 100%;
    padding: 8px 12px;
    background: var(--bg-field, #0d1117);
    border: 1px solid var(--border, rgba(0,230,118,0.12));
    border-radius: 4px;
    color: var(--text-primary, #e8f0fe);
    font-family: var(--mono, monospace);
    font-size: 12px;
    outline: none;
    margin-bottom: 8px;
  }
  #sv-card-search:focus {
    border-color: var(--accent, #00e676);
  }
  /* Auto-lock countdown */
  #sv-autolock-bar {
    position: sticky;
    bottom: 0;
    padding: 6px 16px;
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--text-dim, #3d5068);
    background: var(--bg-field, #0d1117);
    border-top: 1px solid var(--border, rgba(0,230,118,0.12));
    font-family: var(--mono, monospace);
    text-align: right;
  }
`;
document.head.appendChild(styleEl);

// ── Shadow DOM container ──────────────────────────────────────────────────

const shadowHost = document.getElementById('sv-shadow-host');
const shadowRoot = shadowHost
  ? shadowHost.attachShadow({ mode: 'closed' })
  : null;

// ── Module instances ──────────────────────────────────────────────────────

const model       = new VaultModel();
const uiBinding   = new VaultUiBinding(model);
const unlockFlow  = new VaultUnlockFlow(model);
const lockFlow    = new VaultLockFlow(model);

// Larger maxLength for side-panel OTP (up to 8 digits)
const padCore     = new VirtualPadCore(4, 'cvv');
const padViewMain = new VirtualPadView(
  padCore, document.getElementById('sv-virtual-pad-mount'), 'otp'
);
const padViewAdd  = new VirtualPadView(
  padCore, document.getElementById('sv-cvv-pad-mount'), 'cvv'
);
const noiseLayer  = new UiNoiseLayer(
  document.getElementById('sv-noise-canvas'),
  document.getElementById('sv-virtual-pad-mount')
);

// ── Active-site indicator ─────────────────────────────────────────────────

function injectSiteBadge(origin) {
  const existing = document.getElementById('sv-site-badge');
  if (existing) { existing.querySelector('span')?.remove(); return; }

  const bar = document.createElement('div');
  bar.id = 'sv-site-badge';
  bar.innerHTML = `<span class="sv-site-dot"></span><span>${origin ?? 'No active payment page'}</span>`;

  const statusBar = document.getElementById('sv-status-bar');
  statusBar?.insertAdjacentElement('afterend', bar);
}

// ── Auto-lock timer ───────────────────────────────────────────────────────

const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes
let cancelAutoLock = null;

function resetAutoLock() {
  if (cancelAutoLock) cancelAutoLock();
  cancelAutoLock = lockFlow.scheduleAutoLock(AUTO_LOCK_MS, () => {
    setStatus(true);
    showView('unlock');
    updateAutoLockBar(0);
  });
  updateAutoLockBar(AUTO_LOCK_MS);
}

function updateAutoLockBar(remainingMs) {
  const bar = document.getElementById('sv-autolock-bar');
  if (!bar) return;
  if (remainingMs <= 0) {
    bar.textContent = 'Vault locked due to inactivity';
    return;
  }
  const mins = Math.floor(remainingMs / 60000);
  const secs = Math.floor((remainingMs % 60000) / 1000);
  bar.textContent = `Auto-lock in ${mins}:${String(secs).padStart(2, '0')}`;
}

// Inject auto-lock bar at the bottom of the shell
function injectAutoLockBar() {
  if (document.getElementById('sv-autolock-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'sv-autolock-bar';
  bar.textContent = 'Auto-lock in 5:00';
  document.getElementById('sv-shell')?.appendChild(bar);
}

// Reset auto-lock timer on any user interaction
document.addEventListener('click',     resetAutoLock, { passive: true });
document.addEventListener('keydown',   resetAutoLock, { passive: true });
document.addEventListener('mousemove', resetAutoLock, { passive: true });

// ── Search / filter ───────────────────────────────────────────────────────

/**
 * Injects a search input above the card list so the user can quickly
 * filter saved cards by holder name, brand, or last-four digits.
 */
function injectSearchBar(listEl) {
  const existing = document.getElementById('sv-card-search');
  if (existing) return;

  const input = document.createElement('input');
  input.id          = 'sv-card-search';
  input.type        = 'text';
  input.placeholder = 'Search cards…';
  input.setAttribute('aria-label', 'Search saved cards');

  input.addEventListener('input', () => {
    const query = input.value.toLowerCase().trim();
    listEl.querySelectorAll('.sv-profile-item').forEach(li => {
      const text = li.textContent.toLowerCase();
      li.style.display = (!query || text.includes(query)) ? '' : 'none';
    });
  });

  listEl.insertAdjacentElement('beforebegin', input);
}

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
  if (dot)  dot.className    = locked ? 'dot-locked' : 'dot-unlocked';
  if (text) text.textContent = locked ? 'Vault Locked' : 'Vault Unlocked';
}

// ── Post-unlock ───────────────────────────────────────────────────────────

async function onUnlocked() {
  setStatus(false);
  showView('main');

  const listEl      = document.getElementById('sv-profile-list');
  const autofillBtn = document.getElementById('sv-autofill-btn');

  await uiBinding.bindCardsToUI(listEl, autofillBtn);

  // Side-panel extras
  injectSearchBar(listEl);
  injectAutoLockBar();
  resetAutoLock();

  // Register card-selection callback to reset idle timer
  uiBinding.onCardSelected(() => resetAutoLock());

  // Notify background
  chrome.runtime.sendMessage({
    type:    'vault_unlocked',
    payload: { autofillEnabled: true },
  }).catch(() => {});
}

// ── Background message listener ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {

    case 'VAULT_READY':
      // Payment page detected — show the active origin in the badge
      console.log('[side_panel_ui] VAULT_READY — origin:', msg.payload?.origin);
      injectSiteBadge(msg.payload?.origin);
      break;

    case 'VAULT_LOCKED':
      if (cancelAutoLock) cancelAutoLock();
      setStatus(true);
      showView('unlock');
      break;

    case 'VAULT_UNLOCKED':
      // Background relaying unlock confirmation (e.g. from another tab)
      if (!msg.payload?.locked) onUnlocked().catch(console.error);
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
    if (cancelAutoLock) cancelAutoLock();
    await lockFlow.lock();
    setStatus(true);
    showView('unlock');
  });

document.getElementById('sv-add-profile-btn')
  ?.addEventListener('click', () => {
    showView('addCard');
    padViewAdd.render();
    resetAutoLock();
  });

document.getElementById('sv-back-btn')
  ?.addEventListener('click', () => {
    showView('main');
    resetAutoLock();
  });

document.getElementById('sv-save-card-btn')
  ?.addEventListener('click', async () => {
    await uiBinding.saveCurrentCard(shadowRoot);
    showView('main');
    const listEl      = document.getElementById('sv-profile-list');
    const autofillBtn = document.getElementById('sv-autofill-btn');
    await uiBinding.bindCardsToUI(listEl, autofillBtn);
    injectSearchBar(listEl);
    resetAutoLock();
  });

// ── Boot ──────────────────────────────────────────────────────────────────

async function boot() {
  noiseLayer.start();
  padViewMain.render();

  // Query the currently active tab to pre-populate the site badge
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const origin = new URL(tab.url).origin;
      injectSiteBadge(origin);
    }
  } catch {
    injectSiteBadge(null);
  }

  const locked = await model.isLocked();
  setStatus(locked);
  showView(locked ? 'unlock' : 'main');

  if (!locked) {
    // Vault already unlocked (e.g. side panel reopened mid-session)
    await onUnlocked();
  }
}

boot();