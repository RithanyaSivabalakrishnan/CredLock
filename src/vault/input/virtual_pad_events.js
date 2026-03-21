/**
 * virtual_pad_events.js
 * Handles click, mouse, and keyboard events for the virtual numeric pad.
 *
 * Responsibilities:
 *  - Validate input length limits (CVV: 3 digits, OTP: 4–8 digits)
 *  - Sanitize state changes (only digits allowed)
 *  - Support reset / cancel that clears value without exposure
 *  - Block physical keyboard input to the merchant page during pad use
 */

export class VirtualPadEvents {
  #core;
  #active    = false;
  #onSubmit  = null; // optional submit callback

  // Length constraints per mode
  static LIMITS = {
    cvv: { min: 3, max: 3 },
    otp: { min: 4, max: 8 },
  };

  /**
   * @param {VirtualPadCore} core
   * @param {Function|null}  onSubmit  — called with the validated value on confirm
   */
  constructor(core, onSubmit = null) {
    this.#core     = core;
    this.#onSubmit = onSubmit;
  }

  // ── Activation ────────────────────────────────────────────────────────────

  /**
   * Activates keyboard capture. Call when a virtual CVV/OTP field gains focus.
   * Physical keystrokes are consumed here and forwarded to the pad core —
   * they never reach the merchant page's input handlers.
   */
  activate() {
    if (this.#active) return;
    this.#active = true;
    document.addEventListener('keydown', this.#onKeyDown, true);
    document.addEventListener('keyup',   this.#onKeyUp,   true);
    console.log('[VirtualPadEvents] Keyboard capture active');
  }

  /**
   * Deactivates keyboard capture. Call when focus leaves the virtual field.
   */
  deactivate() {
    this.#active = false;
    document.removeEventListener('keydown', this.#onKeyDown, true);
    document.removeEventListener('keyup',   this.#onKeyUp,   true);
    console.log('[VirtualPadEvents] Keyboard capture inactive');
  }

  // ── Programmatic actions (called by VirtualPadView button handlers) ───────

  /**
   * Handles a pad button click event.
   * Validates input and sanitizes before forwarding to core.
   *
   * @param {string}     key    — '0'–'9', 'DEL', 'CLR', or 'CONFIRM'
   * @param {MouseEvent} event  — originating click event
   */
  handleClick(key, event) {
    event?.stopPropagation();
    event?.preventDefault();

    if (key === 'CONFIRM') {
      this.#attemptSubmit();
      return;
    }

    if (key === 'CLR' || key === 'CANCEL') {
      this.cancel();
      return;
    }

    if (!this.#isValidKey(key)) return;

    // Enforce per-mode max length before passing to core
    const mode   = this.#core.mode;
    const limit  = VirtualPadEvents.LIMITS[mode] ?? { min: 3, max: 8 };
    if (key !== 'DEL' && this.#core.length >= limit.max) return;

    this.#core.pressKey(key);
  }

  /**
   * Resets (clears + reshuffles) without emitting any sensitive value.
   * Safe to call from an "× Cancel" button.
   */
  cancel() {
    this.#core.reset();
    console.log('[VirtualPadEvents] Pad cancelled and reset');
  }

  // ── Private ───────────────────────────────────────────────────────────────

  #onKeyDown = (e) => {
    // Allow Tab for accessibility; block all other keys when active
    if (e.key === 'Tab') return;

    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      this.handleClick(e.key, null);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      this.#core.pressKey('DEL');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.#attemptSubmit();
    }
  };

  #onKeyUp = (e) => {
    // Consume keyup for the same set of keys to prevent leakage
    if (/^\d$/.test(e.key) || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  #isValidKey(key) {
    return /^\d$/.test(key) || key === 'DEL';
  }

  #attemptSubmit() {
    const mode  = this.#core.mode;
    const limit = VirtualPadEvents.LIMITS[mode] ?? { min: 3, max: 8 };

    if (this.#core.length < limit.min) {
      console.warn(`[VirtualPadEvents] Too short: need ${limit.min} digits for ${mode}`);
      return;
    }

    const submitted = this.#core.submit();
    if (submitted && typeof this.#onSubmit === 'function') {
      this.#onSubmit(this.#core.getValue());
    }
    if (submitted) {
      this.#core.reset(); // clear + reshuffle after successful submit
    }
  }
}