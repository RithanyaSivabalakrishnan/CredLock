/**
 * vault_model.js
 * OS analog: "Process memory / heap manager"
 *
 * In-memory model for the vault.  Exports:
 *   loadVault(profileId)
 *   saveVault(profileId, encryptedData)
 *   addCard(card)
 *   updateCard(card)
 *   getCards()
 *   unlock(authToken)
 *   lock()
 *   isLocked()
 *   getMaskedTokensForAutofill(cardId)
 */

import { WasmCrypto }          from '../../crypto/wasm_crypto.js';
import { WebCryptoKeyManager }  from '../../crypto/webcrypto_key_manager.js';
import { VaultStorage }         from '../storage/vault_storage.js';
import { CardRecord }           from './vault_profile.js';

export class VaultModel {
  #locked      = true;
  #cards       = [];         // CardRecord[]
  #sessionKey  = null;       // CryptoKey — never persisted
  #crypto      = new WasmCrypto();
  #keyMgr      = new WebCryptoKeyManager();
  #storage     = new VaultStorage();
  #selectedId  = null;

  // ── Lock state ─────────────────────────────────────────────────────────────

  async isLocked() { return this.#locked; }

  /**
   * Derives the session key from an auth token and loads saved cards.
   * @param {string} authToken — from Google Identity or biometric stub
   */
  async unlock(authToken) {
    await this.#crypto.init();
    this.#sessionKey = await this.#keyMgr.deriveKeyFromToken(authToken);
    this.#cards      = await this.#storage.readAllCards(this.#sessionKey, this.#crypto);
    this.#locked     = false;
    console.log('[VaultModel] Unlocked —', this.#cards.length, 'card(s)');
  }

  /** Zeros the session key and clears in-memory card data. */
  async lock() {
    this.#sessionKey = null;
    this.#cards      = [];
    this.#selectedId = null;
    this.#locked     = true;
    console.log('[VaultModel] Locked — memory cleared');
  }

  // ── Vault CRUD (profileId-keyed) ────────────────────────────────────────

  /**
   * Loads encrypted vault data for a specific profileId from storage
   * and decrypts it into the in-memory card list.
   *
   * @param {string} profileId
   */
  async loadVault(profileId) {
    if (this.#locked) throw new Error('Vault is locked');
    const records = await this.#storage.readVault(profileId, this.#sessionKey, this.#crypto);
    // Merge with existing cards, avoiding duplicates
    for (const r of records) {
      if (!this.#cards.find(c => c.id === r.id)) this.#cards.push(r);
    }
    console.log('[VaultModel] loadVault:', profileId, '—', records.length, 'card(s)');
    return records.map(c => c.toMaskedSummary());
  }

  /**
   * Encrypts the current in-memory card list and writes it to storage
   * under the given profileId.
   *
   * @param {string}        profileId
   * @param {ArrayBuffer}   [encryptedData]  — optional pre-encrypted blob;
   *                                           if omitted, re-encrypts current cards
   */
  async saveVault(profileId, encryptedData = null) {
    if (this.#locked) throw new Error('Vault is locked');
    const profileCards = this.#cards.filter(c => c.profileId === profileId);
    await this.#storage.writeVault(profileId, profileCards, this.#sessionKey, this.#crypto, encryptedData);
    console.log('[VaultModel] saveVault:', profileId);
  }

  // ── Card CRUD ─────────────────────────────────────────────────────────────

  /**
   * Encrypts a raw card object and adds it to the in-memory list.
   * Persists immediately.
   *
   * @param {{ pan, expiry, cvv, holderName, profileId? }} card
   * @returns {object} masked summary
   */
  async addCard(card) {
    if (this.#locked) throw new Error('Vault is locked');
    const record = await CardRecord.fromRaw(card, this.#sessionKey, this.#crypto);
    this.#cards.push(record);
    await this.#persistAll();
    return record.toMaskedSummary();
  }

  /**
   * Updates an existing card by id.  Re-encrypts and persists.
   *
   * @param {{ id: string, pan?, expiry?, cvv?, holderName?, profileId? }} card
   * @returns {object} updated masked summary
   */
  async updateCard(card) {
    if (this.#locked) throw new Error('Vault is locked');
    const idx = this.#cards.findIndex(c => c.id === card.id);
    if (idx === -1) throw new Error(`Card not found: ${card.id}`);

    // Decrypt existing, merge updates, re-encrypt
    const existing = await this.#cards[idx].decrypt(this.#sessionKey, this.#crypto);
    const merged   = { ...existing, ...card };
    const updated  = await CardRecord.fromRaw(
      { ...merged, id: card.id },
      this.#sessionKey,
      this.#crypto
    );
    this.#cards[idx] = updated;

    // Zero merged raw data
    merged.pan = merged.cvv = '000';

    await this.#persistAll();
    return updated.toMaskedSummary();
  }

  /**
   * Returns masked summaries of all in-memory cards.
   * Safe to pass to the UI — no raw card data included.
   *
   * @returns {object[]}
   */
  getCards() {
    if (this.#locked) throw new Error('Vault is locked');
    return this.#cards.map(c => c.toMaskedSummary());
  }

  /** Alias for getCards() — used by vault_profile-based code paths. */
  getProfiles() {
    return this.getCards();
  }

  async removeCard(id) {
    if (this.#locked) throw new Error('Vault is locked');
    this.#cards = this.#cards.filter(c => c.id !== id);
    await this.#persistAll();
  }

  /** Alias for addCard — used by legacy code paths */
  async addProfile(rawCardData) {
    return this.addCard(rawCardData);
  }

  async removeProfile(id) {
    return this.removeCard(id);
  }

  // ── Autofill ──────────────────────────────────────────────────────────────

  /**
   * Decrypts a card transiently and returns masked tokens for DOM injection.
   * Raw PAN / CVV are zeroed immediately after building the token list.
   *
   * @param {string} cardId
   * @returns {{ fieldName: string, maskedValue: string }[]}
   */
  async getMaskedTokensForAutofill(cardId) {
    if (this.#locked) throw new Error('Vault is locked');
    const card = this.#cards.find(c => c.id === cardId);
    if (!card) throw new Error('Card not found');

    const raw = await card.decrypt(this.#sessionKey, this.#crypto);

    const tokens = [
      { fieldName: 'cc-number',   maskedValue: `•••• •••• •••• ${raw.pan.slice(-4)}` },
      { fieldName: 'cardnumber',  maskedValue: `•••• •••• •••• ${raw.pan.slice(-4)}` },
      { fieldName: 'cc-exp',      maskedValue: raw.expiry },
      { fieldName: 'expiry',      maskedValue: raw.expiry },
      { fieldName: 'cc-csc',      maskedValue: '•••' },
      { fieldName: 'cvv',         maskedValue: '•••' },
    ];

    // Zero raw object immediately
    raw.pan = '0000000000000000';
    raw.cvv = '000';
    raw.expiry = '00/00';

    return tokens;
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  get selectedCardId()   { return this.#selectedId; }
  set selectedCardId(id) { this.#selectedId = id; }

  // Alias
  get selectedProfileId()    { return this.#selectedId; }
  set selectedProfileId(id)  { this.#selectedId = id; }

  // ── Private ───────────────────────────────────────────────────────────────

  async #persistAll() {
    await this.#storage.saveAllCards(this.#cards, this.#sessionKey, this.#crypto);
  }
}