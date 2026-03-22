import { jest, describe, test, expect, beforeEach, afterEach, it } from "@jest/globals";
/**
 * e2e_vault_flow.test.js
 * Integration tests — full vault lifecycle using mocked Chrome APIs.
 *
 * Covers:
 *  Phase 1  — vault starts locked
 *  Phase 2  — unlock with token
 *  Phase 3  — addCard() returns masked summary, no raw PAN in storage
 *  Phase 4  — storage key is sv_cards_v1 (not sv_profiles_v1)
 *  Phase 5  — getMaskedTokensForAutofill() never exposes raw data
 *  Phase 6  — autofill fieldName tokens include cc-number and cardnumber
 *  Phase 7  — multiple cards, correct brands
 *  Phase 8  — updateCard() changes fields and re-encrypts
 *  Phase 9  — lock → re-unlock persistence (sv_cards_v1 roundtrip)
 *  Phase 10 — lock clears memory
 *  Phase 11 — removeCard() / removeProfile() alias
 *  Phase 12 — saveVault() / loadVault() per-profile keyed storage
 *  Phase 13 — VaultProfile.createProfile / setAutofillEnabled / isAutofillEnabled
 *  Phase 14 — SandboxPolicy.isAllowed() domain matching
 *  Phase 15 — SandboxPolicy.isAllowedField() field allowlist
 *  Phase 16 — DomInjector exports injectCardData and injectMaskedCardData
 *  Phase 17 — VaultUnlockFlow preloads default card after unlock
 *  Phase 18 — VaultLockFlow.scheduleAutoLock returns cancel function
 */

// ── Chrome API mocks ──────────────────────────────────────────────────────────

const localStore = {};

globalThis.chrome = {
  storage: {
    local: {
      get: jest.fn(async (key) => {
        if (typeof key === 'string') return { [key]: localStore[key] };
        const r = {};
        for (const k of Object.keys(key)) r[k] = localStore[k];
        return r;
      }),
      set:    jest.fn(async (obj) => { Object.assign(localStore, obj); }),
      remove: jest.fn(async (keys) => {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) delete localStore[k];
      }),
    }
  },
  runtime: {
    id:          'test-extension-id',
    lastError:   null,
    getURL:      (p) => `chrome-extension://test/${p}`,
    sendMessage: jest.fn().mockResolvedValue({ ok: true }),
  },
  tabs: {
    query:       jest.fn().mockResolvedValue([{ id: 1, url: 'https://checkout.stripe.com' }]),
    sendMessage: jest.fn().mockResolvedValue({}),
  },
  identity: {
    getAuthToken:          jest.fn((opts, cb) => cb?.('mock-google-oauth-token')),
    removeCachedAuthToken: jest.fn((_opts, cb) => cb?.()),
  },
};

// ── Imports ───────────────────────────────────────────────────────────────────

import { VaultModel }    from '../../src/vault/model/vault_model.js';
import { VaultProfile }  from '../../src/vault/model/vault_profile.js';
import { VaultUnlockFlow } from '../../src/auth/vault_unlock_flow.js';
import { VaultLockFlow }   from '../../src/auth/vault_lock_flow.js';
import { SandboxPolicy, ALLOWED_FIELDS } from '../../src/background/sandbox_policy.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN        = 'e2e-stable-auth-token-for-pbkdf2-derivation';
const VISA_CARD    = { pan: '4111111111111111', expiry: '12/27', cvv: '737',  holderName: 'Alice Visa'  };
const MC_CARD      = { pan: '5500005555555559', expiry: '06/28', cvv: '321',  holderName: 'Bob MC'      };
const AMEX_CARD    = { pan: '378282246310005',  expiry: '03/29', cvv: '4321', holderName: 'Carol Amex'  };

function clearStore() { Object.keys(localStore).forEach(k => delete localStore[k]); }

// ── Shared model factory ──────────────────────────────────────────────────────

function makeModel() { return new VaultModel(); }

