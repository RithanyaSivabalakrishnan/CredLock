/**
 * dist/background.js
 * SecureVault — Bundled Background Service Worker
 *
 * This is the single entry point loaded by Chrome as the service worker.
 * It inlines the core logic from:
 *   src/background/extension_main.js
 *   src/background/extension_host.js
 *   src/background/sandbox_policy.js
 *   src/auth/vault_unlock_flow.js  (unlock/lock messages)
 *   src/vault/storage/vault_storage.js  (credential CRUD)
 *   src/crypto/webcrypto_key_manager.js (key derivation)
 *
 * All ES module imports are resolved here so Chrome's service worker
 * (which does support type:module) has one clean entry point.
 */

// ── Inline SandboxPolicy ────────────────────────────────────────────────────

const DEFAULT_ALLOWED_DOMAINS = new Set([
  'chase.com','bankofamerica.com','wellsfargo.com','citibank.com',
  'usbank.com','capitalone.com','hsbc.com','barclays.co.uk',
  'sbi.co.in','hdfcbank.com','icicibank.com','axisbank.com',
  'stripe.com','paypal.com','razorpay.com','payu.com',
  'squareup.com','checkout.com','adyen.com','klarna.com',
  'amazon.com','amazon.in','flipkart.com','shopify.com','ebay.com',
]);

const HOSTNAME_PATTERNS = ['bank','checkout','payment','pay','wallet','finance','secure'];

function extractHostname(input) {
  try {
    const url = input.startsWith('http') ? new URL(input) : new URL('https://' + input);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return input.toLowerCase().replace(/^www\./, ''); }
}

function isAllowedSite(domain) {
  if (!domain) return false;
  const h = extractHostname(domain);
  if (DEFAULT_ALLOWED_DOMAINS.has(h)) return true;
  for (const d of DEFAULT_ALLOWED_DOMAINS) {
    if (h.endsWith('.' + d)) return true;
  }
  return HOSTNAME_PATTERNS.some(p => h.includes(p));
}

// ── Crypto — WebCrypto key manager ──────────────────────────────────────────

const PBKDF2_ITERS    = 200_000;
const SALT_STORAGE_KEY = 'sv_pbkdf2_salt';

async function getOrCreateSalt() {
  const stored = await chrome.storage.local.get(SALT_STORAGE_KEY);
  if (stored[SALT_STORAGE_KEY]) {
    const bin = atob(stored[SALT_STORAGE_KEY]);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
  }
  const salt = crypto.getRandomValues(new Uint8Array(32));
  await chrome.storage.local.set({
    [SALT_STORAGE_KEY]: btoa(String.fromCharCode(...salt))
  });
  return salt;
}

async function deriveKeyFromToken(token) {
  const salt     = await getOrCreateSalt();
  const keyMat   = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(token),
    { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    keyMat,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
}

// ── In-memory vault ─────────────────────────────────────────────────────────

const IV_BYTES  = 12;
const VAULT_KEY = 'sv_cards_v1';

let _sessionKey = null;

function isUnlocked() { return _sessionKey !== null; }

async function unlockVault(token) {
  _sessionKey = await deriveKeyFromToken(token);
  console.log('[SecureVault] Vault unlocked');
}

function lockVault() {
  _sessionKey = null;
  console.log('[SecureVault] Vault locked');
}

async function svEncrypt(plaintext) {
  const iv       = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded  = new TextEncoder().encode(plaintext);
  const ct       = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, _sessionKey, encoded);
  const out      = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return btoa(String.fromCharCode(...out));
}

async function svDecrypt(b64) {
  const bin  = atob(b64);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const iv   = data.slice(0, IV_BYTES);
  const ct   = data.slice(IV_BYTES);
  const pt   = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, _sessionKey, ct);
  return new TextDecoder().decode(pt);
}

async function loadCards() {
  const stored = await chrome.storage.local.get(VAULT_KEY);
  const list   = stored[VAULT_KEY] ?? [];
  const cards  = [];
  for (const s of list) {
    try {
      const raw = JSON.parse(await svDecrypt(s.encryptedB64));
      cards.push({ ...s, _raw: raw });
    } catch { /* skip corrupt */ }
  }
  return cards;
}

