/**
 * ui_noise_layer.js
 * OS analog: "ASLR / memory noise for UI events"
 *
 * Adds visual noise and obfuscation to the vault UI:
 *  1. Slightly randomises virtual pad button positions (CSS jitter)
 *  2. Inserts temporary decoy buttons that disappear quickly
 *  3. Draws random pixels to a hidden canvas to pollute event logs
 *  4. Emits synthetic pointer events to defeat click-pattern fingerprinting
 *
 * The autofill feature is NOT affected — it operates on model data,
 * not on UI element positions.
 */

const JITTER_PX    = 3;   // max ±px position shift per button
const DECOY_TTL_MS = 400; // decoy buttons disappear after this many ms
const TICK_INTERVAL_MS = 300;

export class UiNoiseLayer {
  #canvas;
  #ctx;
  #padContainer = null; // the virtual pad grid element
  #timer        = null;
  #running      = false;
  #decoys       = [];   // { el, timerId }

  /**
   * @param {HTMLCanvasElement|null} canvasEl      — off-screen noise canvas
   * @param {HTMLElement|null}       padContainer  — the .sv-vpad grid element
   */
  constructor(canvasEl, padContainer = null) {
    this.#canvas       = canvasEl;
    this.#ctx          = canvasEl?.getContext('2d') ?? null;
    this.#padContainer = padContainer;
  }

  /** Set the virtual pad container after the pad is rendered. */
  setPadContainer(el) {
    this.#padContainer = el;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(intervalMs = TICK_INTERVAL_MS) {
    if (this.#running) return;
    this.#running = true;
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), intervalMs);
  }

  stop() {
    this.#running = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#clearDecoys();
    this.#resetJitter();
  }

  // ── Tick ──────────────────────────────────────────────────────────────────

  #tick() {
    this.#drawCanvasNoise();
    this.#emitSyntheticEvents();
    this.#jitterPadButtons();
    if (Math.random() < 0.25) this.#insertDecoyButton();
  }

  // ── 1. Canvas noise ───────────────────────────────────────────────────────

  #drawCanvasNoise() {
    if (!this.#ctx || !this.#canvas) return;
    const w = this.#canvas.width  || 1;
    const h = this.#canvas.height || 1;
    const imageData = this.#ctx.createImageData(w, h);
    const data      = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i]   = (Math.random() * 255) | 0;
      data[i+1] = (Math.random() * 255) | 0;
      data[i+2] = (Math.random() * 255) | 0;
      data[i+3] = (Math.random() * 255) | 0;
    }
    this.#ctx.putImageData(imageData, 0, 0);
  }

  // ── 2. Synthetic pointer events ───────────────────────────────────────────

  #emitSyntheticEvents() {
    const target = this.#canvas ?? document.body;
    const types  = ['pointermove', 'pointerenter', 'pointerleave', 'mousemove'];
    const type   = types[Math.floor(Math.random() * types.length)];
    target.dispatchEvent(new PointerEvent(type, {
      bubbles:  false,
      clientX:  Math.random() * 340,
      clientY:  Math.random() * 500,
      pointerId: 1,
    }));
  }

  // ── 3. Pad button jitter ──────────────────────────────────────────────────

  #jitterPadButtons() {
    if (!this.#padContainer) return;
    const buttons = this.#padContainer.querySelectorAll('.sv-vpad-key:not(.sv-decoy)');
    buttons.forEach(btn => {
      const dx = (Math.random() * JITTER_PX * 2 - JITTER_PX).toFixed(1);
      const dy = (Math.random() * JITTER_PX * 2 - JITTER_PX).toFixed(1);
      btn.style.transform = `translate(${dx}px, ${dy}px)`;
    });
  }

  #resetJitter() {
    if (!this.#padContainer) return;
    this.#padContainer.querySelectorAll('.sv-vpad-key:not(.sv-decoy)')
      .forEach(btn => { btn.style.transform = ''; });
  }

  // ── 4. Decoy button insertion ─────────────────────────────────────────────

  #insertDecoyButton() {
    if (!this.#padContainer) return;

    const decoy = document.createElement('button');
    decoy.className = 'sv-vpad-key sv-decoy';
    decoy.type      = 'button';
    decoy.setAttribute('aria-hidden', 'true');
    decoy.setAttribute('tabindex', '-1');

    // Random digit label that doesn't correspond to a real action
    decoy.textContent = String(Math.floor(Math.random() * 10));

    decoy.style.cssText = [
      `opacity:${(0.1 + Math.random() * 0.2).toFixed(2)}`,
      `position:absolute`,
      `top:${(Math.random() * 80).toFixed(0)}%`,
      `left:${(Math.random() * 80).toFixed(0)}%`,
      `pointer-events:none`,
      `user-select:none`,
      `transition:opacity 0.2s`,
    ].join(';');

    this.#padContainer.appendChild(decoy);

    const timerId = setTimeout(() => {
      decoy.remove();
      this.#decoys = this.#decoys.filter(d => d.el !== decoy);
    }, DECOY_TTL_MS);

    this.#decoys.push({ el: decoy, timerId });

    // Cap at 3 simultaneous decoys to avoid layout thrash
    if (this.#decoys.length > 3) {
      const oldest = this.#decoys.shift();
      clearTimeout(oldest.timerId);
      oldest.el.remove();
    }
  }

  #clearDecoys() {
    for (const { el, timerId } of this.#decoys) {
      clearTimeout(timerId);
      el.remove();
    }
    this.#decoys = [];
  }
}