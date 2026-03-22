/**
 * dist/content.js
 * SecureVault — Bundled Content Script
 *
 * Inlines merchant_site.js + merchant_dom_adapter.js logic as a single IIFE
 * so Chrome can load it as a standard (non-module) content script.
 *
 * Activates on payment/checkout pages detected by the manifest URL patterns.
 * Handles VAULT_READY, VAULT_UNLOCKED, INJECT_MASKED messages from background.
 */
(function () {
  'use strict';

  // ── Safe message sender ────────────────────────────────────────────────────

  function svSend(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      if (e.message?.includes('invalidated') || e.message?.includes('Extension context')) {
        svDetach();
      }
      return Promise.resolve();
    }
  }

  function svDetach() {
    document.querySelectorAll('[data-sv-host]').forEach(host => {
      const prev = host.previousElementSibling;
      if (prev?.dataset?.svProcessed) prev.style.display = '';
      host.remove();
    });
    document.getElementById('sv-autofill-banner')?.remove();
    document.getElementById('sv-save-prompt')?.remove();
  }

  // ── ALLOWED_FIELDS (mirrors sandbox_policy.js) ─────────────────────────────

  const ALLOWED_FIELDS = new Set([
    'cc-number','cardnumber','card-number','cc-exp','cc-exp-month',
    'cc-exp-year','cc-csc','cvv','cvc','expiry','expiration',
    'otp','one-time-password','cardholder-name','cardholder','billing-name',
  ]);

  // ── DOM adapter ────────────────────────────────────────────────────────────

  const FIELD_SELECTORS = [
    'input[autocomplete="cc-number"]',
    'input[autocomplete="cc-exp"]',
    'input[autocomplete="cc-csc"]',
    'input[name*="card"][type="text"]',
    'input[name*="card"][type="tel"]',
    'input[name*="cardnumber"]',
    'input[name*="cvv"]',
    'input[name*="cvc"]',
    'input[name*="expiry"]',
    'input[name*="otp"]',
    'input[placeholder*="Card number" i]',
    'input[placeholder*="CVV" i]',
    'input[data-vault-field]',
    // Also catch standard password fields for login pages
    'input[type="password"]',
    'input[autocomplete="current-password"]',
  ].join(',');

  function getFieldId(el) {
    return (
      el.getAttribute('data-vault-field') ||
      el.getAttribute('autocomplete') ||
      el.getAttribute('name') ||
      el.getAttribute('id') ||
      el.getAttribute('placeholder') ||
      (el.type === 'password' ? 'password' : 'unknown')
    ).toLowerCase().trim();
  }

  function nativeSet(el, value) {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function getFormFields() {
    const seen = new Set(), found = [];
    document.querySelectorAll(FIELD_SELECTORS).forEach(el => {
      if (seen.has(el) || isSvInternal(el)) return;
      seen.add(el);
      found.push({ element: el, fieldId: getFieldId(el) });
    });
    return found;
  }

  function setAutofilledData(tokens) {
    for (const { fieldName, maskedValue } of tokens) {
      if (!ALLOWED_FIELDS.has(fieldName) && fieldName !== 'password') continue;
      const el = findByFieldId(fieldName);
      if (el) nativeSet(el, maskedValue);
    }
  }

  function findByFieldId(fieldId) {
    const id = fieldId.toLowerCase();
    for (const sel of [
      `[data-vault-field="${id}"]`,
      `[autocomplete="${id}"]`,
      `[name="${id}"]`,
      `[name*="${id}"]`,
      `[id="${id}"]`,
    ]) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    if (id === 'password') return document.querySelector('input[type="password"]:not([data-sv-processed])');
    return null;
  }

  function attachBadges(fields) {
    for (const { element, fieldId } of fields) {
      if (element.dataset.svBadged) continue;
      element.dataset.svBadged = 'true';
      element.style.borderColor = 'rgba(0,230,118,0.5)';
      element.style.boxShadow   = '0 0 0 2px rgba(0,230,118,0.12)';
      element.title = `SecureVault: ${fieldId}`;
    }
  }

  function markAutofillReady(fields) {
    for (const { element } of fields) {
      element.style.borderColor = '#00e676';
      element.style.boxShadow   = '0 0 0 2px rgba(0,230,118,0.2)';
    }
  }

  // ── Shadow DOM secure input (for password fields on login pages) ───────────

  function isSvInternal(node) {
    if (node.getAttribute?.('data-sv-internal')) return true;
    let el = node.parentElement;
    while (el) {
      if (el.getAttribute?.('data-sv-host')) return true;
      el = el.parentElement;
    }
    return false;
  }

  let overlayTimer = null;
  function showOverlay(msg, type) {
    document.getElementById('sv-overlay')?.remove();
    const colors = {
      warn:    { bg:'#BA7517', border:'#854F0B' },
      danger:  { bg:'#A32D2D', border:'#791F1F' },
      success: { bg:'#0F6E56', border:'#085041' },
      info:    { bg:'#185FA5', border:'#0C447C' },
    };
    const c = colors[type] ?? colors.warn;
    const el = document.createElement('div');
    el.id = 'sv-overlay';
    Object.assign(el.style, {
      position:'fixed', top:'20px', right:'20px',
      padding:'10px 16px', background:c.bg, border:`1px solid ${c.border}`,
      color:'white', borderRadius:'8px', zIndex:'2147483647',
      fontSize:'13px', fontFamily:'system-ui,sans-serif',
      boxShadow:'0 2px 8px rgba(0,0,0,0.3)', maxWidth:'320px',
      lineHeight:'1.4', pointerEvents:'none',
    });
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => el.remove(), 3000);
  }

  function createShadowInput(originalInput) {
    originalInput.style.display = 'none';
    const host   = document.createElement('span');
    host.setAttribute('data-sv-host', 'true');
    const shadow = host.attachShadow({ mode: 'closed' });

    const style  = document.createElement('style');
    style.textContent = `
      :host { display:inline-block; vertical-align:middle; }
      input { border:2px solid #00e676; border-radius:4px; padding:4px 8px;
              font-size:inherit; font-family:inherit; outline:none;
              background:#0b0e14; color:#e8f0fe; width:100%; box-sizing:border-box; }
      input:focus { border-color:#00c85a; box-shadow:0 0 0 2px rgba(0,230,118,0.2); }
      .sv-badge { display:block; font-size:10px; color:#00e676; margin-top:2px;
                  font-family:monospace; letter-spacing:0.05em; }
    `;

    const secureInput = document.createElement('input');
    secureInput.type         = 'password';
    secureInput.placeholder  = originalInput.placeholder || 'Enter securely';
    secureInput.autocomplete = 'off';
    secureInput.setAttribute('data-sv-internal', 'true');

    const rect = originalInput.getBoundingClientRect();
    if (rect.width > 0) {
      secureInput.style.width = rect.width + 'px';
      host.style.width        = rect.width + 'px';
    }

    const badge = document.createElement('span');
    badge.className   = 'sv-badge';
    badge.textContent = '⬡ SecureVault';

    shadow.appendChild(style);
    shadow.appendChild(secureInput);
    shadow.appendChild(badge);
    originalInput.parentNode.insertBefore(host, originalInput.nextSibling);

    return { host, secureInput };
  }

  function replaceWithSecureInput(originalInput) {
    if (originalInput.dataset.svProcessed) return;
    originalInput.dataset.svProcessed = 'true';
    const { secureInput } = createShadowInput(originalInput);
    let secureValue = '';

    secureInput.addEventListener('input', () => {
      secureValue = secureInput.value;
      nativeSet(originalInput, secureValue);
      svSend({ type: 'PASSWORD_INPUT', length: secureValue.length });
    });

    // Sync on form submit and login button clicks
    function doSync() {
      nativeSet(originalInput, secureValue);
      scheduleOfferSave(secureValue, originalInput);
    }

    // 1. Native form submit event (most reliable)
    const form = originalInput.closest('form');
    if (form) form.addEventListener('submit', doSync, true);

    // 2. Click on ANY button inside the form / container (catches JS-driven portals)
    const container = form || originalInput.closest('div,section,main') || document.body;
    container.addEventListener('click', e => {
      const btn = e.target.closest('button,input[type=submit],[role=button],a[href]');
      if (!btn) return;
      const txt = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').toLowerCase();
      // Match any login/submit-like text OR any submit input
      if (btn.type === 'submit' ||
          txt.includes('log') || txt.includes('sign') ||
          txt.includes('submit') || txt.includes('continue') ||
          txt.includes('proceed') || txt.includes('enter') ||
          txt.includes('next') || txt.includes('ok')) {
        doSync();
      }
    }, true);

    // 3. beforeunload safety net — fires right before ANY navigation
    // This guarantees we capture the credentials even if button detection missed
    window.addEventListener('beforeunload', () => {
      if (secureValue) {
        // Grab username at the last possible moment
        let username = '';
        const candidates = document.querySelectorAll(
          'input[type="text"],input[type="email"],input[name*="user"],input[name*="roll"],input[id*="user"],input[name*="email"]'
        );
        for (const c of candidates) {
          if (c.value && !c.dataset.svProcessed) { username = c.value.trim(); break; }
        }
        try {
          sessionStorage.setItem('sv_pending_save', JSON.stringify({
            domain:   location.hostname,
            username,
            password: secureValue,
            fromUrl:  location.href,
            ts:       Date.now(),
          }));
        } catch (_) {}
      }
    });

    // Listen for sv-fill CustomEvent (autofill path)
    document.addEventListener('sv-fill', e => {
      const pw = e.detail?.password;
      if (!pw) return;
      const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (ns?.set) ns.set.call(secureInput, pw);
      else secureInput.value = pw;
      secureValue = pw;
      secureInput.dispatchEvent(new Event('input',  { bubbles: true, composed: true }));
      nativeSet(originalInput, pw);

      // Fill username too if provided
      if (e.detail.username) {
        const userEls = document.querySelectorAll(
          'input[type="text"],input[type="email"],input[name*="user"],input[name*="roll"],input[id*="user"],input[name*="email"],input[id*="email"]'
        );
        for (const u of userEls) {
          if (!u.dataset.svProcessed && u.offsetParent !== null) {
            nativeSet(u, e.detail.username);
            break;
          }
        }
      }
      showOverlay('Password autofilled ✓', 'success');
    });

    try {
      chrome.runtime.onMessage.addListener(msg => {
        if (msg.type === 'VAULT_LOCKED') {
          secureInput.value = '';
          secureValue = '';
        }
      });
    } catch (_) {}
  }

  // ── Save-offer prompt ──────────────────────────────────────────────────────

  function scheduleOfferSave(password, originalInput) {
    if (!password) return;
    // beforeunload listener handles sessionStorage persistence.
    // This function is kept as a hook for direct (non-navigation) saves.
    let username = '';
    const candidates = document.querySelectorAll(
      'input[type="text"],input[type="email"],input[name*="user"],input[name*="roll"],input[id*="user"],input[name*="email"]'
    );
    for (const c of candidates) {
      if (c.value && !c.dataset.svProcessed) { username = c.value.trim(); break; }
    }
    try {
      sessionStorage.setItem('sv_pending_save', JSON.stringify({
        domain:   location.hostname,
        username,
        password,
        fromUrl:  location.href,
        ts:       Date.now(),
      }));
    } catch (_) {}
  }

  // Check on every page load if there's a pending save from a previous page
  function checkPendingSave() {
    let pending;
    try {
      const raw = sessionStorage.getItem('sv_pending_save');
      if (!raw) return;
      pending = JSON.parse(raw);
      sessionStorage.removeItem('sv_pending_save');
    } catch (_) { return; }

    // Only show if we actually navigated away from the login page
    if (pending.fromUrl === location.href) return;

    // Only show if not too old (10 seconds)
    if (Date.now() - pending.ts > 10000) return;

    // Check vault is unlocked and credential not already saved
    svSend({ type: 'VAULT_STATUS' }).then(res => {
      if (!res?.unlocked) return;
      svSend({ type: 'LIST_CREDENTIALS', domain: pending.domain }).then(listRes => {
        const list = listRes?.list ?? [];
        if (!list.some(c => c.username === pending.username)) {
          showSavePrompt(pending.domain, pending.username, pending.password);
        }
      });
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
    bar.innerHTML = `<span style="flex:1">⬡ <strong>SecureVault</strong> — Save password for <strong>${domain}</strong>?</span>`;

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    Object.assign(saveBtn.style, {
      background:'#00e676', border:'none', color:'#0b0e14',
      padding:'6px 14px', borderRadius:'6px', cursor:'pointer',
      fontSize:'12px', fontWeight:'700',
    });

    const nope = document.createElement('button');
    nope.textContent = 'Not now';
    Object.assign(nope.style, {
      background:'transparent', border:'1px solid #00e676', color:'#00e676',
      padding:'6px 12px', borderRadius:'6px', cursor:'pointer', fontSize:'12px',
    });

    bar.appendChild(saveBtn);
    bar.appendChild(nope);
    document.body.appendChild(bar);

    saveBtn.addEventListener('click', () => {
      svSend({ type: 'SAVE_CREDENTIAL', credential: { domain, username, password } })
        .then(res => {
          bar.remove();
          if (res?.ok) showOverlay('Password saved to SecureVault ✓', 'success');
          else if (res?.reason === 'locked') showOverlay('Vault locked — unlock first', 'warn');
        });
    });
    nope.addEventListener('click', () => bar.remove());
    setTimeout(() => bar.parentNode && bar.remove(), 15000);
  }

  // ── Autofill banner ────────────────────────────────────────────────────────

  function showAutofillBanner() {
    if (document.getElementById('sv-autofill-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'sv-autofill-banner';
    Object.assign(banner.style, {
      position:'fixed', bottom:'24px', right:'20px',
      background:'#0b0e14', border:'2px solid #00e676', color:'#e8f0fe',
      padding:'12px 16px', borderRadius:'10px', zIndex:'2147483646',
      fontSize:'13px', fontFamily:'monospace',
      display:'flex', gap:'10px', alignItems:'center',
      boxShadow:'0 4px 16px rgba(0,0,0,0.5)',
    });
    banner.innerHTML = `<span>⬡ <strong>SecureVault</strong> — saved credentials found</span>` +
      `<button id="sv-autofill-btn" style="background:#00e676;border:none;color:#0b0e14;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;">Autofill</button>` +
      `<button id="sv-autofill-close" style="background:transparent;border:none;color:#00e676;cursor:pointer;font-size:18px;padding:0 4px;">×</button>`;
    document.body.appendChild(banner);

    document.getElementById('sv-autofill-btn').addEventListener('click', () => {
      svSend({ type: 'AUTOFILL_REQUEST' }).then(res => {
        if (res?.ok && res?.credential) {
          if (res.credential.tokens) {
            // Card autofill via tokens
            setAutofilledData(res.credential.tokens);
            banner.remove();
          } else {
            // Password autofill via sv-fill event
            document.dispatchEvent(new CustomEvent('sv-fill', {
              detail: { password: res.credential.password, username: res.credential.username }
            }));
            banner.remove();
          }
        } else if (res?.reason === 'locked') {
          banner.textContent = '⬡ Vault locked — open popup and unlock first.';
        }
      });
    });
    document.getElementById('sv-autofill-close').addEventListener('click', () => banner.remove());
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function isPaymentPage() {
    const url = location.href;
    return /checkout|payment|\/pay\b|billing|cart|studzone|portal|login|signin/i.test(url);
  }

  async function init() {
    const fields = getFormFields();

    // Process password fields with Shadow DOM
    for (const { element, fieldId } of fields) {
      if (fieldId === 'password' || fieldId === 'current-password') {
        replaceWithSecureInput(element);
      }
    }

    // Badge card fields
    const cardFields = fields.filter(f => f.fieldId !== 'password' && f.fieldId !== 'current-password');
    if (cardFields.length > 0) {
      attachBadges(cardFields);
    }

    if (!isPaymentPage() && fields.length === 0) return;

    // Notify background
    const hasSaved = await svSend({
      type: 'vault_requested',
      payload: { origin: location.origin, fieldsFound: fields.length, hasSavedCards: false },
    }).then(r => r?.allowed).catch(() => false);

    // Check vault status and show autofill banner if credentials exist
    let attempts = 0;
    function checkStatus() {
      svSend({ type: 'VAULT_STATUS' }).then(res => {
        if (res?.unlocked) {
          svSend({ type: 'LIST_CREDENTIALS', domain: location.hostname }).then(listRes => {
            if (listRes?.list?.length > 0) showAutofillBanner();
          });
        } else if (attempts++ < 5) {
          setTimeout(checkStatus, 800 * attempts);
        }
      });
    }
    checkStatus();
  }

  // ── Message listener ───────────────────────────────────────────────────────

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      switch (msg.type) {
        case 'VAULT_READY':
          attachBadges(getFormFields());
          sendResponse({ ok: true });
          break;

        case 'VAULT_UNLOCKED':
          markAutofillReady(getFormFields());
          sendResponse({ ok: true });
          break;

        case 'INJECT_MASKED':
          setAutofilledData(msg.payload ?? []);
          svSend({ type: 'vault_data_filled', payload: { fields: (msg.payload ?? []).map(t => t.fieldName) } });
          sendResponse({ ok: true });
          break;

        case 'VAULT_LOCKED':
          document.getElementById('sv-autofill-banner')?.remove();
          sendResponse({ ok: true });
          break;
      }
      return true;
    });
  } catch (_) {}

  // ── MutationObserver for SPAs ───────────────────────────────────────────────

  const observer = new MutationObserver(() => {
    document.querySelectorAll(FIELD_SELECTORS).forEach(el => {
      if (!el.dataset.svProcessed && !isSvInternal(el)) {
        const fieldId = getFieldId(el);
        if (fieldId === 'password' || fieldId === 'current-password') {
          replaceWithSecureInput(el);
        } else {
          attachBadges([{ element: el, fieldId }]);
        }
      }
    });
  });

  if (document.body) {
    checkPendingSave();
    init();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      checkPendingSave();
      init();
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  console.log('[SecureVault] Content script loaded on', location.hostname);
})();
