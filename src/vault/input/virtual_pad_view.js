/**
 * virtual_pad_view.js
 * Renders the shuffled virtual numeric pad into a given mount element.
 * Connects key press events to VirtualPadCore.
 */

export class VirtualPadView {
  #core;
  #mount;
  #mode; // 'cvv' | 'otp'
  #display;

  constructor(core, mountEl, mode = 'cvv') {
    this.#core  = core;
    this.#mount = mountEl;
    this.#mode  = mode;
  }

  render() {
    if (!this.#mount) return;
    this.#mount.innerHTML = '';

    // Display strip
    this.#display = document.createElement('div');
    this.#display.className = 'sv-vpad-display';
    this.#display.style.cssText = `
      font-family: var(--mono, monospace);
      font-size: 20px;
      letter-spacing: 0.4em;
      color: var(--accent, #00e676);
      text-align: center;
      padding: 8px 0;
      min-height: 36px;
    `;
    this.#display.textContent = this.#core.getMasked() || '—';

    const label = document.createElement('div');
    label.textContent = this.#mode === 'otp' ? 'OTP Entry' : 'CVV Entry';
    label.style.cssText = `
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-secondary, #8fa3bc);
      text-align: center;
      margin-bottom: 4px;
    `;

    // Grid
    const grid = document.createElement('div');
    grid.className = 'sv-vpad';

    const layout = this.#core.layout;

    // Render 3×3 digit grid + action keys
    const keys = [...layout, 'CLR', '0', 'DEL'];

    // If layout already has 10 digits (0-9 shuffled), build 3-row grid
    // Row 1: layout[0..2], Row 2: layout[3..5], Row 3: layout[6..8]
    // Row 4: CLR, layout[9], DEL
    const rows = [
      [layout[0], layout[1], layout[2]],
      [layout[3], layout[4], layout[5]],
      [layout[6], layout[7], layout[8]],
      ['CLR',     layout[9], 'DEL'],
    ];

    for (const row of rows) {
      for (const key of row) {
        const btn = document.createElement('button');
        btn.className = 'sv-vpad-key' + (['CLR','DEL'].includes(key) ? ' sv-vpad-action' : '');
        btn.textContent = key;
        btn.setAttribute('type', 'button');
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.#core.pressKey(key);
          this.#syncDisplay();
        });
        grid.appendChild(btn);
      }
    }

    this.#mount.appendChild(label);
    this.#mount.appendChild(this.#display);
    this.#mount.appendChild(grid);

    // Re-shuffle on every render
    this.#core.reshuffle();
    this.#rerenderKeys(grid);
  }

  #syncDisplay() {
    if (this.#display) {
      this.#display.textContent = this.#core.getMasked() || '—';
    }
  }

  #rerenderKeys(grid) {
    // Update key labels after reshuffle without full re-render
    const btns = grid.querySelectorAll('.sv-vpad-key:not(.sv-vpad-action)');
    const layout = this.#core.layout;
    // First 9 buttons = first 9 shuffled digits
    btns.forEach((btn, i) => {
      if (i < 9) btn.textContent = layout[i];
    });
    // Last non-action key = layout[9]
    const actionBtns = grid.querySelectorAll('.sv-vpad-action');
    if (actionBtns[1]) actionBtns[1].textContent = layout[9];
  }
}