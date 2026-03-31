/**
 * dist/content.js  —  CredLock Content Script  v2.0.1
 *
 * Works on:
 *   • CodePen payment test page (quinlo/pen/YONMEa) — injected into the
 *     nested preview iframe via all_frames:true
 *   • Real payment sites: Stripe, Razorpay, PayU, CCAvenue, Amazon, Flipkart
 *   • Indian netbanking portals (HDFC, SBI, ICICI, Axis, Kotak …)
 *   • Any payment gateway iframe (3DS, embedded checkout)
 *   • Dynamically loaded / SPA-rendered forms
 *
 * Detects:
 *   Card Number · Card Holder Name · Expiry · CVV
 *   UPI ID · Net Banking Username / Password
 */
(function () {
  'use strict';

  // ── Guard: skip extension's own pages ─────────────────────────────────────
  if (location.protocol === 'chrome-extension:') return;

  // ── Safe message sender ───────────────────────────────────────────────────
  function svSend(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      if (/invalidated|Extension context/i.test(e.message || '')) svDetach();
      return Promise.resolve();
    }
  }

  function svDetach() {
    document.querySelectorAll('[data-sv-host]').forEach(h => {
      const prev = h.previousElementSibling;
      if (prev?.dataset?.svProcessed) prev.style.display = '';
      h.remove();
    });
    document.getElementById('sv-autofill-banner')?.remove();
    document.getElementById('sv-save-prompt')?.remove();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIELD DETECTION  — the heart of the fix
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Each entry: { selectorList, fieldType, priority }
   * fieldType is our canonical internal name used for autofill dispatch.
   * Priority: lower = more specific = tested first.
   */
  const FIELD_RULES = [

    // ── Card Number ──────────────────────────────────────────────────────────
    { type: 'card-number', priority: 1, selectors: [
      'input[autocomplete="cc-number"]',
      'input[name="cardNumber"]',
      'input[name="card_number"]',
      'input[name="card-number"]',
      'input[name*="cardnumber" i]',
      'input[name*="card_no" i]',
      'input[name*="pan" i]',
      'input[id*="cardNumber" i]',
      'input[id*="card_number" i]',
      'input[id*="card-number" i]',
      'input[id*="cardno" i]',
      'input[placeholder*="card number" i]',
      'input[placeholder*="card no" i]',
      'input[placeholder*="card num" i]',
      'input[placeholder*="1234" i]',
      'input[data-vault-field="card-number"]',
      'input[data-field="number"]',
      // type=tel is common for card fields (numeric keyboard on mobile)
      'input[type="tel"][name*="card" i]',
      'input[type="tel"][id*="card" i]',
      'input[type="tel"][placeholder*="card" i]',
      'input[type="text"][name*="card" i]',
    ]},

    // ── Card Holder Name ─────────────────────────────────────────────────────
    { type: 'cardholder-name', priority: 2, selectors: [
      'input[autocomplete="cc-name"]',
      'input[name="cardHolder"]',
      'input[name="card_holder"]',
      'input[name="cardholder"]',
      'input[name="holder_name"]',
      'input[name="holderName"]',
      'input[name="name_on_card" i]',
      'input[name*="holder" i]',
      'input[id*="cardholder" i]',
      'input[id*="holder" i]',
      'input[id*="nameOnCard" i]',
      'input[placeholder*="card holder" i]',
      'input[placeholder*="cardholder" i]',
      'input[placeholder*="name on card" i]',
      'input[placeholder*="name on the card" i]',
      'input[placeholder*="full name" i]',
      'input[data-vault-field="cardholder-name"]',
      'input[data-field="name"]',
    ]},

    // ── Expiry Date ──────────────────────────────────────────────────────────
    { type: 'expiry', priority: 3, selectors: [
      'input[autocomplete="cc-exp"]',
      'input[autocomplete="cc-exp-month"]',
      'input[autocomplete="cc-exp-year"]',
      'input[name="expiry"]',
      'input[name="expDate"]',
      'input[name="exp_date"]',
      'input[name="expiryDate"]',
      'input[name="expiration"]',
      'input[name="expiry_date"]',
      'input[name*="expir" i]',
      'input[name*="exp_month" i]',
      'input[name*="exp_year" i]',
      'input[id*="expiry" i]',
      'input[id*="expDate" i]',
      'input[id*="expiration" i]',
      'input[placeholder*="mm/yy" i]',
      'input[placeholder*="mm / yy" i]',
      'input[placeholder*="mm/yyyy" i]',
      'input[placeholder*="expiry" i]',
      'input[placeholder*="expiration" i]',
      'input[placeholder*="valid" i]',
      'input[data-vault-field="expiry"]',
      'input[data-field="expiry"]',
    ]},

    // ── CVV / CVC / Security Code ────────────────────────────────────────────
    { type: 'cvv', priority: 4, selectors: [
      'input[autocomplete="cc-csc"]',
      'input[name="cvv"]',
      'input[name="cvc"]',
      'input[name="cvv2"]',
      'input[name="cvc2"]',
      'input[name="securityCode"]',
      'input[name="security_code"]',
      'input[name*="cvv" i]',
      'input[name*="cvc" i]',
      'input[name*="csc" i]',
      'input[id*="cvv" i]',
      'input[id*="cvc" i]',
      'input[id*="securityCode" i]',
      'input[placeholder*="cvv" i]',
      'input[placeholder*="cvc" i]',
      'input[placeholder*="security code" i]',
      'input[placeholder*="3 digit" i]',
      'input[placeholder*="4 digit" i]',
      'input[data-vault-field="cvv"]',
      'input[data-field="cvv"]',
    ]},

    // ── UPI ID ───────────────────────────────────────────────────────────────
    { type: 'upi-id', priority: 5, selectors: [
      'input[name*="upi" i]',
      'input[id*="upi" i]',
      'input[placeholder*="upi" i]',
      'input[placeholder*="vpa" i]',
      'input[placeholder*="virtual payment" i]',
      'input[placeholder*="@" i][name*="upi" i]',
      'input[data-vault-field="upi-id"]',
    ]},

    // ── Net Banking Username ─────────────────────────────────────────────────
    { type: 'netbanking-username', priority: 6, selectors: [
      'input[name="userId"]',
      'input[name="user_id"]',
      'input[name="userName"]',
      'input[name="loginId"]',
      'input[name="customerId"]',
      'input[name="cid"]',
      'input[name*="userid" i]',
      'input[name*="username" i]',
      'input[name*="loginid" i]',
      'input[name*="custid" i]',
      'input[id*="userid" i]',
      'input[id*="username" i]',
      'input[id*="loginid" i]',
      'input[placeholder*="user id" i]',
      'input[placeholder*="username" i]',
      'input[placeholder*="customer id" i]',
      'input[placeholder*="login id" i]',
      'input[type="text"][autocomplete="username"]',
      'input[type="email"][autocomplete="username"]',
    ]},

    // ── Net Banking Password ─────────────────────────────────────────────────
    { type: 'netbanking-password', priority: 7, selectors: [
      'input[type="password"]',
      'input[autocomplete="current-password"]',
      'input[autocomplete="new-password"]',
      'input[name*="password" i]',
      'input[name*="passwd" i]',
      'input[id*="password" i]',
      'input[placeholder*="password" i]',
    ]},

    // ── OTP / One-Time Password ──────────────────────────────────────────────
    { type: 'otp', priority: 8, selectors: [
      'input[name*="otp" i]',
      'input[id*="otp" i]',
      'input[placeholder*="otp" i]',
      'input[placeholder*="one time" i]',
      'input[placeholder*="verification code" i]',
      'input[placeholder*="enter code" i]',
      'input[autocomplete="one-time-code"]',
      'input[data-vault-field="otp"]',
    ]},
  ];

  // Build a combined selector for MutationObserver (all selectors, all types)
  const ALL_SELECTORS = FIELD_RULES
    .flatMap(r => r.selectors)
    .join(',');

  /**
   * Detect the field type from an element by testing each rule in priority order.
   * Returns the canonical type string or null.
   */
  function detectFieldType(el) {
    for (const rule of FIELD_RULES) {
      for (const sel of rule.selectors) {
        try {
          if (el.matches(sel)) return rule.type;
        } catch (_) {}
      }
    }
    return null;
  }

  /**
   * Scan the current document (or an iframe's document) for payment fields.
   * Returns an array of { element, type } objects.
   */
  function scanFields(root) {
    root = root || document;
    const seen = new Set();
    const found = [];

    for (const rule of FIELD_RULES) {
      for (const sel of rule.selectors) {
        try {
          root.querySelectorAll(sel).forEach(el => {
            if (seen.has(el) || isSvInternal(el) || el.dataset.svScanned) return;
            seen.add(el);
            found.push({ element: el, type: rule.type });
          });
        } catch (_) {}
      }
    }
    return found;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IFRAME SUPPORT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Since all_frames:true injects this script into ALL iframes, including
   * CodePen's preview iframe and payment gateway iframes (Razorpay, Paytm, 3DS),
   * the script self-starts in each frame context independently.
   *
   * For SAME-ORIGIN iframes we also try to scan them from the parent.
   * For CROSS-ORIGIN iframes (the common case) Chrome injects us automatically.
   */
  function scanSameOriginIframes() {
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!iDoc) continue;
          // Same-origin: we can access directly
          const fields = scanFields(iDoc);
          if (fields.length > 0) {
            processFields(fields, iDoc);
          }
        } catch (_) {
          // Cross-origin: Chrome will inject content.js into it separately
        }
      }
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTOFILL LOGIC
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The stored credential raw object can have:
   *   { password, username }         — for login / netbanking
   *   { pan, expiry, cvv, holderName } — for card
   *
   * This maps our field types to the values in the raw credential.
   */
  function buildAutofillTokens(credential) {
    const tokens = [];
    if (!credential) return tokens;

    // Card tokens
    if (credential.pan || credential.lastFour) {
      const lastFour = credential.lastFour || credential.pan?.slice(-4) || '????';
      tokens.push(
        { type: 'card-number',      value: credential.pan || `•••• •••• •••• ${lastFour}` },
        { type: 'cardholder-name',  value: credential.holderName || credential.username || '' },
        { type: 'expiry',           value: credential.expiry || '' },
        { type: 'cvv',              value: credential.cvv || '' },
      );
    }

    // Login / netbanking tokens
    if (credential.password) {
      tokens.push(
        { type: 'netbanking-username', value: credential.username || credential.holderName || '' },
        { type: 'netbanking-password', value: credential.password },
      );
    }

    // UPI token
    if (credential.upiId) {
      tokens.push({ type: 'upi-id', value: credential.upiId });
    }

    return tokens.filter(t => t.value);
  }

  /**
   * Write a value into an input element using the native setter so
   * React / Vue / Angular synthetic events fire correctly.
   */
  function nativeFill(el, value) {
    if (!el || value === undefined || value === null) return;
    const desc = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el), 'value'
    ) || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');

    if (desc?.set) desc.set.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event('input',  { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  /**
   * Fill all matching fields on a document root with the given tokens.
   */
  function fillFields(tokens, root) {
    root = root || document;
    for (const token of tokens) {
      if (!token.value) continue;

      // Find the best matching element for this token type
      const rule = FIELD_RULES.find(r => r.type === token.type);
      if (!rule) continue;

      let el = null;
      for (const sel of rule.selectors) {
        try {
          el = root.querySelector(sel);
          if (el) break;
        } catch (_) {}
      }

      if (el) {
        nativeFill(el, token.value);
        el.style.borderColor = '#00e676';
        el.style.boxShadow   = '0 0 0 2px rgba(0,230,118,0.25)';
      }
    }
  }

  /**
   * Full autofill entry point — fills the current page and any accessible iframes.
   */
  function doAutofillTokens(tokens) {
    fillFields(tokens, document);
    // Also fill same-origin iframes
    document.querySelectorAll('iframe').forEach(iframe => {
      try {
        const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iDoc) fillFields(tokens, iDoc);
      } catch (_) {}
    });
    showOverlay('✓ CredLock autofilled', 'success');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIELD PROCESSING — badge + shadow DOM for passwords
  // ═══════════════════════════════════════════════════════════════════════════

  function isSvInternal(node) {
    if (node?.getAttribute?.('data-sv-internal')) return true;
    let el = node?.parentElement;
    while (el) {
      if (el.getAttribute?.('data-sv-host')) return true;
      el = el.parentElement;
    }
    return false;
  }

  function badgeField(el, type) {
    if (el.dataset.svBadged) return;
    el.dataset.svBadged = 'true';
    el.style.borderColor = 'rgba(0,230,118,0.5)';
    el.style.boxShadow   = '0 0 0 2px rgba(0,230,118,0.1)';
    el.title = `CredLock: ${type}`;
  }

  function processFields(fields, root) {
    root = root || document;
    for (const { element, type } of fields) {
      if (element.dataset.svScanned) continue;
      element.dataset.svScanned = 'true';

      if (type === 'netbanking-password') {
        replaceWithSecureInput(element);
      } else {
        badgeField(element, type);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHADOW DOM SECURE INPUT  (for password fields)
  // ═══════════════════════════════════════════════════════════════════════════

  function replaceWithSecureInput(originalInput) {
    if (originalInput.dataset.svProcessed) return;
    originalInput.dataset.svProcessed = 'true';
    originalInput.style.display = 'none';

    const host   = document.createElement('span');
    host.setAttribute('data-sv-host', 'true');
    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host { display:inline-block; vertical-align:middle; width:100%; }
      input {
        border:2px solid #00e676; border-radius:4px; padding:6px 10px;
        font-size:inherit; font-family:inherit; outline:none;
        background:#0b0e14; color:#e8f0fe; width:100%; box-sizing:border-box;
      }
      input:focus { border-color:#00c85a; box-shadow:0 0 0 2px rgba(0,230,118,0.2); }
      .badge { display:block; font-size:10px; color:#00e676; margin-top:2px;
               font-family:monospace; letter-spacing:0.05em; }
    `;

    const secureInput        = document.createElement('input');
    secureInput.type         = 'password';
    secureInput.placeholder  = originalInput.placeholder || 'Password';
    secureInput.autocomplete = 'current-password';
    secureInput.setAttribute('data-sv-internal', 'true');

    const rect = originalInput.getBoundingClientRect();
    if (rect.width > 0) {
      secureInput.style.width = rect.width + 'px';
      host.style.width        = rect.width + 'px';
    }

    const badge       = document.createElement('span');
    badge.className   = 'badge';
    badge.textContent = '⬡ CredLock secured';

    shadow.appendChild(style);
    shadow.appendChild(secureInput);
    shadow.appendChild(badge);
    originalInput.parentNode.insertBefore(host, originalInput.nextSibling);

    let secureValue = '';

    secureInput.addEventListener('input', () => {
      secureValue = secureInput.value;
      nativeFill(originalInput, secureValue);
    });

    // Sync on any submit-like action
    function doSync() {
      nativeFill(originalInput, secureValue);
      if (secureValue) scheduleOfferSave(secureValue, originalInput);
    }

    const form = originalInput.closest('form');
    if (form) form.addEventListener('submit', doSync, true);

    const container = form || document.body;
    container.addEventListener('click', e => {
      const btn = e.target.closest('button,input[type=submit],[role=button]');
      if (!btn) return;
      const txt = (btn.textContent + btn.value + (btn.getAttribute('aria-label') || '')).toLowerCase();
      if (btn.type === 'submit' || /log|sign|submit|continue|proceed|next|enter|ok/i.test(txt)) {
        doSync();
      }
    }, true);

    window.addEventListener('beforeunload', () => {
      if (secureValue) persistPendingSave(secureValue, originalInput);
    });

    // Listen for autofill via sv-fill CustomEvent
    document.addEventListener('sv-fill', e => {
      const pw = e.detail?.password;
      if (!pw) return;
      const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (ns?.set) ns.set.call(secureInput, pw);
      else secureInput.value = pw;
      secureValue = pw;
      secureInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      nativeFill(originalInput, pw);

      if (e.detail.username) {
        const userEl = findUsernameField();
        if (userEl) nativeFill(userEl, e.detail.username);
      }
      showOverlay('✓ Password autofilled', 'success');
    });

    try {
      chrome.runtime.onMessage.addListener(msg => {
        if (msg.type === 'VAULT_LOCKED') { secureInput.value = ''; secureValue = ''; }
      });
    } catch (_) {}
  }

  function findUsernameField() {
    const usernameSelectors = FIELD_RULES.find(r => r.type === 'netbanking-username')?.selectors ?? [];
    for (const sel of usernameSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && !el.dataset.svProcessed && el.offsetParent !== null) return el;
      } catch (_) {}
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SAVE PROMPT
  // ═══════════════════════════════════════════════════════════════════════════

  function scheduleOfferSave(password, originalInput) {
    if (!password) return;
    persistPendingSave(password, originalInput);
  }

  function persistPendingSave(password, originalInput) {
    const userEl   = findUsernameField();
    const username = userEl?.value?.trim() || originalInput?.getAttribute('name') || '';
    try {
      sessionStorage.setItem('sv_pending_save', JSON.stringify({
        domain: location.hostname, username, password,
        fromUrl: location.href, ts: Date.now(),
      }));
    } catch (_) {}
  }

  function checkPendingSave() {
    let pending;
    try {
      const raw = sessionStorage.getItem('sv_pending_save');
      if (!raw) return;
      pending = JSON.parse(raw);
      sessionStorage.removeItem('sv_pending_save');
    } catch (_) { return; }

    if (pending.fromUrl === location.href) return;
    if (Date.now() - pending.ts > 60000) return;

    svSend({ type: 'LIST_CREDENTIALS', domain: pending.domain }).then(listRes => {
      const list = listRes?.list ?? [];
      if (!list.some(c => c.username === pending.username)) {
        showSavePrompt(pending.domain, pending.username, pending.password);
      }
    });
  }

  function showSavePrompt(domain, username, password) {
    if (document.getElementById('sv-save-prompt')) return;
    const bar = document.createElement('div');
    bar.id = 'sv-save-prompt';
    Object.assign(bar.style, {
      position:'fixed', bottom:'24px', left:'50%', transform:'translateX(-50%)',
      background:'#0b0e14', border:'1px solid #00e676',
      color:'#e8f0fe', padding:'12px 18px', borderRadius:'10px',
      zIndex:'2147483647', fontSize:'13px', fontFamily:'monospace',
      display:'flex', gap:'12px', alignItems:'center',
      boxShadow:'0 4px 16px rgba(0,0,0,0.5)', maxWidth:'420px',
    });
    bar.innerHTML = `<span style="flex:1">⬡ <strong>CredLock</strong> — Save password for <strong>${domain}</strong>?</span>`;

    const saveBtn = makeButton('Save',     '#00e676', '#0b0e14');
    const nope    = makeButton('Not now',  'transparent', '#00e676', '1px solid #00e676');
    bar.appendChild(saveBtn);
    bar.appendChild(nope);
    document.body.appendChild(bar);

    saveBtn.addEventListener('click', () => {
      svSend({ type: 'SAVE_CREDENTIAL', credential: { domain, username, password } })
        .then(res => {
          bar.remove();
          showOverlay(res?.ok ? '✓ Saved to CredLock' : 'Save failed', res?.ok ? 'success' : 'warn');
        });
    });
    nope.addEventListener('click', () => bar.remove());
    setTimeout(() => bar.parentNode && bar.remove(), 15000);
  }

  function makeButton(text, bg, color, border) {
    const b = document.createElement('button');
    b.textContent = text;
    Object.assign(b.style, {
      background: bg, border: border || 'none', color,
      padding:'6px 14px', borderRadius:'6px', cursor:'pointer',
      fontSize:'12px', fontWeight:'700',
    });
    return b;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTOFILL BANNER
  // ═══════════════════════════════════════════════════════════════════════════

  function showAutofillBanner(credentials) {
    if (document.getElementById('sv-autofill-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'sv-autofill-banner';
    Object.assign(banner.style, {
      position:'fixed', bottom:'24px', right:'20px',
      background:'#0b0e14', border:'2px solid #00e676', color:'#e8f0fe',
      padding:'12px 16px', borderRadius:'10px', zIndex:'2147483646',
      fontSize:'13px', fontFamily:'monospace',
      display:'flex', flexDirection:'column', gap:'8px',
      boxShadow:'0 4px 16px rgba(0,0,0,0.5)', maxWidth:'280px',
    });

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
    header.innerHTML = '<span>⬡ <strong>CredLock</strong></span>';
    const close = makeButton('×', 'transparent', '#00e676');
    close.style.fontSize = '18px';
    close.addEventListener('click', () => banner.remove());
    header.appendChild(close);
    banner.appendChild(header);

    for (const cred of credentials) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;';
      row.innerHTML = `<span style="flex:1;font-size:11px;color:#8fa3bc;">${cred.username || cred.holderName || '(saved)'}</span>`;
      const btn = makeButton(credentials.length === 1 ? 'Autofill' : 'Fill', '#00e676', '#0b0e14');
      btn.addEventListener('click', () => triggerAutofill(cred.id, banner));
      row.appendChild(btn);
      banner.appendChild(row);
    }

    document.body.appendChild(banner);
  }

  function triggerAutofill(credId, banner) {
    svSend({ type: 'AUTOFILL_REQUEST', credId }).then(res => {
      if (!res?.ok) {
        if (banner) banner.innerHTML = '<span style="color:#ef5350">Vault locked — unlock first</span>';
        return;
      }
      const cred = res.credential;
      if (cred.tokens) {
        // Card token path (INJECT_MASKED format)
        const tokenMap = {};
        cred.tokens.forEach(t => { tokenMap[t.fieldName] = t.maskedValue; });
        const tokens = buildTokensFromMap(tokenMap, cred.holderName);
        doAutofillTokens(tokens);
      } else {
        // Login / netbanking path
        document.dispatchEvent(new CustomEvent('sv-fill', {
          detail: { password: cred.password, username: cred.username }
        }));
      }
      if (banner) banner.remove();
    });
  }

  function buildTokensFromMap(map, holderName) {
    return [
      { type: 'card-number',     value: map['cc-number'] || map['cardnumber'] || '' },
      { type: 'cardholder-name', value: holderName || '' },
      { type: 'expiry',          value: map['cc-exp'] || map['expiry'] || '' },
      { type: 'cvv',             value: map['cc-csc'] || map['cvv'] || '' },
    ].filter(t => t.value);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OVERLAY NOTIFICATION
  // ═══════════════════════════════════════════════════════════════════════════

  let overlayTimer = null;
  function showOverlay(msg, type) {
    document.getElementById('sv-overlay')?.remove();
    const colors = {
      success: { bg:'#0F6E56', border:'#085041' },
      warn:    { bg:'#BA7517', border:'#854F0B' },
      danger:  { bg:'#A32D2D', border:'#791F1F' },
      info:    { bg:'#185FA5', border:'#0C447C' },
    };
    const c  = colors[type] ?? colors.info;
    const el = document.createElement('div');
    el.id    = 'sv-overlay';
    Object.assign(el.style, {
      position:'fixed', top:'20px', right:'20px',
      padding:'10px 16px', background:c.bg, border:`1px solid ${c.border}`,
      color:'white', borderRadius:'8px', zIndex:'2147483647',
      fontSize:'13px', fontFamily:'system-ui,sans-serif',
      boxShadow:'0 2px 8px rgba(0,0,0,0.3)', maxWidth:'320px',
      lineHeight:'1.4', pointerEvents:'none',
    });
    el.textContent = msg;
    document.body?.appendChild(el);
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => el.remove(), 3000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  // Payment / banking domains — activate regardless of URL path
  const PAYMENT_DOMAINS = new Set([
    'codepen.io', 'cdpn.io',           // CodePen (test page + embed)
    'stripe.com', 'js.stripe.com',
    'paypal.com',
    'razorpay.com', 'api.razorpay.com',
    'paytm.in', 'securegw.paytm.in',
    'payu.in', 'payumoney.com',
    'ccavenue.com', 'billdesk.com',
    'cashfree.com', 'easebuzz.in',
    'instamojo.com', 'zaakpay.com',
    'adyen.com', 'checkout.com',
    'braintreegateway.com', 'squareup.com',
    'klarna.com', 'afterpay.com', 'affirm.com',
    'amazon.in', 'amazon.com', 'amazon.co.uk',
    'flipkart.com', 'myntra.com', 'nykaa.com',
    'hdfcbank.com', 'icicibank.com', 'axisbank.com',
    'axisbank.co.in', 'sbi.co.in', 'onlinesbi.sbi',
    'onlinesbi.com', 'kotak.com', 'yesbank.in',
    'indusind.com', 'idfcfirstbank.com',
    'federalbank.co.in', 'rblbank.com',
    'acs.mastercard.com', 'verified-by-visa.com',
    '3ds.websdk.amazon.dev', '3dsecure.io',
  ]);

  const PAYMENT_URL_RE = /checkout|payment|billing|\/pay[/?#]|\/pay$|\/buy\/|\/gp\/buy|proceedtopay|netbanking|ibanking|onlinebanking|cart|transaction|processTransaction|theia\//i;

  function isPaymentPage() {
    const h = location.hostname.toLowerCase().replace(/^www\./, '');
    if (PAYMENT_DOMAINS.has(h)) return true;
    for (const d of PAYMENT_DOMAINS) {
      if (h.endsWith('.' + d)) return true;
    }
    if (PAYMENT_URL_RE.test(location.href)) return true;
    // If we're in an iframe, always run (we were injected for a reason)
    if (window.self !== window.top) return true;
    // Last resort: check if page has payment fields
    return document.querySelector(ALL_SELECTORS) !== null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS CHECK + BANNER
  // ═══════════════════════════════════════════════════════════════════════════

  function checkForSavedCredentials() {
    svSend({ type: 'VAULT_STATUS' }).then(res => {
      if (!res?.unlocked) return;
      svSend({ type: 'LIST_CREDENTIALS', domain: location.hostname }).then(listRes => {
        const list = listRes?.list ?? [];
        if (list.length > 0) showAutofillBanner(list);
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    if (!isPaymentPage()) return;

    const fields = scanFields(document);
    processFields(fields, document);
    scanSameOriginIframes();

    svSend({
      type: 'vault_requested',
      payload: {
        origin:       location.origin,
        fieldsFound:  fields.length,
        hasSavedCards: false,
        isIframe:     window.self !== window.top,
      },
    });

    // Show autofill banner a moment after load so it doesn't flash immediately
    setTimeout(checkForSavedCredentials, 800);
  }

  // ── Message listener ────────────────────────────────────────────────────────
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      switch (msg.type) {
        case 'VAULT_READY':
          processFields(scanFields(document), document);
          sendResponse({ ok: true });
          break;

        case 'VAULT_UNLOCKED':
          processFields(scanFields(document), document);
          checkForSavedCredentials();
          sendResponse({ ok: true });
          break;

        case 'INJECT_MASKED': {
          const tokens = buildTokensFromMap(
            Object.fromEntries((msg.payload ?? []).map(t => [t.fieldName, t.maskedValue])),
            msg.payload?.find(t => t.fieldName === 'cardholder-name')?.maskedValue
          );
          doAutofillTokens(tokens);
          svSend({ type: 'vault_data_filled', payload: { fields: (msg.payload ?? []).map(t => t.fieldName) } });
          sendResponse({ ok: true });
          break;
        }

        case 'VAULT_LOCKED':
          document.getElementById('sv-autofill-banner')?.remove();
          sendResponse({ ok: true });
          break;

        case 'SV_SAVE_COMPLETE':
          showOverlay('✓ Saved to CredLock', 'success');
          sendResponse({ ok: true });
          break;
      }
      return true;
    });
  } catch (_) {}

  // ── MutationObserver — handles dynamically injected fields (SPAs, iframes) ──
  const observer = new MutationObserver(mutations => {
    let found = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Check the node itself
        const type = detectFieldType(node);
        if (type && !node.dataset.svScanned && !isSvInternal(node)) {
          node.dataset.svScanned = 'true';
          processFields([{ element: node, type }], document);
          found = true;
        }
        // Check children
        try {
          node.querySelectorAll(ALL_SELECTORS).forEach(el => {
            if (el.dataset.svScanned || isSvInternal(el)) return;
            const t = detectFieldType(el);
            if (t) {
              processFields([{ element: el, type: t }], document);
              found = true;
            }
          });
        } catch (_) {}
      }
    }
    if (found) setTimeout(checkForSavedCredentials, 500);
  });

  // ── SPA URL watcher ──────────────────────────────────────────────────────────
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      document.getElementById('sv-autofill-banner')?.remove();
      document.getElementById('sv-save-prompt')?.remove();
      setTimeout(init, 400);
    }
  });

  // ── Window focus — re-check when user returns to tab ──────────────────────
  window.addEventListener('focus', checkForSavedCredentials);

  // ── Bootstrap ────────────────────────────────────────────────────────────────
  function bootstrap() {
    checkPendingSave();
    init();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    urlObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  console.log('[CredLock] Content script loaded —', location.hostname, window.self !== window.top ? '(iframe)' : '(top)');
})();