// Shared helpers for build, check and selftest. Node built-ins only.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import vm from 'node:vm';

export const SRC = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SRC, '..');
export const CONTENT = path.join(SRC, 'content');
export const DIST = path.join(SRC, 'dist');
export const SHELF = path.join(ROOT, 'shelf');

// Must equal FORMAT in shelf/app.js; check.mjs and selftest.mjs compare the two.
export const FORMAT = { v: 1, kdf: 'PBKDF2-SHA256', iter: 600000, cipher: 'AES-256-GCM', saltBytes: 16, ivBytes: 12 };
export const TARGETS = ['web-llm', 'api', 'n8n', 'python', 'general'];
const KNOWN_KEYS = ['title', 'tags', 'target'];

// ---------- content ----------

function unquote(s) {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

// Minimal YAML front matter: `key: value`, `key: [a, b]`, and `key:` followed by `- item` lines.
export function parseFrontmatter(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { error: 'missing front matter (the file must start with a --- line)' };
  const meta = {};
  let listKey = null;
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) { meta[listKey].push(unquote(item[1])); continue; }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) return { error: `cannot read front matter line: ${line.trim()}` };
    const [, key, raw] = kv;
    listKey = null;
    if (raw.trim() === '') { meta[key] = []; listKey = key; }
    else if (/^\[.*\]$/.test(raw.trim())) meta[key] = raw.trim().slice(1, -1).split(',').map(unquote).filter(Boolean);
    else meta[key] = unquote(raw);
  }
  const body = text.slice(m[0].length).replace(/^\s*\n/, '').replace(/\s+$/, '');
  return { meta, body };
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out.sort();
}

