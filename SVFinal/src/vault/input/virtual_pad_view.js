/**
 * virtual_pad_view.js
 * Renders the shuffled virtual numeric pad into a given mount element.
 * Connects key press events to VirtualPadCore.
 *
 * Fix: reshuffle BEFORE building the grid so layout is stable during render.
 * Removed the post-render reshuffle+rerenderKeys which caused duplicate digits.
 */

export class VirtualPadView {
  #core;
  #mount;
  #mode;
  #display;

  constructor(core, mountEl, mode = 'cvv') {
    this.#core  = core;
    this.#mount = mountEl;
    this.#mode  = mode;
  }

  render() {
    if (!this.#mount) return;
    this.#mount.innerHTML = '';

    // Reshuffle FIRST so the layout we read is the final layout for this render
    this.#core.reshuffle();
    const layout = this.#core.layout; // stable snapshot: 10 unique shuffled digits

    // Label
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

    // Grid — layout[0..9] are exactly 10 unique shuffled digits
    // Row 1: layout[0..2]
    // Row 2: layout[3..5]
    // Row 3: layout[6..8]
    // Row 4: CLR | layout[9] | DEL
    const grid = document.createElement('div');
    grid.className = 'sv-vpad';

    const rows = [
      [layout[0], layout[1], layout[2]],
      [layout[3], layout[4], layout[5]],
      [layout[6], layout[7], layout[8]],
      ['CLR',     layout[9], 'DEL'],
    ];

    for (const row of rows) {
      for (const key of row) {
        const btn = document.createElement('button');
        btn.className = 'sv-vpad-key' +
          (['CLR', 'DEL'].includes(key) ? ' sv-vpad-action' : '');
        btn.textContent = key;
        btn.setAttribute('type', 'button');

        // Capture key value at creation time — avoids closure-over-loop bug
        const capturedKey = key;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.#core.pressKey(capturedKey);
          this.#syncDisplay();
        });

        grid.appendChild(btn);
      }
    }

    this.#mount.appendChild(label);
    this.#mount.appendChild(this.#display);
    this.#mount.appendChild(grid);
  }

  #syncDisplay() {
    if (this.#display) {
      this.#display.textContent = this.#core.getMasked() || '—';
    }
  }
}
