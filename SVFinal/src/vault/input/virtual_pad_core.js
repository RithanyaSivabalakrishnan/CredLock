/**
 * virtual_pad_core.js
 * OS analog: "Interrupt controller / secure keyboard driver"
 *
 * Manages the in-memory state of the virtual numeric pad used for
 * CVV and OTP entry only.  Keys are shuffled on every display to
 * defeat screenshot / click-pattern recording attacks.
 *
 * Exports: clear(), pressKey(key), submit(), getValue(), getMasked()
 */

export class VirtualPadCore {
  #buffer    = [];
  #maxLength = 4;
  #mode      = 'cvv'; // 'cvv' | 'otp'
  #layout    = [];
  #listeners = new Map();

  /**
   * @param {number} maxLength  — 3 for CVV, 4–8 for OTP
   * @param {'cvv'|'otp'} mode  — determines validation limits
   */
  constructor(maxLength = 4, mode = 'cvv') {
    this.#maxLength = maxLength;
    this.#mode      = mode;
    this.reshuffle();
  }

  // ── Core operations ───────────────────────────────────────────────────────

  /**
   * Registers a key press from the virtual pad UI.
   * Ignores presses beyond maxLength (no silent overflow).
   *
   * @param {string} key  — digit '0'–'9', 'DEL', or 'CLR'
   */
  pressKey(key) {
    if (key === 'DEL') {
      this.#buffer.pop();
    } else if (key === 'CLR') {
      this.clear();
    } else if (/^\d$/.test(key)) {
      if (this.#buffer.length < this.#maxLength) {
        this.#buffer.push(key);
      }
    }
    this.#emit('input', this.getMasked());

    if (this.#buffer.length === this.#maxLength) {
      this.#emit('complete', this.getValue());
    }
  }

  /**
   * Clears the current input buffer without emitting a value.
   * Does NOT reshuffle (call reshuffle() separately if needed).
   */
  clear() {
    this.#buffer = [];
    this.#emit('input', '');
    this.#emit('cleared', null);
  }

  /**
   * Submits the current buffer value via the 'submit' event.
   * Returns false (and does nothing) if the buffer is too short.
   *
   * @returns {boolean} true if submitted, false if invalid length
   */
  submit() {
    const minLength = this.#mode === 'otp' ? 4 : 3;
    if (this.#buffer.length < minLength) {
      this.#emit('error', `Minimum ${minLength} digits required`);
      return false;
    }
    this.#emit('submit', this.getValue());
    return true;
  }

  /**
   * Returns the raw digit string — kept in memory, never exposed to
   * the merchant page DOM.
   */
  getValue() {
    return this.#buffer.join('');
  }

  /**
   * Returns a masked display string (e.g. "•••" for a 3-digit CVV).
   */
  getMasked() {
    return '•'.repeat(this.#buffer.length);
  }

  /**
   * Clears buffer and randomises key layout.
   * Call after a successful submit or on cancel.
   */
  reset() {
    this.#buffer = [];
    this.reshuffle();
  }

  /** Fisher-Yates shuffle of digit keys */
  reshuffle() {
    const digits = ['0','1','2','3','4','5','6','7','8','9'];
    for (let i = digits.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [digits[i], digits[j]] = [digits[j], digits[i]];
    }
    this.#layout = digits;
    this.#emit('layout', this.#layout);
  }

  // ── Getters / setters ─────────────────────────────────────────────────────

  get layout()    { return [...this.#layout]; }
  get maxLength() { return this.#maxLength; }
  get mode()      { return this.#mode; }
  get length()    { return this.#buffer.length; }

  set maxLength(n) { this.#maxLength = n; }
  set mode(m)      { this.#mode = m; }

  // ── Event emitter ─────────────────────────────────────────────────────────

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push(fn);
    return this; // chainable
  }

  off(event, fn) {
    const arr = this.#listeners.get(event) ?? [];
    this.#listeners.set(event, arr.filter(f => f !== fn));
    return this;
  }

  #emit(event, data) {
    (this.#listeners.get(event) ?? []).forEach(fn => fn(data));
  }
}