// Reads shelf-src/content/**/*.md. Files or folders starting with _ or . are skipped (drafts).
export function loadContent() {
  const prompts = [];
  const errors = [];
  const warnings = [];
  const ids = new Map();
  for (const file of walk(CONTENT)) {
    const rel = path.relative(CONTENT, file).split(path.sep).join('/');
    const parsed = parseFrontmatter(readFileSync(file, 'utf8'));
    if (parsed.error) { errors.push(`${rel}: ${parsed.error}`); continue; }
    const { meta, body } = parsed;
    for (const k of Object.keys(meta)) if (!KNOWN_KEYS.includes(k)) warnings.push(`${rel}: unknown front matter key "${k}" ignored`);

    let title = typeof meta.title === 'string' ? meta.title.trim() : '';
    if (!title) { title = path.basename(file, '.md'); warnings.push(`${rel}: no title, using the file name`); }
    let target = typeof meta.target === 'string' ? meta.target.trim().toLowerCase() : '';
    if (!target) { target = 'general'; warnings.push(`${rel}: no target, using "general"`); }
    else if (!TARGETS.includes(target)) { errors.push(`${rel}: target "${target}" is not one of ${TARGETS.join(', ')}`); continue; }
    const rawTags = Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === 'string' ? [meta.tags] : [];
    const tags = [...new Set(rawTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
    if (!body) { errors.push(`${rel}: the prompt body is empty`); continue; }

    const id = rel.replace(/\.md$/i, '').toLowerCase().replace(/\//g, '--').replace(/[^a-z0-9_-]+/g, '-');
    if (ids.has(id)) { errors.push(`${rel}: same id "${id}" as ${ids.get(id)}; rename one file`); continue; }
    ids.set(id, rel);
    prompts.push({ id, file: rel, title, tags, target, body });
  }
  const titles = new Map();
  for (const p of prompts) {
    const k = p.title.toLowerCase();
    if (titles.has(k)) warnings.push(`${p.file}: same title as ${titles.get(k)}`);
    titles.set(k, p.file);
  }
  prompts.sort((a, b) => a.title.localeCompare(b.title));
  return { prompts, errors, warnings };
}

// ---------- crypto ----------

function deriveKey(passphrase, salt) {
  return pbkdf2Sync(Buffer.from(passphrase.normalize('NFC'), 'utf8'), salt, FORMAT.iter, 32, 'sha256');
}

// Output matches WebCrypto AES-GCM: ciphertext with the 16-byte tag appended.
export function encrypt(payload, passphrase) {
  let json = JSON.stringify(payload);
  json += ' '.repeat((1024 - (Buffer.byteLength(json) % 1024)) % 1024); // hide exact size
  const salt = randomBytes(FORMAT.saltBytes);
  const iv = randomBytes(FORMAT.ivBytes);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    v: FORMAT.v, kdf: FORMAT.kdf, iter: FORMAT.iter, cipher: FORMAT.cipher,
    salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'),
  };
}

export function decryptNode(blob, passphrase) {
  const ct = Buffer.from(blob.ct, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(blob.salt, 'base64')), Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// Validates the public blob shape without decrypting. Returns a list of problems.
export function blobProblems(blob) {
  const problems = [];
  const keys = ['v', 'kdf', 'iter', 'cipher', 'salt', 'iv', 'ct'];
  if (!blob || typeof blob !== 'object') return ['not a JSON object'];
  const extra = Object.keys(blob).filter((k) => !keys.includes(k));
  if (extra.length) problems.push(`unexpected keys: ${extra.join(', ')}`);
  for (const k of ['v', 'kdf', 'iter', 'cipher']) if (blob[k] !== FORMAT[k]) problems.push(`${k} is ${JSON.stringify(blob[k])}, expected ${JSON.stringify(FORMAT[k])}`);
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  for (const k of ['salt', 'iv', 'ct']) if (typeof blob[k] !== 'string' || !b64.test(blob[k])) problems.push(`${k} is not base64`);
  if (!problems.length) {
    if (Buffer.from(blob.salt, 'base64').length !== FORMAT.saltBytes) problems.push('salt is not 16 bytes');
    if (Buffer.from(blob.iv, 'base64').length !== FORMAT.ivBytes) problems.push('iv is not 12 bytes');
    if (Buffer.from(blob.ct, 'base64').length < 17) problems.push('ct is too short');
  }
  return problems;
}

// ---------- browser code ----------

// Runs shelf/app.js without a DOM and returns its core: the exact decrypt and template
// code the browser uses, backed by Node's WebCrypto.
export function loadCore() {
  const code = readFileSync(path.join(SHELF, 'app.js'), 'utf8');
  const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, atob, btoa });
  vm.runInContext(code, ctx, { filename: 'shelf/app.js' });
  return ctx.ShelfCore;
}

const sha256 = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

function replaceOnce(html, find, replacement) {
  const at = html.indexOf(find);
  if (at === -1 || html.indexOf(find, at + 1) !== -1) throw new Error(`shelf/index.html must contain exactly one: ${find}`);
  return html.slice(0, at) + replacement + html.slice(at + find.length);
}

// Inlines style.css, app.js and the blob into one file that works from file://.
export function buildSingleFile(blobJson) {
  const read = (f) => readFileSync(path.join(SHELF, f), 'utf8');
  const css = read('style.css');
  const js = read('app.js');
  if (/<\/style/i.test(css) || /<\/script/i.test(js) || /<\/script/i.test(blobJson)) throw new Error('cannot inline: closing tag inside source');
  const csp = `default-src 'none'; script-src ${sha256(js)}; style-src ${sha256(css)}; img-src data:; base-uri 'none'; form-action 'none'`;
  // If index.html has a CSP meta tag, the offline copy gets the same policy with hashes for its
  // inline code. Deleting the tag from index.html turns CSP off in both.
  let html = read('index.html');
  html = html.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)/, (m, a, b) => a + csp + b);
  html = replaceOnce(html, '<link rel="stylesheet" href="style.css">', `<style>${css}</style>`);
  html = replaceOnce(html, '<script src="app.js"></script>', `<script>${js}</script>`);
  html = replaceOnce(html, '<script type="application/json" id="shelf-data"></script>', `<script type="application/json" id="shelf-data">${blobJson}</script>`);
  return html;
}

export function embeddedBlob(html) {
  const m = /<script type="application\/json" id="shelf-data">([\s\S]*?)<\/script>/.exec(html);
  return m && m[1].trim() ? JSON.parse(m[1]) : null;
}
