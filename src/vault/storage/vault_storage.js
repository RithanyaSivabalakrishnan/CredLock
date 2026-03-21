/**
 * vault_storage.js
 * OS analog: "Encrypted filesystem / block device"
 *
 * Persists encrypted vault data to chrome.storage.local.
 * All data written to storage is already encrypted — no plaintext
 * ever reaches this module's persistence layer.
 *
 * Exports:
 *   createVault(profileId)
 *   readVault(profileId, sessionKey, crypto)
 *   updateVault(profileId, encryptedData)
 *   deleteVault(profileId)
 *   readAllCards(sessionKey, crypto)
 *   saveAllCards(cards, sessionKey, crypto)
 *   writeVault(profileId, cards, sessionKey, crypto, encryptedData?)
 */

import { CardRecord }         from '../model/vault_profile.js';
import {
  VAULT_STORAGE_KEYS,
  VaultRecordSchema,
  EncryptedCardRecordSchema,
  validateRecord,
} from './vault_storage_schemas.js';

// Helper: build the per-profile storage key
const profileKey = (profileId) => `${VAULT_STORAGE_KEYS.VAULT}${profileId}`;

export class VaultStorage {

  // ── Per-profile vault CRUD ─────────────────────────────────────────────────

  /**
   * Initialises an empty vault record for a profile.
   * Idempotent — does nothing if the vault already exists.
   *
   * @param {string} profileId
   */
  async createVault(profileId) {
    const key     = profileKey(profileId);
    const existing = await chrome.storage.local.get(key);
    if (existing[key]) {
      console.log('[VaultStorage] createVault: vault already exists for', profileId);
      return;
    }

    const record = {
      profileId,
      encryptedB64: '',
      iv:           '',
      tag:          '',
      lastUsedSite: '',
      updatedAt:    Date.now(),
    };

    await chrome.storage.local.set({ [key]: record });
    console.log('[VaultStorage] createVault: created empty vault for', profileId);
  }

  /**
   * Reads the encrypted vault for a profileId and decrypts it into CardRecords.
   *
   * @param {string}     profileId
   * @param {CryptoKey}  sessionKey
   * @param {WasmCrypto} crypto
   * @returns {Promise<CardRecord[]>}
   */
  async readVault(profileId, sessionKey, crypto) {
    const key    = profileKey(profileId);
    const stored = await chrome.storage.local.get(key);
    const record = stored[key];

    if (!record || !record.encryptedB64) return [];

    try {
      const decrypted = await this.#decryptBlob(record.encryptedB64, sessionKey, crypto);
      const storables = JSON.parse(decrypted);
      return storables.map(s => CardRecord.fromStorable(s));
    } catch (err) {
      console.error('[VaultStorage] readVault decryption failed:', err.message);
      return [];
    }
  }

  /**
   * Encrypts a list of CardRecords and writes them to the per-profile slot.
   * If encryptedData (a pre-encrypted ArrayBuffer) is supplied it is written
   * directly, bypassing re-encryption.
   *
   * @param {string}        profileId
   * @param {CardRecord[]}  cards
   * @param {CryptoKey}     sessionKey
   * @param {WasmCrypto}    crypto
   * @param {ArrayBuffer|null} [encryptedData]
   */
  async updateVault(profileId, cards, sessionKey, crypto, encryptedData = null) {
    const key = profileKey(profileId);

    let encryptedB64;
    if (encryptedData) {
      encryptedB64 = this.#bufferToBase64(encryptedData);
    } else {
      const plaintext  = JSON.stringify(cards.map(c => c.toStorable()));
      const encrypted  = await crypto.encrypt(sessionKey, plaintext);
      encryptedB64     = this.#bufferToBase64(encrypted);
    }

    const record = {
      profileId,
      encryptedB64,
      iv:           '',   // IV is prepended inside encryptedB64
      tag:          '',   // tag is appended inside encryptedB64
      lastUsedSite: '',
      updatedAt:    Date.now(),
    };

    const { valid, errors } = validateRecord(record, VaultRecordSchema);
    if (!valid) console.warn('[VaultStorage] updateVault schema warnings:', errors);

    await chrome.storage.local.set({ [key]: record });
  }

  /**
   * Alias for updateVault — used by vault_model.saveVault().
   */
  async writeVault(profileId, cards, sessionKey, crypto, encryptedData = null) {
    return this.updateVault(profileId, cards, sessionKey, crypto, encryptedData);
  }

  /**
   * Removes all storage entries for a profileId.
   *
   * @param {string} profileId
   */
  async deleteVault(profileId) {
    await chrome.storage.local.remove(profileKey(profileId));
    console.log('[VaultStorage] deleteVault:', profileId);
  }

  // ── Flat card list (used by vault_model for the default profile) ───────────

  /**
   * Reads all cards from the flat sv_cards_v1 list.
   *
   * @param {CryptoKey}  sessionKey
   * @param {WasmCrypto} crypto
   * @returns {Promise<CardRecord[]>}
   */
  async readAllCards(sessionKey, crypto) {
    const stored  = await chrome.storage.local.get(VAULT_STORAGE_KEYS.ALL_CARDS);
    const storables = stored[VAULT_STORAGE_KEYS.ALL_CARDS];
    if (!Array.isArray(storables) || !storables.length) return [];

    const cards = [];
    for (const s of storables) {
      try {
        cards.push(CardRecord.fromStorable(s));
      } catch (err) {
        console.warn('[VaultStorage] Skipping corrupt card record:', err.message);
      }
    }
    return cards;
  }

  /**
   * Writes all cards to the flat sv_cards_v1 list.
   * Cards are already individually encrypted (via CardRecord.toStorable()).
   *
   * @param {CardRecord[]} cards
   * @param {CryptoKey}    _sessionKey  — reserved for future double-encryption
   * @param {WasmCrypto}   _crypto
   */
  async saveAllCards(cards, _sessionKey, _crypto) {
    const storables = cards.map(c => c.toStorable());
    await chrome.storage.local.set({ [VAULT_STORAGE_KEYS.ALL_CARDS]: storables });
  }

  // ── Legacy aliases (used by vault_model for backward compat) ─────────────

  async loadProfiles(sessionKey, crypto) {
    return this.readAllCards(sessionKey, crypto);
  }

  async saveProfiles(cards, sessionKey, crypto) {
    return this.saveAllCards(cards, sessionKey, crypto);
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  async updateMeta(fields = {}) {
    const stored  = await chrome.storage.local.get(VAULT_STORAGE_KEYS.META);
    const current = stored[VAULT_STORAGE_KEYS.META] ?? {
      version: 1, createdAt: Date.now(), lastUnlocked: 0, unlockCount: 0,
    };
    const updated = { ...current, ...fields };
    await chrome.storage.local.set({ [VAULT_STORAGE_KEYS.META]: updated });
  }

  async clearAll() {
    const keys = [
      VAULT_STORAGE_KEYS.ALL_CARDS,
      VAULT_STORAGE_KEYS.META,
      VAULT_STORAGE_KEYS.PROFILES,
    ];
    await chrome.storage.local.remove(keys);
  }

  async hasStoredData() {
    const result = await chrome.storage.local.get(VAULT_STORAGE_KEYS.ALL_CARDS);
    return Array.isArray(result[VAULT_STORAGE_KEYS.ALL_CARDS]) &&
           result[VAULT_STORAGE_KEYS.ALL_CARDS].length > 0;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  async #decryptBlob(b64, sessionKey, crypto) {
    const bin  = atob(b64);
    const buf  = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return crypto.decrypt(sessionKey, buf.buffer);
  }

  #bufferToBase64(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
  }
}