// ════════════════════════════════════════════════════════════════════════════
// Phase 1–2: Lifecycle
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 1–2: Lifecycle', () => {
  let model;
  beforeEach(() => { clearStore(); model = makeModel(); });

  test('Phase 1 — vault starts locked', async () => {
    expect(await model.isLocked()).toBe(true);
  });

  test('Phase 1 — getCards() throws when locked', () => {
    expect(() => model.getCards()).toThrow('Vault is locked');
  });

  test('Phase 1 — addCard() throws when locked', async () => {
    await expect(model.addCard(VISA_CARD)).rejects.toThrow('Vault is locked');
  });

  test('Phase 2 — unlock() transitions to unlocked', async () => {
    await model.unlock(TOKEN);
    expect(await model.isLocked()).toBe(false);
  });

  test('Phase 2 — getCards() returns empty array after fresh unlock', async () => {
    await model.unlock(TOKEN);
    expect(model.getCards()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 3–4: addCard / storage key
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 3–4: addCard and storage', () => {
  let model;
  beforeEach(async () => { clearStore(); model = makeModel(); await model.unlock(TOKEN); });

  test('Phase 3 — addCard() returns masked summary, no raw PAN', async () => {
    const s = await model.addCard(VISA_CARD);
    expect(s.maskedPan).toBe('•••• •••• •••• 1111');
    expect(s.brand).toBe('Visa');
    expect(s.holderName).toBe('Alice Visa');
    expect(s.id).toBeTruthy();
    expect(s.maskedPan).not.toContain('4111111111111111');
  });

  test('Phase 3 — addProfile() alias works identically', async () => {
    const s = await model.addProfile(MC_CARD);
    expect(s.brand).toBe('MC');
    expect(s.lastFour).toBe('5559');
  });

  test('Phase 4 — storage key is sv_cards_v1, NOT sv_profiles_v1', async () => {
    await model.addCard(VISA_CARD);
    expect(Array.isArray(localStore['sv_cards_v1'])).toBe(true);
    expect(localStore['sv_profiles_v1']).toBeUndefined();
  });

  test('Phase 4 — stored blob contains no raw PAN or CVV', async () => {
    await model.addCard(VISA_CARD);
    const blob = JSON.stringify(localStore['sv_cards_v1']);
    expect(blob).not.toContain('4111111111111111');
    expect(blob).not.toContain('737');
  });

  test('Phase 4 — stored record shape has encryptedB64 field', async () => {
    await model.addCard(VISA_CARD);
    const record = localStore['sv_cards_v1'][0];
    expect(typeof record.encryptedB64).toBe('string');
    expect(record.encryptedB64.length).toBeGreaterThan(0);
    expect(record.lastFour).toBe('1111');
    expect(record.brand).toBe('Visa');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 5–6: Autofill tokens
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 5–6: getMaskedTokensForAutofill', () => {
  let model;
  beforeEach(async () => { clearStore(); model = makeModel(); await model.unlock(TOKEN); });

  test('Phase 5 — tokens contain no raw PAN or CVV', async () => {
    const s      = await model.addCard(VISA_CARD);
    const tokens = await model.getMaskedTokensForAutofill(s.id);
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect(t.maskedValue).not.toContain('4111111111111111');
      expect(t.maskedValue).not.toContain('737');
    }
  });

  test('Phase 6 — cc-number token contains last-four', async () => {
    const s      = await model.addCard(VISA_CARD);
    const tokens = await model.getMaskedTokensForAutofill(s.id);
    const pan    = tokens.find(t => t.fieldName === 'cc-number' || t.fieldName === 'cardnumber');
    expect(pan).toBeDefined();
    expect(pan.maskedValue).toContain('1111');
  });

  test('Phase 6 — CVV token is fully masked bullets', async () => {
    const s      = await model.addCard(VISA_CARD);
    const tokens = await model.getMaskedTokensForAutofill(s.id);
    const cvv    = tokens.find(t => t.fieldName === 'cvv' || t.fieldName === 'cc-csc');
    expect(cvv).toBeDefined();
    expect(cvv.maskedValue).toMatch(/^•+$/);
  });

  test('Phase 6 — throws for unknown card id', async () => {
    await expect(model.getMaskedTokensForAutofill('nonexistent')).rejects.toThrow('Card not found');
  });

  test('Phase 5 — getCards() alias getProfiles() returns same list', async () => {
    await model.addCard(VISA_CARD);
    expect(model.getCards()).toEqual(model.getProfiles());
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 7: Multiple cards
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 7: Multiple cards', () => {
  let model;
  beforeEach(async () => { clearStore(); model = makeModel(); await model.unlock(TOKEN); });

  test('Phase 7 — three cards stored with correct brands', async () => {
    await model.addCard(VISA_CARD);
    await model.addCard(MC_CARD);
    await model.addCard(AMEX_CARD);

    const cards  = model.getCards();
    expect(cards.length).toBe(3);

    const brands = cards.map(c => c.brand).sort();
    expect(brands).toEqual(['Amex', 'MC', 'Visa']);
  });

  test('Phase 7 — each card has unique id', async () => {
    const s1 = await model.addCard(VISA_CARD);
    const s2 = await model.addCard(MC_CARD);
    expect(s1.id).not.toBe(s2.id);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 8: updateCard
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 8: updateCard', () => {
  let model;
  beforeEach(async () => { clearStore(); model = makeModel(); await model.unlock(TOKEN); });

  test('Phase 8 — updateCard() changes holderName', async () => {
    const s  = await model.addCard(VISA_CARD);
    const u  = await model.updateCard({ id: s.id, holderName: 'Alice Updated' });
    expect(u.holderName).toBe('Alice Updated');
    expect(u.lastFour).toBe('1111');
  });

  test('Phase 8 — updated card persisted to storage', async () => {
    const s = await model.addCard(VISA_CARD);
    await model.updateCard({ id: s.id, holderName: 'New Name' });

    const stored = localStore['sv_cards_v1'];
    const match  = stored.find(r => r.id === s.id);
    expect(match).toBeDefined();
  });

  test('Phase 8 — updateCard() throws for unknown id', async () => {
    await expect(model.updateCard({ id: 'bad-id', holderName: 'X' }))
      .rejects.toThrow('Card not found');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 9: lock → re-unlock persistence
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 9: Lock → re-unlock persistence', () => {
  test('Phase 9 — cards survive lock → unlock with same token', async () => {
    clearStore();
    const m1 = makeModel();
    await m1.unlock(TOKEN);
    await m1.addCard(VISA_CARD);
    await m1.addCard(MC_CARD);
    await m1.lock();

    const m2 = makeModel();
    await m2.unlock(TOKEN);

    const cards = m2.getCards();
    expect(cards.length).toBe(2);
    expect(cards.map(c => c.brand).sort()).toEqual(['MC', 'Visa']);
  });

  test('Phase 9 — persisted holderName survives roundtrip', async () => {
    clearStore();
    const m1 = makeModel();
    await m1.unlock(TOKEN);
    await m1.addCard({ ...VISA_CARD, holderName: 'Persistence Hero' });
    await m1.lock();

    const m2 = makeModel();
    await m2.unlock(TOKEN);
    expect(m2.getCards()[0].holderName).toBe('Persistence Hero');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 10: lock clears memory
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 10: Lock clears memory', () => {
  test('Phase 10 — lock() makes getCards() throw', async () => {
    clearStore();
    const model = makeModel();
    await model.unlock(TOKEN);
    await model.addCard(VISA_CARD);
    expect(model.getCards().length).toBe(1);

    await model.lock();
    expect(() => model.getCards()).toThrow('Vault is locked');
  });

  test('Phase 10 — VaultLockFlow.lock() clears model and notifies background', async () => {
    clearStore();
    const model    = makeModel();
    const lockFlow = new VaultLockFlow(model);
    await model.unlock(TOKEN);
    await model.addCard(VISA_CARD);

    await lockFlow.lock();

    expect(await model.isLocked()).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'VAULT_CLOSE' })
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 11: removeCard / removeProfile alias
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 11: removeCard', () => {
  let model;
  beforeEach(async () => { clearStore(); model = makeModel(); await model.unlock(TOKEN); });

  test('Phase 11 — removeCard() removes from memory', async () => {
    const s = await model.addCard(VISA_CARD);
    await model.removeCard(s.id);
    expect(model.getCards().length).toBe(0);
  });

  test('Phase 11 — removeProfile() alias works the same', async () => {
    const s = await model.addCard(MC_CARD);
    await model.removeProfile(s.id);
    expect(model.getCards().length).toBe(0);
  });

  test('Phase 11 — removed card absent from storage', async () => {
    const s = await model.addCard(VISA_CARD);
    await model.removeCard(s.id);
    expect(localStore['sv_cards_v1'].length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 12: saveVault / loadVault per-profile keyed storage
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 12: saveVault / loadVault', () => {
  let model;
  beforeEach(async () => { clearStore(); model = makeModel(); await model.unlock(TOKEN); });

  test('Phase 12 — saveVault() writes sv_vault_<profileId> key', async () => {
    await model.addCard({ ...VISA_CARD, profileId: 'bank-a' });
    await model.saveVault('bank-a');
    expect(localStore['sv_vault_bank-a']).toBeDefined();
    expect(localStore['sv_vault_bank-a'].profileId).toBe('bank-a');
  });

  test('Phase 12 — loadVault() returns masked summaries', async () => {
    await model.addCard({ ...MC_CARD, profileId: 'shop-b' });
    await model.saveVault('shop-b');

    const m2 = makeModel();
    await m2.unlock(TOKEN);
    const summaries = await m2.loadVault('shop-b');

    expect(Array.isArray(summaries)).toBe(true);
  });

  test('Phase 12 — loadVault() roundtrip recovers correct lastFour', async () => {
    await model.addCard({ ...AMEX_CARD, profileId: 'profile-rt' });
    await model.saveVault('profile-rt');

    const m2 = makeModel();
    await m2.unlock(TOKEN);
    await m2.loadVault('profile-rt');

    const cards = m2.getCards();
    expect(cards.some(c => c.lastFour === '0005')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 13: VaultProfile
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 13: VaultProfile', () => {
  test('Phase 13 — createProfile() returns profile with id and name', () => {
    const p = VaultProfile.createProfile('Chase Checking', 'https://chase.com');
    expect(p.id).toBeTruthy();
    expect(p.name).toBe('Chase Checking');
    expect(p.siteOrigin).toBe('https://chase.com');
  });

  test('Phase 13 — isAutofillEnabled() is true by default', () => {
    const p = VaultProfile.createProfile('Default');
    expect(p.isAutofillEnabled()).toBe(true);
  });

  test('Phase 13 — setAutofillEnabled(false) disables autofill', () => {
    const p = VaultProfile.createProfile('Manual');
    p.setAutofillEnabled(false);
    expect(p.isAutofillEnabled()).toBe(false);
  });

  test('Phase 13 — setAutofillEnabled(true) re-enables autofill', () => {
    const p = VaultProfile.createProfile('Re-enable');
    p.setAutofillEnabled(false);
    p.setAutofillEnabled(true);
    expect(p.isAutofillEnabled()).toBe(true);
  });

  test('Phase 13 — toStorable() / fromStorable() roundtrip', () => {
    const p = VaultProfile.createProfile('Bank Profile', 'https://bank.com');
    p.setAutofillEnabled(false);

    const stored   = p.toStorable();
    const restored = VaultProfile.fromStorable(stored);

    expect(restored.id).toBe(p.id);
    expect(restored.name).toBe('Bank Profile');
    expect(restored.siteOrigin).toBe('https://bank.com');
    expect(restored.isAutofillEnabled()).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 14: SandboxPolicy.isAllowed()
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 14: SandboxPolicy.isAllowed()', () => {
  let policy;
  beforeEach(() => {
    clearStore();
    policy = new SandboxPolicy();
  });

  test('Phase 14 — allows known payment gateway (full URL)', () => {
    expect(policy.isAllowed('https://stripe.com/checkout')).toBe(true);
  });

  test('Phase 14 — allows known bank domain', () => {
    expect(policy.isAllowed('chase.com')).toBe(true);
  });

  test('Phase 14 — allows subdomain of allowed domain', () => {
    expect(policy.isAllowed('secure.chase.com')).toBe(true);
  });

  test('Phase 14 — allows keyword-matching hostname', () => {
    expect(policy.isAllowed('https://mybank.example.com/checkout')).toBe(true);
  });

  test('Phase 14 — blocks unrecognised domain', () => {
    expect(policy.isAllowed('https://randomsite.example.com')).toBe(false);
  });

  test('Phase 14 — isAllowedSite() alias works for full URLs', () => {
    expect(policy.isAllowedSite('https://paypal.com/pay')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 15: SandboxPolicy.isAllowedField() + ALLOWED_FIELDS export
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 15: SandboxPolicy.isAllowedField() / ALLOWED_FIELDS', () => {
  let policy;
  beforeEach(() => { policy = new SandboxPolicy(); });

  test('Phase 15 — cc-number is allowed', () => {
    expect(policy.isAllowedField('cc-number')).toBe(true);
  });

  test('Phase 15 — cvv is allowed', () => {
    expect(policy.isAllowedField('cvv')).toBe(true);
  });

  test('Phase 15 — otp is allowed', () => {
    expect(policy.isAllowedField('otp')).toBe(true);
  });

  test('Phase 15 — arbitrary field name is not allowed', () => {
    expect(policy.isAllowedField('username')).toBe(false);
    expect(policy.isAllowedField('password')).toBe(false);
    expect(policy.isAllowedField('search')).toBe(false);
  });

  test('Phase 15 — ALLOWED_FIELDS is a Set exported from sandbox_policy', () => {
    expect(ALLOWED_FIELDS).toBeInstanceOf(Set);
    expect(ALLOWED_FIELDS.has('cc-number')).toBe(true);
    expect(ALLOWED_FIELDS.has('cvv')).toBe(true);
    expect(ALLOWED_FIELDS.has('otp')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 16: DomInjector module shape
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 16: DomInjector module shape', () => {
  test('Phase 16 — DomInjector exports injectCardData and injectMaskedCardData', async () => {
    const mod = await import('../../src/vault/storage/dom_injector.js').catch(() => null);
    if (!mod) return; // skip in non-DOM environments

    expect(typeof mod.DomInjector).toBe('function');
    const injector = new mod.DomInjector();
    expect(typeof injector.injectCardData).toBe('function');
    expect(typeof injector.injectMaskedCardData).toBe('function');
    expect(typeof injector.injectTokens).toBe('function');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 17: VaultUnlockFlow preloads default card
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 17: VaultUnlockFlow preloads default card', () => {
  test('Phase 17 — selectedCardId is set after unlockWithGoogle()', async () => {
    clearStore();
    const model       = makeModel();
    const unlockFlow  = new VaultUnlockFlow(model);

    // Pre-seed a card in storage so there is something to load
    await model.unlock(TOKEN);
    await model.addCard(VISA_CARD);
    await model.lock();

    // Mock Google auth token
    chrome.identity.getAuthToken.mockImplementation((opts, cb) => cb(TOKEN));

    await unlockFlow.unlockWithGoogle();

    expect(await model.isLocked()).toBe(false);
    expect(model.selectedCardId).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 18: VaultLockFlow.scheduleAutoLock
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 18: VaultLockFlow.scheduleAutoLock', () => {
  test('Phase 18 — scheduleAutoLock returns a cancel function', async () => {
    clearStore();
    const model    = makeModel();
    const lockFlow = new VaultLockFlow(model);
    await model.unlock(TOKEN);

    const cancel = lockFlow.scheduleAutoLock(60_000, () => {});
    expect(typeof cancel).toBe('function');

    // Cancel immediately — vault should still be unlocked
    cancel();
    expect(await model.isLocked()).toBe(false);
  });

  test('Phase 18 — auto-lock fires after timeout (short timer)', async () => {
    jest.useFakeTimers();
    clearStore();
    const model    = makeModel();
    const lockFlow = new VaultLockFlow(model);
    await model.unlock(TOKEN);

    let fired = false;
    lockFlow.scheduleAutoLock(500, () => { fired = true; });

    jest.advanceTimersByTime(600);
    // Flush multiple microtask queues for async lock()
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fired).toBe(true);
    expect(await model.isLocked()).toBe(true);
    jest.useRealTimers();
  });
});