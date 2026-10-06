/* Prompt Shelf: decrypts the prompt library in the browser and keeps it in memory only.
   Crypto must stay in step with shelf-src/lib.mjs:
   PBKDF2-SHA256, 600000 iterations, 16-byte salt, AES-256-GCM, 12-byte IV, base64. */
(function () {
  'use strict';

  var FORMAT = { v: 1, kdf: 'PBKDF2-SHA256', iter: 600000, cipher: 'AES-256-GCM', saltBytes: 16, ivBytes: 12 };
  var TARGETS = ['web-llm', 'api', 'n8n', 'python', 'general'];
  // {{name}} is a field; \{{name}} is literal text. Names are identifiers only, so n8n
  // expressions such as {{ $json.id }} are left alone.
  var FIELD_RE = /(\\?)\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;

  // ---------- core (no DOM; also run by shelf-src under Node) ----------

  function b64ToBytes(s) {
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function decryptBlob(blob, passphrase) {
    if (!blob || blob.v !== FORMAT.v || blob.kdf !== FORMAT.kdf || blob.cipher !== FORMAT.cipher || blob.iter !== FORMAT.iter) {
      throw new Error('FORMAT');
    }
    var salt = b64ToBytes(blob.salt);
    var iv = b64ToBytes(blob.iv);
    if (salt.length !== FORMAT.saltBytes || iv.length !== FORMAT.ivBytes) throw new Error('FORMAT');
    var subtle = crypto.subtle;
    var material = await subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    var key = await subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: FORMAT.iter },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    var plain;
    try {
      plain = await subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, b64ToBytes(blob.ct));
    } catch (e) {
      throw new Error('PASSPHRASE');
    }
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function fieldNames(body) {
    var names = [];
    body.replace(FIELD_RE, function (m, esc, name) {
      if (!esc && names.indexOf(name) === -1) names.push(name);
      return m;
    });
    return names;
  }

  // Splits a body into text and field segments: [{text}|{field}]. Escapes are resolved.
  function segments(body) {
    var out = [];
    var last = 0;
    body.replace(FIELD_RE, function (m, esc, name, offset) {
      out.push({ text: body.slice(last, offset) });
      out.push(esc ? { text: m.slice(1) } : { field: name, raw: m });
      last = offset + m.length;
      return m;
    });
    out.push({ text: body.slice(last) });
    return out.filter(function (s) { return s.field || s.text; });
  }

  // Fills fields from values; empty fields stay as {{name}} so nothing silently disappears.
  function fill(body, values) {
    return segments(body).map(function (s) {
      if (!s.field) return s.text;
      var v = values && values[s.field];
      return v ? v : '{{' + s.field + '}}';
    }).join('');
  }

  function searchPrompts(prompts, query, target, tags) {
    var terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    var results = [];
    prompts.forEach(function (p) {
      if (target && p.target !== target) return;
      for (var i = 0; i < (tags || []).length; i++) if (p.tags.indexOf(tags[i]) === -1) return;
      var title = p.title.toLowerCase();
      var meta = (p.tags.join(' ') + ' ' + p.target).toLowerCase();
      var body = p.body.toLowerCase();
      var score = 0;
      for (var j = 0; j < terms.length; j++) {
        var t = terms[j];
        var s = (title.indexOf(t) !== -1 ? 4 : 0) + (meta.indexOf(t) !== -1 ? 2 : 0) + (body.indexOf(t) !== -1 ? 1 : 0);
        if (!s) return;
        score += s;
      }
      results.push({ p: p, score: score });
    });
    results.sort(function (a, b) { return b.score - a.score || a.p.title.localeCompare(b.p.title); });
    return results.map(function (r) { return r.p; });
  }

  var core = { FORMAT: FORMAT, TARGETS: TARGETS, b64ToBytes: b64ToBytes, decryptBlob: decryptBlob,
    fieldNames: fieldNames, segments: segments, fill: fill, searchPrompts: searchPrompts };
  if (typeof globalThis !== 'undefined') globalThis.ShelfCore = core;
  if (typeof document === 'undefined') return;

  // ---------- UI ----------

  var $ = function (id) { return document.getElementById(id); };
  var state = { prompts: [], cards: new Map(), visible: [], tags: [], values: new Map() };
  var statusTimer = 0;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function embeddedBlob() {
    var node = $('shelf-data');
    var raw = node ? node.textContent.trim() : '';
    return raw ? JSON.parse(raw) : null;
  }

  async function loadBlob() {
    var blob = embeddedBlob();
    if (blob) return blob;
    var res;
    try {
      res = await fetch('data.enc.json', { cache: 'no-store' });
    } catch (e) {
      throw new Error('LOAD');
    }
    if (!res.ok) throw new Error('LOAD');
    return res.json();
  }

  function setLockMsg(text, isError) {
    var m = $('lock-msg');
    m.textContent = text;
    m.classList.toggle('error', !!isError);
  }

  async function unlock() {
    var pass = $('pass').value;
    if (!pass) { setLockMsg('Enter the passphrase.', true); return; }
    if (!window.crypto || !crypto.subtle) {
      setLockMsg('This page cannot decrypt here: the browser hides WebCrypto on plain http. Use the https address or the offline file.', true);
      return;
    }
    $('unlock').disabled = true;
    $('pass').disabled = true;
    setLockMsg('Unlocking...', false);
    try {
      var data = await decryptBlob(await loadBlob(), pass);
      $('pass').value = '';
      start(data);
    } catch (e) {
      var msg = {
        PASSPHRASE: 'Wrong passphrase.',
        FORMAT: 'The data file is from a different shelf version. Rebuild at home.',
        LOAD: location.protocol === 'file:'
          ? 'No data in this file. Open the offline copy (shelf.html) instead of index.html.'
          : 'Could not load data.enc.json. Has the shelf been built and pushed?'
      }[e.message] || 'Could not unlock: ' + e.message;
      setLockMsg(msg, true);
      $('pass').disabled = false;
      $('unlock').disabled = false;
      $('pass').select();
    }
  }

  function start(data) {
    state.prompts = data.prompts || [];
    $('lock').hidden = true;
    $('app').hidden = false;
    $('built').textContent = 'Built ' + String(data.built || '').slice(0, 10) + ', ' + state.prompts.length + ' prompts';

    var targets = TARGETS.filter(function (t) { return state.prompts.some(function (p) { return p.target === t; }); });
    targets.forEach(function (t) { $('target').appendChild(new Option(t, t)); });

    var allTags = [];
    state.prompts.forEach(function (p) { p.tags.forEach(function (t) { if (allTags.indexOf(t) === -1) allTags.push(t); }); });
    allTags.sort().forEach(function (t) {
      var b = el('button', 'chip', t);
      b.type = 'button';
      b.dataset.tag = t;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () { toggleTag(t); });
      $('tags').appendChild(b);
    });

    state.prompts.forEach(function (p) { state.cards.set(p.id, buildCard(p)); });
    render();
    $('q').focus();
  }

  function toggleTag(t) {
    var i = state.tags.indexOf(t);
    if (i === -1) state.tags.push(t); else state.tags.splice(i, 1);
    Array.prototype.forEach.call($('tags').children, function (b) {
      b.setAttribute('aria-pressed', state.tags.indexOf(b.dataset.tag) !== -1 ? 'true' : 'false');
    });
    render();
  }

  function render() {
    state.visible = searchPrompts(state.prompts, $('q').value, $('target').value, state.tags);
    var list = $('list');
    var frag = document.createDocumentFragment();
    state.visible.forEach(function (p) { frag.appendChild(state.cards.get(p.id)); });
    list.replaceChildren(frag);
    $('count').textContent = state.visible.length + ' of ' + state.prompts.length;
    $('empty').hidden = state.visible.length > 0;
    if (state.visible.length === 1) setExpanded(state.visible[0], true);
  }

  function valuesFor(p) {
    if (!state.values.has(p.id)) state.values.set(p.id, {});
    return state.values.get(p.id);
  }

  function buildCard(p) {
    var card = el('article', 'card');
    card.tabIndex = 0;
    card.dataset.id = p.id;

    var head = el('div', 'card-head');
    var title = el('h2', 'title', p.title);
    title.addEventListener('click', function () { setExpanded(p); });
    head.appendChild(title);
    head.appendChild(el('span', 'target', p.target));
    card.appendChild(head);

    if (p.tags.length) {
      var tags = el('div', 'card-tags');
      p.tags.forEach(function (t) {
        var b = el('button', 'tag', t);
        b.type = 'button';
        b.tabIndex = -1;
        b.addEventListener('click', function () { if (state.tags.indexOf(t) === -1) toggleTag(t); });
        tags.appendChild(b);
      });
      card.appendChild(tags);
    }

    var names = fieldNames(p.body);
    var fields = el('div', 'fields');
    names.forEach(function (name) {
      var label = el('label', 'field');
      label.appendChild(el('span', 'field-name', name.replace(/_/g, ' ')));
      var input = el('textarea');
      input.rows = 1;
      input.spellcheck = false;
      input.dataset.field = name;
      input.addEventListener('input', function () {
        valuesFor(p)[name] = input.value;
        autosize(input);
        updatePreview(p);
      });
      label.appendChild(input);
      fields.appendChild(label);
    });
    card.appendChild(fields);

    var preview = el('pre', 'preview');
    preview.addEventListener('click', function () { if (!card.classList.contains('open')) setExpanded(p, true); });
    card.appendChild(preview);

    var actions = el('div', 'actions');
    var copy = el('button', 'copy', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', function () { copyCard(p); });
    var toggle = el('button', 'toggle', names.length ? 'Fill ' + names.length + (names.length === 1 ? ' field' : ' fields') : 'Expand');
    toggle.type = 'button';
    toggle.addEventListener('click', function () { setExpanded(p); });
    var dl = el('button', 'dl', 'Download .md');
    dl.type = 'button';
    dl.addEventListener('click', function () { download(p); });
    actions.appendChild(copy);
    actions.appendChild(toggle);
    actions.appendChild(dl);
    actions.appendChild(el('span', 'meta'));
    card.appendChild(actions);

    card.addEventListener('keydown', function (e) { cardKey(e, p); });
    card._parts = { preview: preview, fields: fields, copy: copy, toggle: toggle, meta: actions.lastChild, names: names, label: toggle.textContent };
    updatePreview(p, card);
    return card;
  }

  function autosize(t) {
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight + 2, 320) + 'px';
  }

  function updatePreview(p, cardArg) {
    var card = cardArg || state.cards.get(p.id);
    var parts = card._parts;
    var values = valuesFor(p);
    var frag = document.createDocumentFragment();
    segments(p.body).forEach(function (s) {
      if (!s.field) { frag.appendChild(document.createTextNode(s.text)); return; }
      var v = values[s.field];
      frag.appendChild(v ? el('span', 'filled', v) : el('mark', 'hole', '{{' + s.field + '}}'));
    });
    parts.preview.replaceChildren(frag);
    var text = fill(p.body, values);
    var empty = parts.names.filter(function (n) { return !values[n]; }).length;
    parts.meta.textContent = '~' + Math.ceil(text.length / 4).toLocaleString('en-US') + ' tokens' +
      (parts.names.length ? ', ' + (parts.names.length - empty) + '/' + parts.names.length + ' filled' : '');
  }

  function setExpanded(p, force) {
    var card = state.cards.get(p.id);
    var open = force === undefined ? !card.classList.contains('open') : force;
    card.classList.toggle('open', open);
    card._parts.toggle.textContent = open ? 'Collapse' : card._parts.label;
    if (open) Array.prototype.forEach.call(card.querySelectorAll('textarea'), autosize);
  }

  function focusFirstField(p) {
    setExpanded(p, true);
    var t = state.cards.get(p.id).querySelector('textarea');
    if (t) t.focus();
  }

  function cardKey(e, p) {
    var card = state.cards.get(p.id);
    var inField = e.target.tagName === 'TEXTAREA';
    if (inField && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); copyCard(p); return; }
    if (inField && e.key === 'Escape') { e.preventDefault(); card.focus(); return; }
    if (e.target !== card) return;
    if (e.key === 'Enter') { e.preventDefault(); copyCard(p); }
    else if (e.key === ' ') { e.preventDefault(); setExpanded(p); }
    else if (e.key === 'f' && card._parts.names.length) { e.preventDefault(); focusFirstField(p); }
    else if (e.key === 'd') { e.preventDefault(); download(p); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveFocus(p, e.key === 'ArrowDown' ? 1 : -1); }
  }

  function moveFocus(p, step) {
    var i = state.visible.indexOf(p) + step;
    if (i < 0) { $('q').focus(); return; }
    if (i < state.visible.length) state.cards.get(state.visible[i].id).focus();
  }

  function showStatus(text, isError) {
    var s = $('status');
    s.textContent = text;
    s.classList.toggle('error', !!isError);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { s.textContent = ''; }, 4000);
  }

  async function copyCard(p) {
    var card = state.cards.get(p.id);
    var values = valuesFor(p);
    var text = fill(p.body, values);
    var empty = card._parts.names.filter(function (n) { return !values[n]; });
    var ok = await copyText(text);
    if (!ok) { manualCopy(text); return; }
    var btn = card._parts.copy;
    btn.textContent = 'Copied';
    btn.classList.add('done');
    setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1400);
    showStatus(empty.length
      ? 'Copied "' + p.title + '" with ' + empty.length + ' empty field' + (empty.length === 1 ? '' : 's') + ': ' + empty.join(', ')
      : 'Copied "' + p.title + '"', empty.length > 0);
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    }
    var active = document.activeElement;
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'offscreen';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (active && active.focus) active.focus();
    return ok;
  }

  function manualCopy(text) {
    var box = $('manual-text');
    box.value = text;
    $('manual').hidden = false;
    box.focus();
    box.select();
  }

  function download(p) {
    // The prompt as authored, without front matter, for Notepad++ or an API system prompt.
    var text = segments(p.body).map(function (s) { return s.field ? s.raw : s.text; }).join('');
    var url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = p.id + '.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    showStatus('Downloaded ' + p.id + '.md');
  }

  function isTyping(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
  }

  function init() {
    if (embeddedBlob()) $('offline').hidden = true;
    $('unlock').addEventListener('click', unlock);
    $('pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });
    $('pass').focus();

    $('q').addEventListener('input', render);
    $('q').addEventListener('keydown', function (e) {
      var first = state.visible[0];
      if (e.key === 'Escape') { $('q').value = ''; render(); }
      else if (e.key === 'ArrowDown' && first) { e.preventDefault(); state.cards.get(first.id).focus(); }
      else if (e.key === 'Enter' && first) {
        e.preventDefault();
        if (state.cards.get(first.id)._parts.names.length) focusFirstField(first); else copyCard(first);
      }
    });
    $('target').addEventListener('change', render);
    $('lockbtn').addEventListener('click', function () { location.reload(); });
    $('manual-close').addEventListener('click', function () { $('manual').hidden = true; $('manual-text').value = ''; });

    document.addEventListener('keydown', function (e) {
      if ($('app').hidden) return;
      if (!$('manual').hidden) {
        if (e.key === 'Escape') { $('manual-close').click(); }
        return;
      }
      if (e.key === '/' && !isTyping(e.target)) { e.preventDefault(); $('q').focus(); $('q').select(); }
      else if (e.key === 'Escape' && !isTyping(e.target)) { $('q').focus(); }
    });
  }

  init();
})();
