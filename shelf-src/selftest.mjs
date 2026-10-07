// Self-test for prompt-shelf: crypto compatibility, template logic, and a UI smoke test that
// runs the real shelf/app.js against a small fake DOM. Uses synthetic prompts only.
// Run: node shelf-src/selftest.mjs
// Optional: SHELF_PASSPHRASE=... also decrypts the built shelf/data.enc.json and compares it
// with shelf-src/content/.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { SHELF, FORMAT, encrypt, decryptNode, loadCore, buildSingleFile, embeddedBlob, loadContent, parseFrontmatter } from './lib.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); } catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.stack.split('\n').slice(0, 3).join('\n        ')}`); }
}

const FIXTURE = {
  v: 1,
  built: '2026-01-02T03:04:05.000Z',
  prompts: [
    { id: 'alpha', file: 'alpha.md', title: 'Alpha notes tool', tags: ['meetings'], target: 'web-llm',
      body: 'Summarize these.\n<notes>\n{{notes}}\n</notes>\nKeep {{ $json.id }} and \\{{literal}} as text.' },
    { id: 'beta', file: 'beta.md', title: 'Beta code helper', tags: ['code', 'n8n'], target: 'n8n',
      body: 'From {{input_shape}} to {{ desired_output }}. Again {{input_shape}}.' },
    { id: 'gamma', file: 'gamma.md', title: 'Gamma plain', tags: ['python'], target: 'python',
      body: 'No fields here. Mentions alpha once.' },
  ],
};
const PASS = 'fixture-' + randomBytes(6).toString('hex');
const core = loadCore();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------- core logic ----------
console.log('core');
await test('format constants match between app.js and lib.mjs', () => {
  assert.deepEqual({ ...core.FORMAT }, FORMAT);
  assert.equal(FORMAT.iter, 600000);
});
await test('field names: identifiers only, deduped, escapes and n8n expressions ignored', () => {
  assert.deepEqual([...core.fieldNames(FIXTURE.prompts[0].body)], ['notes']);
  assert.deepEqual([...core.fieldNames(FIXTURE.prompts[1].body)], ['input_shape', 'desired_output']);
  assert.deepEqual([...core.fieldNames('{{a-b}} {{_x}} {{9bad}} {{ }}')], ['a-b', '_x']);
});
await test('fill: replaces every occurrence, keeps empty fields visible, resolves escapes', () => {
  const b = FIXTURE.prompts[1].body;
  assert.equal(core.fill(b, { input_shape: 'A', desired_output: 'B' }), 'From A to B. Again A.');
  assert.equal(core.fill(b, { input_shape: 'A' }), 'From A to {{desired_output}}. Again A.');
  assert.equal(core.fill(FIXTURE.prompts[0].body, { notes: 'x $& $1' }), 'Summarize these.\n<notes>\nx $& $1\n</notes>\nKeep {{ $json.id }} and {{literal}} as text.');
});
await test('search: AND terms, title ranks above body, target and tag filters', () => {
  const s = (q, t, tags) => [...core.searchPrompts(FIXTURE.prompts, q, t, tags).map((p) => p.id)];
  assert.deepEqual(s('alpha'), ['alpha', 'gamma']);
  assert.deepEqual(s('ALPHA notes'), ['alpha']);
  assert.deepEqual(s(''), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(s('', 'n8n'), ['beta']);
  assert.deepEqual(s('', '', ['code', 'n8n']), ['beta']);
  assert.deepEqual(s('', '', ['code', 'python']), []);
  assert.deepEqual(s('nothing-matches'), []);
});
await test('front matter: inline list, block list, quotes, CRLF, optional', () => {
  const a = parseFrontmatter('---\r\ntitle: "Hi: there"\r\ntags: [a, \'b\']\r\ntarget: api\r\n---\r\n\r\nBody\r\n');
  assert.deepEqual(a, { meta: { title: 'Hi: there', tags: ['a', 'b'], target: 'api' }, body: 'Body' });
  const b = parseFrontmatter('---\ntitle: T\ntags:\n  - x\n  - y\n---\nB');
  assert.deepEqual(b.meta.tags, ['x', 'y']);
  assert.deepEqual(parseFrontmatter('\n# Just markdown\nText\n'), { meta: {}, body: '# Just markdown\nText' });
  const rule = '---\nA horizontal rule, not front matter\n---\nMore';
  assert.deepEqual(parseFrontmatter(rule), { meta: {}, body: rule });
});

// ---------- crypto ----------
console.log('crypto');
const blob = encrypt(FIXTURE, PASS);
await test('Node encrypt -> WebCrypto decrypt (browser code) round trip', async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(await core.decryptBlob(blob, PASS))), FIXTURE);
});
await test('Node encrypt -> Node decrypt round trip', () => {
  assert.deepEqual(decryptNode(blob, PASS), FIXTURE);
});
await test('blob shape: 16-byte salt, 12-byte IV, tag appended, padded, no plaintext keys', () => {
  assert.equal(Buffer.from(blob.salt, 'base64').length, 16);
  assert.equal(Buffer.from(blob.iv, 'base64').length, 12);
  assert.equal((Buffer.from(blob.ct, 'base64').length - 16) % 1024, 0);
  assert.deepEqual(Object.keys(blob).sort(), ['cipher', 'ct', 'iter', 'iv', 'kdf', 'salt', 'v']);
});
await test('salt and IV are fresh on every build', () => {
  const again = encrypt(FIXTURE, PASS);
  assert.notEqual(again.salt, blob.salt);
  assert.notEqual(again.iv, blob.iv);
});
await test('wrong passphrase and tampered data are rejected', async () => {
  await assert.rejects(core.decryptBlob(blob, PASS + 'x'), /PASSPHRASE/);
  const ct = Buffer.from(blob.ct, 'base64');
  ct[0] ^= 1;
  await assert.rejects(core.decryptBlob({ ...blob, ct: ct.toString('base64') }, PASS), /PASSPHRASE/);
  await assert.rejects(core.decryptBlob({ ...blob, iter: 1000 }, PASS), /FORMAT/);
});
await test('Unicode passphrases match across NFC and NFD input', async () => {
  const nfc = 'café pass phrase';
  const b = encrypt(FIXTURE, nfc);
  assert.equal((await core.decryptBlob(b, nfc.normalize('NFD'))).prompts.length, 3);
});

