// Safety check for prompt-shelf. Fails loudly (exit 1) if plaintext could be published
// or if anything outside the shelf was changed. Run: node shelf-src/check.mjs
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, SHELF, DIST, FORMAT, loadContent, loadCore, blobProblems, embeddedBlob } from './lib.mjs';

// Paths the shelf may touch. Everything else in the repo belongs to the existing site.
const OWN_PREFIXES = ['shelf/', 'shelf-src/'];
const OWN_FILES = ['.gitignore', '_config.yml'];
const MIN_LINE = 24; // shorter prompt lines are too generic to match reliably
const MIN_TITLE = 12;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitOk(args) {
  try { execFileSync('git', args, { cwd: ROOT, stdio: 'ignore' }); return true; } catch { return false; }
}

const isOwn = (p) => OWN_FILES.includes(p) || OWN_PREFIXES.some((x) => p.startsWith(x));
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const htmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function readText(file) {
  const st = statSync(file);
  if (!st.isFile() || st.size > 5 * 1024 * 1024) return null;
  const buf = readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return null; // binary
  return buf.toString('utf8');
}

function needlesFrom(prompts) {
  const needles = new Map(); // variant -> label
  const add = (text, label) => {
    const n = norm(text);
    for (const v of new Set([n, norm(JSON.stringify(text).slice(1, -1)), norm(htmlEscape(text))])) needles.set(v, label);
  };
  for (const p of prompts) {
    if (p.title.length >= MIN_TITLE) add(p.title, `${p.file} (title)`);
    p.body.split('\n').forEach((line, i) => { if (norm(line).length >= MIN_LINE) add(line.trim(), `${p.file} line ${i + 1}`); });
  }
  return needles;
}

