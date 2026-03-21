/**
 * vault_storage_schemas.js
 * Defines data structures for vault storage records.
 *
 * Each schema object documents the exact shape written to / read from
 * chrome.storage.local.  The autofill feature uses these schemas to
 * store and restore saved card data across browser sessions.
 *
 * Key names are versioned (_v1) to allow future migrations.
 */

// ── Storage key registry ───────────────────────────────────────────────────

export const VAULT_STORAGE_KEYS = {
  ALL_CARDS:   'sv_cards_v1',          // flat list of all encrypted cards
  VAULT:       'sv_vault_',            // prefix: sv_vault_<profileId>
  PROFILES:    'sv_profiles_v1',       // list of VaultProfile storables
  META:        'sv_meta_v1',           // vault metadata record
  SALT:        'sv_pbkdf2_salt',       // PBKDF2 salt (random, persisted)
  POLICY:      'sandbox_policy_v1',    // SandboxPolicy persisted state
  WEBAUTHN:    'sv_webauthn_cred_id',  // WebAuthn credential ID
};

// ── Schema: EncryptedCardRecord ────────────────────────────────────────────

/**
 * Shape of a single encrypted card record stored in chrome.storage.
 *
 * The IV and GCM authentication tag are prepended to the ciphertext
 * in the encryptedB64 field (layout: [IV 12 bytes | ciphertext | tag 16 bytes]).
 * They are NOT stored as separate fields to reduce storage overhead, but
 * the constants below document their exact sizes.
 *
 * @typedef {Object} EncryptedCardRecord
 * @property {string}  id            — UUID, stable across sessions
 * @property {string}  profileId     — links to a VaultProfile id
 * @property {string}  brand         — 'Visa' | 'MC' | 'Amex' | 'Discover' | 'Card'
 * @property {string}  lastFour      — last 4 digits of PAN (safe to store plain)
 * @property {string}  holderName    — cardholder name (safe to store plain)
 * @property {string}  encryptedB64  — base64( IV || AES-GCM ciphertext || tag )
 * @property {string}  [lastUsedSite]— origin URL of the last site this card was autofilled on
 * @property {number}  [lastUsedAt]  — epoch ms of last autofill use
 */
export const EncryptedCardRecordSchema = {
  id:           { type: 'string',  required: true  },
  profileId:    { type: 'string',  required: true,  default: 'default' },
  brand:        { type: 'string',  required: true  },
  lastFour:     { type: 'string',  required: true  },
  holderName:   { type: 'string',  required: true  },
  encryptedB64: { type: 'string',  required: true  }, // base64(IV || ciphertext || GCM-tag)
  lastUsedSite: { type: 'string',  required: false, default: '' },
  lastUsedAt:   { type: 'number',  required: false, default: 0  },
};

// ── Schema: VaultRecord (per-profile encrypted blob) ──────────────────────

/**
 * Vault record keyed by profileId in chrome.storage.local.
 * Key: sv_vault_<profileId>
 *
 * @typedef {Object} VaultRecord
 * @property {string}   profileId      — the profile this vault belongs to
 * @property {string}   encryptedB64   — base64( IV || AES-GCM ciphertext )
 *                                        Plaintext is a JSON array of EncryptedCardRecord
 * @property {string}   iv             — base64 of the 12-byte GCM IV (informational)
 * @property {string}   tag            — base64 of the 16-byte GCM auth tag (informational)
 * @property {string}   [lastUsedSite] — last origin that triggered a load of this vault
 * @property {number}   updatedAt      — epoch ms of last write
 */
export const VaultRecordSchema = {
  profileId:    { type: 'string', required: true  },
  encryptedB64: { type: 'string', required: true  },
  iv:           { type: 'string', required: false },  // informational
  tag:          { type: 'string', required: false },  // informational
  lastUsedSite: { type: 'string', required: false, default: '' },
  updatedAt:    { type: 'number', required: true  },
};

// ── Schema: VaultProfile (site profile) ───────────────────────────────────

/**
 * @typedef {Object} VaultProfileRecord
 * @property {string}  id              — UUID
 * @property {string}  name            — human-readable label
 * @property {string}  siteOrigin      — origin this profile activates on
 * @property {boolean} autofillEnabled — whether autofill is allowed
 * @property {number}  createdAt       — epoch ms
 */
export const VaultProfileSchema = {
  id:              { type: 'string',  required: true },
  name:            { type: 'string',  required: true },
  siteOrigin:      { type: 'string',  required: false, default: '' },
  autofillEnabled: { type: 'boolean', required: true,  default: true },
  createdAt:       { type: 'number',  required: true },
};

// ── Schema: VaultMeta ──────────────────────────────────────────────────────

/**
 * @typedef {Object} VaultMeta
 * @property {number}  version       — schema version (currently 1)
 * @property {number}  createdAt     — epoch ms of first vault creation
 * @property {number}  lastUnlocked  — epoch ms of last successful unlock
 * @property {number}  unlockCount   — total unlock events
 */
export const VaultMetaSchema = {
  version:      { type: 'number', required: true,  default: 1 },
  createdAt:    { type: 'number', required: true  },
  lastUnlocked: { type: 'number', required: false, default: 0 },
  unlockCount:  { type: 'number', required: false, default: 0 },
};

// ── Crypto layout constants (must match crypto_types.h) ───────────────────

export const CRYPTO_LAYOUT = {
  IV_BYTES:       12,   // SV_GCM_IV_SIZE
  TAG_BYTES:      16,   // SV_GCM_TAG_SIZE
  KEY_BYTES:      32,   // SV_AES_KEY_SIZE
  PBKDF2_ITER:    200_000,
};

// ── Utility: validate a record against a schema ───────────────────────────

/**
 * Validates a plain object against one of the schemas above.
 * Returns { valid: boolean, errors: string[] }.
 */
export function validateRecord(record, schema) {
  const errors = [];
  for (const [field, spec] of Object.entries(schema)) {
    const val = record[field];
    if (val === undefined || val === null) {
      if (spec.required && spec.default === undefined) {
        errors.push(`Missing required field: ${field}`);
      }
    } else if (typeof val !== spec.type) {
      errors.push(`Field "${field}": expected ${spec.type}, got ${typeof val}`);
    }
  }
  return { valid: errors.length === 0, errors };
}