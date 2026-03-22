/**
 * dom_injector.js
 * Translates selected card data from the vault into actions on the
 * merchant DOM via MerchantDomAdapter.
 *
 * This is the ONLY module allowed to write card data into the merchant
 * form.  It is called by the vault UI after the user confirms autofill.
 *
 * Exports:
 *   injectCardData(cardData)         — writes real (masked) values into form
 *   injectMaskedCardData(cardData)   — writes fully masked placeholder values
 */

import { MerchantDomAdapter } from '../../content/merchant_dom_adapter.js';

const adapter = new MerchantDomAdapter();

export class DomInjector {

  /**
   * Injects card tokens into the merchant form.
   * "Real" here means the last-four PAN, expiry, and masked CVV — the
   * vault NEVER injects a raw PAN or CVV into the DOM.
   *
   * @param {{ fieldName: string, maskedValue: string }[]} cardData
   *   Array of token descriptors from VaultModel.getMaskedTokensForAutofill()
   */
  injectCardData(cardData = []) {
    if (!Array.isArray(cardData) || !cardData.length) {
      console.warn('[DomInjector] injectCardData: empty or invalid cardData');
      return;
    }

    console.log('[DomInjector] Injecting', cardData.length, 'field token(s)');
    adapter.setAutofilledData(cardData);
  }

  /**
   * Injects fully masked placeholder values into the form.
   * Used when the merchant page needs a non-empty value for validation
   * but the real data is transmitted securely out-of-band.
   *
   * @param {{ fieldName: string, maskedValue: string }[]} cardData
   */
  injectMaskedCardData(cardData = []) {
    if (!Array.isArray(cardData) || !cardData.length) {
      console.warn('[DomInjector] injectMaskedCardData: empty or invalid cardData');
      return;
    }

    // Replace all values with fully masked versions before injection
    const fullyMasked = cardData.map(({ fieldName }) => {
      const mask = this.#buildFullMask(fieldName);
      return { fieldName, maskedValue: mask };
    });

    console.log('[DomInjector] Injecting fully masked data for', fullyMasked.length, 'field(s)');
    adapter.setAutofilledData(fullyMasked);
  }

  /**
   * Convenience: inject via the adapter's batch method directly.
   * Identical to injectCardData but accepts the same token format.
   */
  injectTokens(tokens = []) {
    adapter.injectMaskedInputs(tokens);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Returns a fully opaque mask string appropriate for each field type. */
  #buildFullMask(fieldName) {
    const name = fieldName.toLowerCase();

    if (name.includes('number') || name === 'cc-number' || name === 'cardnumber') {
      return '•••• •••• •••• ••••';
    }
    if (name.includes('exp') || name.includes('expiry')) {
      return '••/••';
    }
    if (name.includes('cvv') || name.includes('cvc') || name === 'cc-csc') {
      return '•••';
    }
    if (name.includes('otp') || name.includes('one-time')) {
      return '••••';
    }
    if (name.includes('name') || name.includes('holder')) {
      return '•••••••••••';
    }

    return '••••';
  }
}