async function saveCards(cards) {
  const storables = [];
  for (const c of cards) {
    const enc = await svEncrypt(JSON.stringify(c._raw));
    storables.push({
      id: c.id, profileId: c.profileId ?? 'default',
      brand: c.brand, lastFour: c.lastFour,
      holderName: c.holderName, encryptedB64: enc,
    });
  }
  await chrome.storage.local.set({ [VAULT_KEY]: storables });
}

function detectBrand(pan) {
  const p = (pan ?? '').replace(/\s/g, '');
  if (/^4/.test(p))           return 'Visa';
  if (/^5[1-5]/.test(p))     return 'MC';
  if (/^3[47]/.test(p))      return 'Amex';
  if (/^6(?:011|5)/.test(p)) return 'Discover';
  return 'Card';
}

// ── Auto-lock ────────────────────────────────────────────────────────────────

const AUTO_LOCK_MS = 30 * 60 * 1000; // 30 minutes
let autoLockTimer  = null;

function resetAutoLock() {
  clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(() => {
    lockVault();
    broadcastToTabs({ type: 'VAULT_LOCKED' });
  }, AUTO_LOCK_MS);
}

// Keep-alive ping — prevents Chrome from killing the service worker
// while the user is actively using the extension
setInterval(() => {
  if (isUnlocked()) resetAutoLock();
}, 20000);

// ── Tab broadcast ────────────────────────────────────────────────────────────

async function broadcastToTabs(msg) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try { await chrome.tabs.sendMessage(tab.id, msg); } catch (_) {}
  }
}

// ── Session tracking (vault_requested sessions) ──────────────────────────────

const vaultSessions = new Map(); // tabId → session

// ── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const tabId = sender.tab?.id ?? null;

      switch (msg.type) {

        // ── Auth ──────────────────────────────────────────────────────────
        case 'VAULT_UNLOCK':
          await unlockVault(msg.token ?? msg.masterPassword ?? '');
          resetAutoLock();
          sendResponse({ ok: true });
          break;

        case 'vault_unlocked':
          // Sent by VaultUnlockFlow after Google/biometric auth
          if (tabId) {
            vaultSessions.set(tabId, {
              tabId, locked: false,
              autofillReady: msg.payload?.autofillEnabled ?? false,
            });
          }
          sendResponse({ ok: true });
          break;

        case 'VAULT_LOCK':
        case 'VAULT_CLOSE':
          lockVault();
          clearTimeout(autoLockTimer);
          if (tabId) vaultSessions.delete(tabId);
          broadcastToTabs({ type: 'VAULT_LOCKED' });
          sendResponse({ ok: true });
          break;

        case 'VAULT_STATUS':
          sendResponse({
            ok: true,
            unlocked: isUnlocked(),
            session:  vaultSessions.get(tabId) ?? null,
          });
          break;

        // ── Credentials ───────────────────────────────────────────────────
        case 'SAVE_CREDENTIAL': {
          if (!isUnlocked()) { sendResponse({ ok: false, reason: 'locked' }); break; }
          resetAutoLock();
          const { domain, username, password, pan, expiry, cvv, holderName } = msg.credential ?? msg;
          const cards = await loadCards();
          const id    = crypto.randomUUID();
          const raw   = password
            ? { password }
            : { pan: (pan ?? '').replace(/\s/g,''), expiry, cvv };
          const lastFour = raw.pan ? raw.pan.slice(-4) : '????';
          const brand    = detectBrand(raw.pan ?? '');
          const enc      = await svEncrypt(JSON.stringify(raw));
          cards.push({
            id, profileId: 'default',
            brand, lastFour,
            holderName: holderName ?? username ?? '',
            domain: domain ?? extractHostname(sender.tab?.url ?? ''),
            encryptedB64: enc, _raw: raw,
          });
          await saveCards(cards);
          sendResponse({ ok: true, id });
          break;
        }

        case 'LIST_CREDENTIALS': {
          if (!isUnlocked()) { sendResponse({ ok: true, list: [] }); break; }
          resetAutoLock();
          const all   = await loadCards();
          const domain = msg.domain ? extractHostname(msg.domain) : null;
          const list   = all
            .filter(c => !domain || extractHostname(c.domain ?? '') === domain)
            .map(({ id, domain, holderName, brand, lastFour, profileId }) =>
              ({ id, domain, username: holderName, brand, lastFour, profileId }));
          sendResponse({ ok: true, list });
          break;
        }

        case 'GET_CREDENTIAL': {
          if (!isUnlocked()) { sendResponse({ ok: false, reason: 'locked' }); break; }
          resetAutoLock();
          const all = await loadCards();
          const c   = all.find(x => x.id === msg.id ||
            (extractHostname(x.domain ?? '') === extractHostname(msg.domain ?? '') &&
             x.holderName === msg.username));
          if (!c) { sendResponse({ ok: false, reason: 'not_found' }); break; }
          sendResponse({ ok: true, credential: { ...c._raw, holderName: c.holderName } });
          break;
        }

        case 'DELETE_CREDENTIAL': {
          if (!isUnlocked()) { sendResponse({ ok: false, reason: 'locked' }); break; }
          resetAutoLock();
          const all = await loadCards();
          await saveCards(all.filter(c => c.id !== msg.id));
          sendResponse({ ok: true });
          break;
        }

        case 'AUTOFILL_REQUEST': {
          if (!isUnlocked()) { sendResponse({ ok: false, reason: 'locked' }); break; }
          resetAutoLock();
          const domain = extractHostname(sender.tab?.url ?? '');
          const all    = await loadCards();
          const match  = all.find(c => extractHostname(c.domain ?? '') === domain);
          if (!match) { sendResponse({ ok: false, reason: 'no_credentials' }); break; }
          // Return masked tokens for card autofill, or password for login autofill
          if (match._raw.password) {
            sendResponse({ ok: true, credential: {
              password: match._raw.password,
              username: match.holderName,
            }});
          } else {
            sendResponse({ ok: true, credential: {
              tokens: [
                { fieldName: 'cc-number',  maskedValue: `•••• •••• •••• ${match.lastFour}` },
                { fieldName: 'cardnumber', maskedValue: `•••• •••• •••• ${match.lastFour}` },
                { fieldName: 'cc-exp',     maskedValue: match._raw.expiry ?? '••/••' },
                { fieldName: 'cc-csc',     maskedValue: '•••' },
                { fieldName: 'cvv',        maskedValue: '•••' },
              ],
              holderName: match.holderName,
            }});
          }
          break;
        }

        // ── Vault sessions (from merchant content script) ─────────────────
        case 'vault_requested': {
          const { origin = '', fieldsFound = 0, hasSavedCards = false } = msg.payload ?? {};
          if (!isAllowedSite(origin)) {
            sendResponse({ ok: false, allowed: false, reason: 'origin_not_allowed' });
            break;
          }
          if (tabId) {
            vaultSessions.set(tabId, {
              tabId, origin, fieldsFound, hasSavedCards,
              locked: !isUnlocked(), autofillReady: false,
              openedAt: Date.now(),
            });
            chrome.tabs.sendMessage(tabId, { type: 'VAULT_READY' }).catch(() => {});
          }
          sendResponse({ ok: true, allowed: true });
          break;
        }

        case 'vault_data_filled':
          sendResponse({ ok: true });
          break;

        case 'MASKED_DATA_READY':
          if (tabId) {
            chrome.tabs.sendMessage(tabId, {
              type: 'INJECT_MASKED', payload: msg.payload,
            }).catch(() => {});
          }
          sendResponse({ ok: true });
          break;

        case 'SUSPICIOUS_ACTIVITY':
        case 'PASSWORD_INPUT':
          sendResponse({ ok: true });
          break;

        case 'CRYPTO_BACKEND':
          sendResponse({ ok: true, backend: 'webcrypto' });
          break;

        default:
          sendResponse({ ok: false, reason: 'unknown_message_type' });
      }
    } catch (err) {
      console.error('[SecureVault] Background error:', err);
      sendResponse({ ok: false, reason: err.message });
    }
  })();
  return true;
});

// ── Tab updates ──────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (!isAllowedSite(tab.url)) return;
  chrome.tabs.sendMessage(tabId, { type: 'VAULT_READY' }).catch(() => {});
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log('[SecureVault] Installed —', reason);
  broadcastToTabs({ type: 'VAULT_LOCKED' });
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[SecureVault] Startup — vault is locked');
  broadcastToTabs({ type: 'VAULT_LOCKED' });
});

chrome.runtime.onSuspend?.addListener(() => {
  lockVault();
});

// ── Side panel ───────────────────────────────────────────────────────────────

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

console.log('[SecureVault] Background service worker running');
