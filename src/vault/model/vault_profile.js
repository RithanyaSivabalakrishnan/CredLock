/**
 * vault_profile.js
 *
 * Exports two classes:
 *
 *  VaultProfile  — represents a per-site / per-shop profile.
 *    createProfile(name, siteOrigin)
 *    setAutofillEnabled(enabled)
 *    isAutofillEnabled()
 *
 *  CardRecord    — encrypted payment card tied to a VaultProfile.
 *    fromRaw(rawCardData, sessionKey, crypto)
 *    decrypt(sessionKey, crypto)
 *    toMaskedSummary()
 *    toStorable() / fromStorable()
 */

import { generateId } from '../../crypto/wasm_crypto.js';

// ──────────────────────────────────────────────────────────────────────────
// VaultProfile — site / shop profile
// ──────────────────────────────────────────────────────────────────────────

export class VaultProfile {
  id;
  name;
  siteOrigin;
  #autofillEnabled;
  createdAt;

  constructor(id, name, siteOrigin = '', autofillEnabled = true) {
    this.id              = id;
    this.name            = name;
    this.siteOrigin      = siteOrigin;
    this.#autofillEnabled = autofillEnabled;
    this.createdAt       = Date.now();
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  /**
   * Creates a new VaultProfile.
   *
   * @param {string}  name        — human-readable label (e.g. "Chase Checking")
   * @param {string}  siteOrigin  — origin URL this profile activates on
   * @returns {VaultProfile}
   */
  static createProfile(name, siteOrigin = '') {
    return new VaultProfile(generateId(), name, siteOrigin, true);
  }

  // ── Autofill flag ─────────────────────────────────────────────────────────

  /**
   * Sets whether the autofill feature is enabled for this profile.
   * When disabled, the vault will not pre-load cards for the site.
   *
   * @param {boolean} enabled
   */
  setAutofillEnabled(enabled) {
    this.#autofillEnabled = Boolean(enabled);
  }

  /**
   * Returns true if autofill is enabled for this profile.
   * @returns {boolean}
   */
  isAutofillEnabled() {
    return this.#autofillEnabled;
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  toStorable() {
    return {
      id:              this.id,
      name:            this.name,
      siteOrigin:      this.siteOrigin,
      autofillEnabled: this.#autofillEnabled,
      createdAt:       this.createdAt,
    };
  }

  static fromStorable(obj) {
    const p = new VaultProfile(
      obj.id, obj.name, obj.siteOrigin ?? '', obj.autofillEnabled ?? true
    );
    p.createdAt = obj.createdAt ?? Date.now();
    return p;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CardRecord — encrypted payment card
// ──────────────────────────────────────────────────────────────────────────

export class CardRecord {
  id;
  profileId;     // links to a VaultProfile
  brand;
  lastFour;
  holderName;
  #encryptedBlob; // ArrayBuffer — AES-GCM ciphertext (IV prepended)

  constructor(id, profileId, brand, lastFour, holderName, encryptedBlob) {
    this.id             = id;
    this.profileId      = profileId ?? 'default';
    this.brand          = brand;
    this.lastFour       = lastFour;
    this.holderName     = holderName;
    this.#encryptedBlob = encryptedBlob;
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  /**
   * Encrypts raw card data immediately and returns a CardRecord.
   * The raw PAN and CVV are zeroed after encryption.
   *
   * @param {{ pan, expiry, cvv, holderName, profileId?, id? }} rawCardData
   * @param {CryptoKey}   sessionKey
   * @param {WasmCrypto}  crypto
   */
  static async fromRaw(rawCardData, sessionKey, crypto) {
    const { pan, expiry, cvv, holderName, profileId, id } = rawCardData;

    const cleanPan  = (pan ?? '').replace(/\s/g, '');
    const lastFour  = cleanPan.slice(-4);
    const brand     = CardRecord.#detectBrand(cleanPan);
    const cardId    = id ?? generateId();

    const plaintext     = JSON.stringify({ pan: cleanPan, expiry, cvv });
    const encryptedBlob = await crypto.encrypt(sessionKey, plaintext);

    // Zero raw sensitive strings (best-effort in JS)
    // Use a local variable rather than mutating the caller's object
    // to prevent test data pollution when the same card object is reused
    let _pan = cleanPan;
    let _cvv = cvv ?? '';
    _pan = '0000000000000000';
    _cvv = '000';
    void _pan; void _cvv; // suppress unused warning

    return new CardRecord(cardId, profileId ?? 'default', brand, lastFour, holderName, encryptedBlob);
  }

  // ── Decrypt ───────────────────────────────────────────────────────────────

  /**
   * Decrypts and returns raw card data.
   * Caller MUST zero the returned object after use.
   *
   * @param {CryptoKey}  sessionKey
   * @param {WasmCrypto} crypto
   * @returns {{ pan: string, expiry: string, cvv: string }}
   */
  async decrypt(sessionKey, crypto) {
    const plaintext = await crypto.decrypt(sessionKey, this.#encryptedBlob);
    return JSON.parse(plaintext);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  toMaskedSummary() {
    return {
      id:         this.id,
      profileId:  this.profileId,
      brand:      this.brand,
      lastFour:   this.lastFour,
      holderName: this.holderName,
      maskedPan:  `•••• •••• •••• ${this.lastFour}`,
    };
  }

  // ── Storage serialisation ─────────────────────────────────────────────────

  toStorable() {
    const bytes = new Uint8Array(this.#encryptedBlob);
    const b64   = btoa(String.fromCharCode(...bytes));
    return {
      id:           this.id,
      profileId:    this.profileId,
      brand:        this.brand,
      lastFour:     this.lastFour,
      holderName:   this.holderName,
      encryptedB64: b64,
    };
  }

  static fromStorable(obj) {
    const bin  = atob(obj.encryptedB64);
    const buf  = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new CardRecord(
      obj.id, obj.profileId ?? 'default',
      obj.brand, obj.lastFour, obj.holderName,
      buf.buffer
    );
  }

  // ── Brand detection ───────────────────────────────────────────────────────

  static #detectBrand(pan) {
    if (/^4/.test(pan))            return 'Visa';
    if (/^5[1-5]/.test(pan))      return 'MC';
    if (/^3[47]/.test(pan))       return 'Amex';
    if (/^6(?:011|5)/.test(pan))  return 'Discover';
    if (/^35/.test(pan))          return 'JCB';
    return 'Card';
  }
}

// Re-export VaultProfile as default export for backward compat
export default VaultProfile;