export function runCheck() {
  const errors = [];
  const warnings = [];
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

  // 1. Git basics
  let top = '';
  try { top = git(['rev-parse', '--show-toplevel']).trim(); } catch { errors.push('not inside a git repository'); return { errors, warnings }; }
  if (path.resolve(top) !== path.resolve(ROOT)) errors.push(`repo root is ${top}, expected ${ROOT}`);

  // 2. Plaintext content and local build output must be ignored and never tracked
  for (const dir of ['shelf-src/content', 'shelf-src/dist']) {
    const tracked = git(['ls-files', '--', dir]).trim();
    if (tracked) errors.push(`files under ${dir}/ are tracked by git (run: git rm -r --cached ${dir}):\n    ${tracked.split('\n').join('\n    ')}`);
    if (!gitOk(['check-ignore', '-q', '--no-index', `${dir}/probe.md`])) errors.push(`${dir}/ is not ignored by .gitignore`);
  }

  // 3. Nothing outside the shelf may be modified; .gitignore may only be appended to
  const entries = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2);
    const file = entries[i].slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // next entry is the original path
    if (isOwn(file)) continue;
    if (code === '??') warnings.push(`untracked file outside the shelf (would be published if committed): ${file}`);
    else if (path.basename(file) === '.DS_Store') warnings.push(`macOS changed ${file}; it is unrelated to the shelf (git checkout -- "${file}" to undo)`);
    else errors.push(`existing site file changed (${code.trim()}): ${file}`);
  }
  if (gitOk(['cat-file', '-e', 'HEAD:.gitignore'])) {
    const before = git(['show', 'HEAD:.gitignore']);
    const now = existsSync(path.join(ROOT, '.gitignore')) ? readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
    if (!now.startsWith(before)) errors.push('.gitignore was edited, not only appended to');
  }

  // 4. Jekyll must publish shelf/ verbatim and never publish shelf-src/
  if (existsSync(path.join(ROOT, '.nojekyll'))) errors.push('.nojekyll exists at the root: Jekyll is off, so _config.yml exclude no longer hides shelf-src/');
  const configPath = path.join(ROOT, '_config.yml');
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const excluded = /^exclude:\s*\[[^\]]*\bshelf-src\b/m.test(config) || (/^exclude:\s*$/m.test(config) && /^\s+-\s*["']?\/?shelf-src\/?["']?\s*$/m.test(config));
  if (!excluded) errors.push('_config.yml does not exclude shelf-src, so Jekyll would publish it');
  for (const f of walkFiles(SHELF)) {
    const name = path.basename(f);
    if (name.startsWith('_') || name.startsWith('.')) errors.push(`${rel(f)}: Jekyll drops files starting with _ or .`);
    if (!/\.(html|js|css|json)$/.test(name)) warnings.push(`${rel(f)}: unexpected file type in shelf/`);
    const text = readText(f);
    if (text && text.startsWith('---')) errors.push(`${rel(f)}: starts with ---, so Jekyll would treat it as a template and rewrite {{ }}`);
  }

  // 5. Browser and build agree on the crypto format
  try {
    const core = loadCore();
    if (JSON.stringify(core.FORMAT) !== JSON.stringify(FORMAT)) errors.push(`crypto format differs: app.js ${JSON.stringify(core.FORMAT)} vs lib.mjs ${JSON.stringify(FORMAT)}`);
  } catch (e) {
    errors.push(`shelf/app.js does not load: ${e.message}`);
  }

  // 6. Published blob is well formed, and the offline copies hold the same blob
  const dataPath = path.join(SHELF, 'data.enc.json');
  let blob = null;
  if (existsSync(dataPath)) {
    try { blob = JSON.parse(readFileSync(dataPath, 'utf8')); } catch { errors.push('shelf/data.enc.json is not valid JSON'); }
    if (blob) for (const p of blobProblems(blob)) errors.push(`shelf/data.enc.json: ${p}`);
    for (const copy of [path.join(SHELF, 'shelf.html'), path.join(DIST, 'shelf.html')]) {
      if (!existsSync(copy)) { warnings.push(`${rel(copy)} is missing; run the build`); continue; }
      const inner = embeddedBlob(readFileSync(copy, 'utf8'));
      if (!blob || !inner || inner.ct !== blob.ct) errors.push(`${rel(copy)} does not hold the same data as shelf/data.enc.json; rerun the build`);
    }
  } else {
    warnings.push('shelf/data.enc.json does not exist yet; run the build');
  }

  // 7. No plaintext prompt text in anything that could be committed or published
  const { prompts } = loadContent();
  if (!prompts.length) {
    warnings.push('no prompts in shelf-src/content/, so the plaintext scan had nothing to look for');
  } else {
    const needles = needlesFrom(prompts);
    const candidates = new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean));
    for (const f of walkFiles(SHELF)) candidates.add(rel(f));
    for (const file of candidates) {
      if (file.startsWith('shelf-src/content/')) continue; // reported in step 2
      const full = path.join(ROOT, file);
      if (!existsSync(full)) continue;
      const text = readText(full);
      if (!text) continue;
      const hay = norm(text);
      const hits = [...needles].filter(([n]) => hay.includes(n)).map(([, label]) => label);
      if (hits.length) errors.push(`PLAINTEXT in ${file}: matches ${[...new Set(hits)].slice(0, 5).join('; ')}${hits.length > 5 ? ' ...' : ''}`);
    }
    if (blob && !blobProblems(blob).length) {
      const raw = norm(Buffer.from(blob.ct, 'base64').toString('latin1'));
      if ([...needles.keys()].some((n) => raw.includes(n))) errors.push('PLAINTEXT inside the ciphertext of shelf/data.enc.json: the blob is not encrypted');
    }
  }

  return { errors, warnings };
}

export function printCheck({ errors, warnings }) {
  for (const w of warnings) console.log(`  warning: ${w}`);
  if (errors.length) {
    console.error('\n================ CHECK FAILED ================');
    for (const e of errors) console.error(`  - ${e}`);
    console.error('==============================================\nDo not commit or push until this is fixed.\n');
    return false;
  }
  console.log('check passed: content/ is ignored, no plaintext in publishable files, site files untouched.');
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(printCheck(runCheck()) ? 0 : 1);
}
