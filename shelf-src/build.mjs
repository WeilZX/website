// Builds the encrypted shelf. Run from anywhere: node shelf-src/build.mjs
// Passphrase: asked twice interactively, or read from SHELF_PASSPHRASE. Never written or logged.
// Writes: shelf/data.enc.json, shelf/shelf.html (published offline copy),
//         shelf-src/dist/shelf.html (local copy for USB or email). Then runs the check.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SHELF, DIST, loadContent, encrypt, decryptNode, loadCore, buildSingleFile } from './lib.mjs';
import { runCheck, printCheck } from './check.mjs';

function fail(msg) {
  console.error(`\nBUILD FAILED: ${msg}\n`);
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let buf = '';
    const onData = (chunk) => {
      if (chunk.startsWith('\u001b')) return; // arrow keys and other escape sequences
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') buf = [...buf].slice(0, -1).join('');
        else if (c >= ' ') buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function getPassphrase() {
  const fromEnv = process.env.SHELF_PASSPHRASE;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) fail('no terminal to ask for the passphrase; set SHELF_PASSPHRASE instead');
  const a = await askHidden('Passphrase: ');
  const b = await askHidden('Repeat passphrase: ');
  if (a !== b) fail('the two passphrases differ; nothing was written');
  return a;
}

async function main() {
  const { prompts, errors, warnings } = loadContent();
  for (const w of warnings) console.log(`  warning: ${w}`);
  if (errors.length) fail(`fix these content files first:\n  - ${errors.join('\n  - ')}`);
  if (!prompts.length) fail('no prompts found in shelf-src/content/');

  const passphrase = await getPassphrase();
  if (!passphrase) fail('empty passphrase');
  if (passphrase.length < 16) console.log('  warning: passphrase is shorter than 16 characters. The blob is public and can be attacked offline; 4 or more random words is safer.');

  const payload = { v: 1, built: new Date().toISOString(), prompts };
  console.log(`Encrypting ${prompts.length} prompts (PBKDF2 600000 iterations, takes a moment)...`);
  const blob = encrypt(payload, passphrase);

  // Round trip through Node crypto and through the browser's own decrypt code (WebCrypto).
  const expected = JSON.stringify(payload);
  if (JSON.stringify(decryptNode(blob, passphrase)) !== expected) fail('Node round trip did not match');
  const viaBrowserCode = await loadCore().decryptBlob(blob, passphrase);
  if (JSON.stringify(viaBrowserCode) !== expected) fail('WebCrypto round trip (shelf/app.js) did not match');

  const blobJson = JSON.stringify(blob);
  const single = buildSingleFile(blobJson);
  mkdirSync(DIST, { recursive: true });
  writeFileSync(path.join(SHELF, 'data.enc.json'), blobJson + '\n');
  writeFileSync(path.join(SHELF, 'shelf.html'), single);
  writeFileSync(path.join(DIST, 'shelf.html'), single);
  console.log('Wrote shelf/data.enc.json, shelf/shelf.html, shelf-src/dist/shelf.html (round trip verified).');

  if (!printCheck(runCheck())) process.exit(1);
}

main().catch((e) => fail(e.message));
