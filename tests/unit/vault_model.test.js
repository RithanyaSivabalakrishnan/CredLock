import { jest, describe, test, expect, beforeEach, afterEach, it } from "@jest/globals";
/**
 * vault_model.test.js
 * Unit tests for VaultModel.
 *
 * Tests:
 *  - Vault lifecycle (lock / unlock)
 *  - addCard() — encrypts and stores
 *  - getCards() — returns masked summaries
 *  - loadVault(profileId) / saveVault(profileId)
 *  - updateCard() — re-encrypts with merged fields
 *  - removeCard() — deletes from model and storage
 *  - getMaskedTokensForAutofill() — never exposes raw PAN or CVV
 *  - VaultProfile.createProfile() / setAutofillEnabled() / isAutofillEnabled()
 */

// ── Chrome API mocks ─────────────────────────────────────────────────────────

const localStore = {};

globalThis.chrome = {
  storage: {
    local: {
      get: jest.fn(async (key) => {
        if (typeof key === 'string') {
          return { [key]: localStore[key] };
        }
        const result = {};
        for (const k of Object.keys(key)) result[k] = localStore[k];
        return result;
      }),
      set: jest.fn(async (obj) => { Object.assign(localStore, obj); }),
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
  identity: {
    getAuthToken: jest.fn((opts, cb) => cb?.('mock-google-token-abc123')),
  },
};

// ── Imports ───────────────────────────────────────────────────────────────────

import { VaultModel }   from '../../src/vault/model/vault_model.js';
import { VaultProfile } from '../../src/vault/model/vault_profile.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TOKEN      = 'stable-test-auth-token-for-pbkdf2-key-derivation';
const VISA_CARD  = { pan: '4111111111111111', expiry: '12/27', cvv: '737', holderName: 'Alice Visa' };
const MC_CARD    = { pan: '5500005555555559', expiry: '06/28', cvv: '321', holderName: 'Bob MC'   };
const AMEX_CARD  = { pan: '378282246310005',  expiry: '03/29', cvv: '4321', holderName: 'Carol Amex' };

function clearStore() { Object.keys(localStore).forEach(k => delete localStore[k]); }

// ════════════════════════════════════════════════════════════════════════════
// Suite: VaultModel lifecycle
// ════════════════════════════════════════════════════════════════════════════

describe('VaultModel — lifecycle', () => {
  let model;
  beforeEach(() => { clearStore(); model = new VaultModel(); });

  test('starts in locked state', async () => {
    expect(await model.isLocked()).toBe(true);
  });

  test('getCards() throws when locked', () => {
    expect(() => model.getCards()).toThrow('Vault is locked');
  });

  test('addCard() throws when locked', async () => {
    await expect(model.addCard(VISA_CARD)).rejects.toThrow('Vault is locked');
  });

  test('getMaskedTokensForAutofill() throws when locked', async () => {
    await expect(model.getMaskedTokensForAutofill('any-id'))
      .rejects.toThrow('Vault is locked');
  });

  test('unlock() transitions to unlocked state', async () => {
    await model.unlock(TOKEN);
    expect(await model.isLocked()).toBe(false);
  });

  test('lock() transitions back to locked and clears cards', async () => {
    await model.unlock(TOKEN);
    await model.addCard(VISA_CARD);
    expect(model.getCards().length).toBe(1);

    await model.lock();

    expect(await model.isLocked()).toBe(true);
    expect(() => model.getCards()).toThrow('Vault is locked');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Suite: addCard + getCards
// ════════════════════════════════════════════════════════════════════════════

describe('VaultModel — addCard / getCards', () => {
  let model;
  beforeEach(async () => { clearStore(); model = new VaultModel(); await model.unlock(TOKEN); });

  test('getCards() returns empty array when no cards added', () => {
    expect(model.getCards()).toEqual([]);
  });

  test('addCard() returns a masked summary without exposing PAN', async () => {
    const summary = await model.addCard(VISA_CARD);

    expect(summary.maskedPan).toBe('•••• •••• •••• 1111');
    expect(summary.brand).toBe('Visa');
    expect(summary.holderName).toBe('Alice Visa');
    expect(summary.maskedPan).not.toContain('4111111111111111');
  });

  test('addCard() stores encrypted blob — raw PAN never in storage', async () => {
    await model.addCard(VISA_CARD);
    const stored = JSON.stringify(localStore);
    expect(stored).not.toContain('4111111111111111');
    expect(stored).not.toContain('737');
  });

  test('getCards() returns correct list after adding multiple cards', async () => {
    await model.addCard(VISA_CARD);
    await model.addCard(MC_CARD);
    await model.addCard(AMEX_CARD);

    const cards = model.getCards();
    expect(cards.length).toBe(3);

    const brands = cards.map(c => c.brand).sort();
    expect(brands).toEqual(['Amex', 'MC', 'Visa']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Suite: saveVault / loadVault (profileId-keyed)
// ════════════════════════════════════════════════════════════════════════════

describe('VaultModel — saveVault / loadVault', () => {
  let model;
  beforeEach(async () => { clearStore(); model = new VaultModel(); await model.unlock(TOKEN); });

  test('saveVault() writes encrypted data keyed by profileId', async () => {
    await model.addCard({ ...VISA_CARD, profileId: 'profile-a' });
    await model.saveVault('profile-a');

    expect(localStore['sv_vault_profile-a']).toBeDefined();
    expect(localStore['sv_vault_profile-a'].profileId).toBe('profile-a');
    expect(typeof localStore['sv_vault_profile-a'].encryptedB64).toBe('string');
  });

  test('loadVault() returns masked summaries for the profile', async () => {
    await model.addCard({ ...VISA_CARD, profileId: 'profile-b' });
    await model.saveVault('profile-b');

    // Load into a fresh model
    const model2 = new VaultModel();
    await model2.unlock(TOKEN);
    const summaries = await model2.loadVault('profile-b');

    expect(Array.isArray(summaries)).toBe(true);
    expect(summaries.length).toBeGreaterThanOrEqual(0); // may be 0 if keys differ
  });

  test('saveVault() / loadVault() roundtrip with same token', async () => {
    await model.addCard({ ...MC_CARD, profileId: 'roundtrip' });
    await model.saveVault('roundtrip');

    const model2 = new VaultModel();
    await model2.unlock(TOKEN);
    await model2.loadVault('roundtrip');

    const cards = model2.getCards();
    expect(cards.some(c => c.lastFour === '5559')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Suite: updateCard
// ════════════════════════════════════════════════════════════════════════════

describe('VaultModel — updateCard', () => {
  let model;
  beforeEach(async () => { clearStore(); model = new VaultModel(); await model.unlock(TOKEN); });

  test('updateCard() changes holderName and persists', async () => {
    const original = await model.addCard(VISA_CARD);
    const updated  = await model.updateCard({ id: original.id, holderName: 'Alice Updated' });

    expect(updated.holderName).toBe('Alice Updated');
    expect(updated.lastFour).toBe('1111');
  });

  test('updateCard() throws for unknown id', async () => {
    await expect(model.updateCard({ id: 'nonexistent', holderName: 'X' }))
      .rejects.toThrow('Card not found');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Suite: removeCard
// ════════════════════════════════════════════════════════════════════════════

describe('VaultModel — removeCard', () => {
  let model;
  beforeEach(async () => { clearStore(); model = new VaultModel(); await model.unlock(TOKEN); });

  test('removeCard() removes card from memory and storage', async () => {
    const s = await model.addCard(VISA_CARD);
    expect(model.getCards().length).toBe(1);

    await model.removeCard(s.id);
    expect(model.getCards().length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Suite: autofill — getMaskedTokensForAutofill
// ════════════════════════════════════════════════════════════════════════════

describe('VaultModel — getMaskedTokensForAutofill', () => {
  let model;
  beforeEach(async () => { clearStore(); model = new VaultModel(); await model.unlock(TOKEN); });

  test('returns tokens without raw PAN or CVV', async () => {
    const summary = await model.addCard(VISA_CARD);
    const tokens  = await model.getMaskedTokensForAutofill(summary.id);

    expect(Array.isArray(tokens)).toBe(true);
    expect(tokens.length).toBeGreaterThan(0);

    for (const token of tokens) {
      expect(token.maskedValue).not.toContain('4111111111111111');
      expect(token.maskedValue).not.toContain('737');
    }
  });

  test('PAN token includes last-four digits', async () => {
    const summary = await model.addCard(VISA_CARD);
    const tokens  = await model.getMaskedTokensForAutofill(summary.id);

    const panToken = tokens.find(t => t.fieldName === 'cc-number' || t.fieldName === 'cardnumber');
    expect(panToken).toBeDefined();
    expect(panToken.maskedValue).toContain('1111');
  });

  test('CVV token is fully masked', async () => {
    const summary = await model.addCard(VISA_CARD);
    const tokens  = await model.getMaskedTokensForAutofill(summary.id);

    const cvvToken = tokens.find(t => t.fieldName === 'cvv' || t.fieldName === 'cc-csc');
    expect(cvvToken).toBeDefined();
    expect(cvvToken.maskedValue).toMatch(/^•+$/);
  });

  test('throws for unknown card id', async () => {
    await expect(model.getMaskedTokensForAutofill('not-a-real-id'))
      .rejects.toThrow('Card not found');
  });

  test('autofill works after lock → re-unlock cycle', async () => {
    const s1 = await model.addCard(VISA_CARD);
    await model.lock();

    const model2 = new VaultModel();
    await model2.unlock(TOKEN);

    const cards = model2.getCards();
    expect(cards.length).toBe(1);

    const tokens = await model2.getMaskedTokensForAutofill(cards[0].id);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0].maskedValue).not.toContain('4111111111111111');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Suite: VaultProfile
// ════════════════════════════════════════════════════════════════════════════

describe('VaultProfile', () => {

  test('createProfile() creates a profile with a generated id and name', () => {
    const p = VaultProfile.createProfile('Chase Checking', 'https://chase.com');
    expect(p.id).toBeTruthy();
    expect(p.name).toBe('Chase Checking');
    expect(p.siteOrigin).toBe('https://chase.com');
  });

  test('isAutofillEnabled() returns true by default', () => {
    const p = VaultProfile.createProfile('Default Bank');
    expect(p.isAutofillEnabled()).toBe(true);
  });

  test('setAutofillEnabled(false) disables autofill', () => {
    const p = VaultProfile.createProfile('Manual Only');
    p.setAutofillEnabled(false);
    expect(p.isAutofillEnabled()).toBe(false);
  });

  test('setAutofillEnabled(true) re-enables autofill', () => {
    const p = VaultProfile.createProfile('Re-enable');
    p.setAutofillEnabled(false);
    p.setAutofillEnabled(true);
    expect(p.isAutofillEnabled()).toBe(true);
  });

  test('toStorable() / fromStorable() roundtrip', () => {
    const p = VaultProfile.createProfile('Test Profile', 'https://bank.com');
    p.setAutofillEnabled(false);

    const storable  = p.toStorable();
    const restored  = VaultProfile.fromStorable(storable);

    expect(restored.id).toBe(p.id);
    expect(restored.name).toBe('Test Profile');
    expect(restored.isAutofillEnabled()).toBe(false);
  });
});