// ---------- single file ----------
console.log('single file');
const single = buildSingleFile(JSON.stringify(blob));
await test('offline file is self-contained with a hash-based CSP', () => {
  assert.ok(!/<script[^>]*\ssrc=/.test(single), 'external script');
  assert.ok(!/<link[^>]*rel="stylesheet"/.test(single), 'external stylesheet');
  assert.ok(!/https?:\/\//.test(single.replace(/<script>[\s\S]*?<\/script>/, '')), 'absolute URL outside the script');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(single)[1];
  const js = /<script>([\s\S]*?)<\/script>/.exec(single)[1];
  const css = /<style>([\s\S]*?)<\/style>/.exec(single)[1];
  const h = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
  assert.ok(csp.includes(`script-src ${h(js)}`), 'script hash');
  assert.ok(csp.includes(`style-src ${h(css)}`), 'style hash');
  assert.deepEqual(embeddedBlob(single), blob);
});
await test('app.js and style.css make no network references', () => {
  for (const f of ['app.js', 'style.css', 'index.html']) {
    const text = readFileSync(path.join(SHELF, f), 'utf8');
    assert.ok(!/https?:\/\//.test(text), `${f} has an absolute URL`);
    assert.ok(!/@import|url\(/.test(text), `${f} imports a resource`);
  }
});
await test('every element id used by app.js exists in index.html', () => {
  const js = readFileSync(path.join(SHELF, 'app.js'), 'utf8');
  const html = readFileSync(path.join(SHELF, 'index.html'), 'utf8');
  const used = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  const have = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !have.has(id));
  assert.deepEqual(missing, []);
});

// ---------- UI smoke test with a fake DOM ----------
class Node_ {
  constructor(tag, doc) {
    Object.assign(this, { tagName: tag.toUpperCase(), doc, children: [], parentNode: null, _text: '', listeners: {},
      classes: new Set(), dataset: {}, style: {}, attrs: {}, hidden: false, value: '', disabled: false, scrollHeight: 40 });
  }
  get className() { return [...this.classes].join(' '); }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this.classes;
    return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c),
      toggle: (c, f) => { const on = f === undefined ? !s.has(c) : !!f; if (on) s.add(c); else s.delete(c); return on; } };
  }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get lastChild() { return this.children[this.children.length - 1]; }
  appendChild(c) {
    if (c.tagName === '#FRAGMENT') { [...c.children].forEach((k) => this.appendChild(k)); c.children = []; return c; }
    if (c.parentNode) c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  replaceChildren(...nodes) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; nodes.forEach((n) => this.appendChild(n)); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; } }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  dispatch(type, props = {}) {
    const ev = { type, target: this, ctrlKey: false, metaKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
    for (let n = this; n; n = n.parentNode) (n.listeners[type] || []).forEach((f) => f.call(n, ev));
    (this.doc.listeners[type] || []).forEach((f) => f(ev));
    return ev;
  }
  click() { this.dispatch('click'); }
  focus() { this.doc.activeElement = this; }
  select() {}
  setSelectionRange() {}
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (c.tagName === sel.toUpperCase()) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function makePage(html, { protocol = 'https:', fetchBlob = blob, clipboard = 'ok', execOk = true } = {}) {
  const doc = { listeners: {}, activeElement: null, ids: {}, execCalls: 0 };
  doc.body = new Node_('body', doc);
  doc.getElementById = (id) => doc.ids[id] || null;
  doc.createElement = (t) => new Node_(t, doc);
  doc.createTextNode = (t) => { const n = new Node_('#text', doc); n._text = t; return n; };
  doc.createDocumentFragment = () => new Node_('#fragment', doc);
  doc.addEventListener = (t, f) => { (doc.listeners[t] ||= []).push(f); };
  for (const m of html.matchAll(/<(\w+)([^>]*?)\bid="([\w-]+)"([^>]*)>/g)) {
    const node = new Node_(m[1], doc);
    if (/\shidden(\s|>|$)/.test(m[2] + m[4] + '>')) node.hidden = true;
    if (m[3] === 'shelf-data') node._text = /id="shelf-data">([\s\S]*?)<\/script>/.exec(html)[1];
    doc.ids[m[3]] = node;
    doc.body.appendChild(node);
  }
  const page = { doc, clip: null, blobs: [], reloaded: false };
  class Option extends Node_ { constructor(text, value) { super('option', doc); this.textContent = text; this.value = value; } }
  const ctx = {
    document: doc, Option, Blob, TextEncoder, TextDecoder, atob, btoa, crypto: globalThis.crypto, setTimeout, clearTimeout, console,
    isSecureContext: protocol === 'https:' || protocol === 'file:',
    location: { protocol, reload() { page.reloaded = true; } },
    navigator: { clipboard: { writeText: async (t) => { if (clipboard !== 'ok') throw new Error('denied'); page.clip = t; } } },
    URL: { createObjectURL: (b) => { page.blobs.push(b); return 'blob:x'; }, revokeObjectURL() {} },
    fetch: async () => { if (!fetchBlob) throw new TypeError('Failed to fetch'); return { ok: true, json: async () => fetchBlob }; },
  };
  ctx.window = ctx;
  doc.execCommand = (cmd) => { doc.execCalls++; if (execOk) { const ta = doc.body.children.findLast((c) => c.tagName === 'TEXTAREA' && c.classes.has('offscreen')); page.clip = ta ? ta.value : null; } return execOk; };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(SHELF, 'app.js'), 'utf8'), ctx, { filename: 'shelf/app.js' });
  page.$ = (id) => doc.ids[id];
  page.cards = () => doc.ids.list.children;
  page.card = (id) => page.cards().find((c) => c.dataset.id === id);
  page.btn = (card, cls) => card.querySelectorAll('button').find((b) => b.classes.has(cls));
  page.unlock = async (pass) => {
    page.$('pass').value = pass;
    page.$('unlock').click();
    for (let i = 0; i < 200 && (page.$('unlock').disabled); i++) await tick(25);
    await tick(5);
  };
  page.type = (node, value) => { node.value = value; node.dispatch('input'); };
  return page;
}

