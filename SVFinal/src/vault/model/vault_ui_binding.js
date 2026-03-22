/**
 * vault_ui_binding.js
 * Binds VaultModel card/profile data to the Shadow DOM UI.
 *
 * Exports:
 *   bindCardsToUI(listEl, autofillBtn)   — render card list, wire selection
 *   setSelectedCard(cardId)              — programmatically select a card
 *   onCardSelected(callback)             — register a selection listener
 *   saveCurrentCard(shadowRoot)          — read form fields, encrypt, save
 *   autofillSelected()                   — send selected card to merchant DOM
 */

export class VaultUiBinding {
  #model;
  #selectedCardId   = null;
  #selectionCbs     = [];   // onCardSelected callbacks

  constructor(model) {
    this.#model = model;
  }

  // ── Card list ─────────────────────────────────────────────────────────────

  /**
   * Renders saved cards into <ul> listEl.
   * When the user clicks a card it becomes selected and autofillBtn is enabled.
   * Calls any registered onCardSelected callbacks.
   *
   * @param {HTMLElement|null} listEl      — <ul> to populate
   * @param {HTMLElement|null} autofillBtn — button to enable/disable
   */
  async bindCardsToUI(listEl, autofillBtn = null) {
    if (!listEl) return;
    listEl.innerHTML = '';

    let cards;
    try {
      cards = this.#model.getCards();
    } catch {
      return; // vault locked
    }

    if (autofillBtn) autofillBtn.disabled = true;

    if (!cards.length) {
      const empty = document.createElement('li');
      empty.style.cssText = 'color:var(--text-dim);font-size:11px;text-align:center;padding:16px;';
      empty.textContent   = 'No saved cards. Add one below.';
      listEl.appendChild(empty);
      return;
    }

    for (const card of cards) {
      const li = this.#buildCardItem(card, listEl, autofillBtn);
      listEl.appendChild(li);
    }
  }

  /** Alias for bindCardsToUI — used by legacy render paths */
  async renderProfiles(listEl, autofillBtn = null) {
    return this.bindCardsToUI(listEl, autofillBtn);
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  /**
   * Programmatically selects a card by id and updates the model.
   * @param {string} cardId
   */
  setSelectedCard(cardId) {
    this.#selectedCardId      = cardId;
    this.#model.selectedCardId = cardId;
    this.#selectionCbs.forEach(cb => cb(cardId));
  }

  /**
   * Registers a callback invoked whenever a card is selected.
   * @param {Function} callback  — (cardId: string) => void
   */
  onCardSelected(callback) {
    if (typeof callback === 'function') this.#selectionCbs.push(callback);
  }

  // ── Save card ─────────────────────────────────────────────────────────────

  /**
   * Reads virtual field divs from the add-card form, encrypts, and saves.
   * @param {ShadowRoot|null} shadowRoot
   */
  async saveCurrentCard(shadowRoot) {
    const read = (id) => {
      const el = document.getElementById(id) ?? shadowRoot?.getElementById?.(id);
      if (!el) return '';
      // <input> elements have .value; contenteditable divs use .textContent
      return (el.value !== undefined ? el.value : el.textContent ?? '').trim();
    };

    const rawCard = {
      holderName: read('sv-field-name'),
      pan:        read('sv-field-number').replace(/\s/g, ''),
      expiry:     read('sv-field-expiry'),
      cvv:        read('sv-field-cvv'),
    };

    if (!rawCard.pan || rawCard.pan.length < 13) {
      console.warn('[VaultUiBinding] Invalid card number');
      return;
    }

    await this.#model.addCard(rawCard);

    // Clear fields — works for both <input> and contenteditable divs
    ['sv-field-name','sv-field-number','sv-field-expiry','sv-field-cvv']
      .forEach(id => {
        const el = document.getElementById(id) ?? shadowRoot?.getElementById?.(id);
        if (!el) return;
        if (el.value !== undefined) el.value = '';
        else el.textContent = '';
      });
  }

  // ── Autofill ──────────────────────────────────────────────────────────────

  /**
   * Autofills the currently selected card into the active merchant tab.
   */
  async autofillSelected() {
    const id = this.#selectedCardId ?? this.#model.selectedCardId;
    if (!id) { console.warn('[VaultUiBinding] No card selected'); return; }

    const tokens = await this.#model.getMaskedTokensForAutofill(id);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    await chrome.runtime.sendMessage({
      type:    'MASKED_DATA_READY',
      payload: tokens,
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  #buildCardItem(card, listEl, autofillBtn) {
    const li = document.createElement('li');
    li.className         = 'sv-profile-item';
    li.dataset.cardId    = card.id;
    li.setAttribute('role', 'option');

    const brand = document.createElement('div');
    brand.className   = 'sv-profile-brand';
    brand.textContent = card.brand;

    const info = document.createElement('div');
    info.className = 'sv-profile-info';

    const name = document.createElement('div');
    name.className   = 'sv-profile-name';
    name.textContent = card.holderName;

    const mask = document.createElement('div');
    mask.className   = 'sv-profile-mask';
    mask.textContent = card.maskedPan;

    info.appendChild(name);
    info.appendChild(mask);
    li.appendChild(brand);
    li.appendChild(info);

    li.addEventListener('click', () => {
      listEl.querySelectorAll('.sv-profile-item')
        .forEach(el => el.classList.remove('selected'));
      li.classList.add('selected');

      this.setSelectedCard(card.id);

      if (autofillBtn) autofillBtn.disabled = false;
    });

    return li;
  }
}