console.log('ui (fake DOM, real app.js)');
const indexHtml = readFileSync(path.join(SHELF, 'index.html'), 'utf8');
await test('lock screen: empty and wrong passphrase', async () => {
  const p = makePage(indexHtml);
  assert.equal(p.$('app').hidden, true);
  assert.equal(p.doc.activeElement, p.$('pass'));
  assert.equal(p.$('offline').hidden, false);
  await p.unlock('');
  assert.match(p.$('lock-msg').textContent, /Enter the passphrase/);
  await p.unlock('wrong');
  assert.equal(p.$('lock-msg').textContent, 'Wrong passphrase.');
  assert.equal(p.$('pass').disabled, false);
  assert.equal(p.$('app').hidden, true);
});

const page = makePage(indexHtml);
await test('unlock shows the list, focuses search, clears the passphrase', async () => {
  await page.unlock(PASS);
  assert.equal(page.$('lock').hidden, true);
  assert.equal(page.$('app').hidden, false);
  assert.equal(page.$('pass').value, '');
  assert.equal(page.doc.activeElement, page.$('q'));
  assert.equal(page.$('count').textContent, '3 of 3');
  assert.equal(page.$('built').textContent, 'Built 2026-01-02, 3 prompts');
  assert.deepEqual(page.$('target').children.map((o) => o.value), ['web-llm', 'n8n', 'python']);
  assert.deepEqual(page.$('tags').children.map((b) => b.textContent), ['code', 'meetings', 'n8n', 'python']);
});
await test('search filters live; Esc clears; no-match message', () => {
  page.type(page.$('q'), 'beta');
  assert.equal(page.$('count').textContent, '1 of 3');
  assert.ok(page.card('beta').classes.has('open'), 'single result auto-expands');
  page.type(page.$('q'), 'zzz');
  assert.equal(page.$('empty').hidden, false);
  page.$('q').dispatch('keydown', { key: 'Escape' });
  assert.equal(page.$('count').textContent, '3 of 3');
});
await test('Enter in search on a card with fields focuses its first field', () => {
  page.type(page.$('q'), 'beta');
  page.$('q').dispatch('keydown', { key: 'Enter' });
  assert.equal(page.doc.activeElement.dataset.field, 'input_shape');
});
await test('template fields update the preview and the fill count', () => {
  const card = page.card('beta');
  const [a] = card.querySelectorAll('textarea');
  page.type(a, 'ROWS');
  assert.equal(card._parts.preview.textContent, 'From ROWS to {{desired_output}}. Again ROWS.');
  assert.match(card._parts.meta.textContent, /1\/2 filled/);
});
await test('Ctrl+Enter in a field copies the filled text and warns about empty fields', async () => {
  const card = page.card('beta');
  card.querySelectorAll('textarea')[0].dispatch('keydown', { key: 'Enter', ctrlKey: true });
  await tick(5);
  assert.equal(page.clip, 'From ROWS to {{desired_output}}. Again ROWS.');
  assert.match(page.$('status').textContent, /1 empty field: desired_output/);
  assert.equal(page.btn(card, 'copy').textContent, 'Copied');
});
await test('Copy button with all fields filled', async () => {
  const card = page.card('beta');
  page.type(card.querySelectorAll('textarea')[1], 'TOTALS');
  page.btn(card, 'copy').click();
  await tick(5);
  assert.equal(page.clip, 'From ROWS to TOTALS. Again ROWS.');
  assert.equal(page.$('status').textContent, 'Copied "Beta code helper"');
});
await test('Enter on a focused card copies; Enter in search copies a field-less top result', async () => {
  page.$('q').dispatch('keydown', { key: 'Escape' });
  const gamma = page.card('gamma');
  gamma.focus();
  gamma.dispatch('keydown', { key: 'Enter' });
  await tick(5);
  assert.equal(page.clip, 'No fields here. Mentions alpha once.');
  page.clip = null;
  page.type(page.$('q'), 'gamma');
  page.$('q').dispatch('keydown', { key: 'Enter' });
  await tick(5);
  assert.equal(page.clip, 'No fields here. Mentions alpha once.');
});
await test('escaped braces copy as literal text; n8n expressions untouched', async () => {
  page.$('q').dispatch('keydown', { key: 'Escape' });
  const alpha = page.card('alpha');
  alpha.focus();
  alpha.dispatch('keydown', { key: 'Enter' });
  await tick(5);
  assert.equal(page.clip, 'Summarize these.\n<notes>\n{{notes}}\n</notes>\nKeep {{ $json.id }} and {{literal}} as text.');
});
await test('arrow keys move between cards and back to search', () => {
  page.$('q').dispatch('keydown', { key: 'ArrowDown' });
  const first = page.doc.activeElement;
  assert.equal(first, page.cards()[0]);
  first.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(page.doc.activeElement, page.cards()[1]);
  page.cards()[1].dispatch('keydown', { key: 'ArrowUp' });
  page.cards()[0].dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(page.doc.activeElement, page.$('q'));
});
await test('/ focuses search from anywhere outside inputs', () => {
  page.cards()[1].focus();
  const ev = page.cards()[1].dispatch('keydown', { key: '/' });
  assert.equal(page.doc.activeElement, page.$('q'));
  assert.equal(ev.defaultPrevented, true);
});
await test('tag chips and target filter', () => {
  const chip = page.$('tags').children.find((b) => b.textContent === 'python');
  chip.click();
  assert.equal(page.$('count').textContent, '1 of 3');
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  chip.click();
  page.$('target').value = 'n8n';
  page.$('target').dispatch('change');
  assert.deepEqual(page.cards().map((c) => c.dataset.id), ['beta']);
  page.$('target').value = '';
  page.$('target').dispatch('change');
  assert.equal(page.$('count').textContent, '3 of 3');
});
await test('Download .md gives the raw prompt (fields kept, escapes resolved)', async () => {
  page.btn(page.card('alpha'), 'dl').click();
  const b = page.blobs.at(-1);
  assert.equal(await b.text(), 'Summarize these.\n<notes>\n{{notes}}\n</notes>\nKeep {{ $json.id }} and {{literal}} as text.');
  assert.match(page.$('status').textContent, /Downloaded alpha\.md/);
});
await test('Lock reloads the page', () => {
  page.$('lockbtn').click();
  assert.equal(page.reloaded, true);
});
await test('clipboard API refused: falls back to execCommand', async () => {
  const p = makePage(indexHtml, { clipboard: 'denied' });
  await p.unlock(PASS);
  p.btn(p.card('gamma'), 'copy').click();
  await tick(5);
  assert.equal(p.doc.execCalls, 1);
  assert.equal(p.clip, 'No fields here. Mentions alpha once.');
  assert.equal(p.doc.body.children.filter((c) => c.classes.has('offscreen')).length, 0, 'hidden textarea removed');
});
await test('both copy methods refused: manual copy box opens with the text', async () => {
  const p = makePage(indexHtml, { clipboard: 'denied', execOk: false });
  await p.unlock(PASS);
  p.btn(p.card('gamma'), 'copy').click();
  await tick(5);
  assert.equal(p.$('manual').hidden, false);
  assert.equal(p.$('manual-text').value, 'No fields here. Mentions alpha once.');
  p.$('manual-text').dispatch('keydown', { key: 'Escape' });
  assert.equal(p.$('manual').hidden, true);
});
await test('offline file: unlocks from the embedded blob with no network, hides the offline link', async () => {
  const p = makePage(single, { protocol: 'file:', fetchBlob: null });
  assert.equal(p.$('offline').hidden, true);
  await p.unlock(PASS);
  assert.equal(p.$('app').hidden, false);
  assert.equal(p.$('count').textContent, '3 of 3');
});
await test('index.html opened from disk explains to use the offline copy', async () => {
  const p = makePage(indexHtml, { protocol: 'file:', fetchBlob: null });
  await p.unlock(PASS);
  assert.match(p.$('lock-msg').textContent, /offline copy/);
});

// ---------- real content and build output ----------
console.log('real content');
const content = loadContent();
await test('content files parse without errors', () => {
  assert.deepEqual(content.errors, []);
});
for (const p of content.prompts) {
  await test(`${p.file}: fields ${JSON.stringify(core.fieldNames(p.body))}`, () => {
    assert.ok(p.body.length > 0);
  });
}
const dataPath = path.join(SHELF, 'data.enc.json');
if (process.env.SHELF_PASSPHRASE && existsSync(dataPath)) {
  await test('built shelf/data.enc.json decrypts (browser code) and matches content/', async () => {
    const data = await core.decryptBlob(JSON.parse(readFileSync(dataPath, 'utf8')), process.env.SHELF_PASSPHRASE);
    assert.deepEqual(JSON.parse(JSON.stringify(data.prompts)), content.prompts);
    assert.deepEqual(embeddedBlob(readFileSync(path.join(SHELF, 'shelf.html'), 'utf8')), JSON.parse(readFileSync(dataPath, 'utf8')));
  });
} else {
  console.log('  skip  built data check (set SHELF_PASSPHRASE and build first to include it)');
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error(`FAILED: ${failures.join('; ')}`); process.exit(1); }
