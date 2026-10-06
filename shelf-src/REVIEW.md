# prompt-shelf: overnight review

Built 2026-10-03, unattended. Nothing committed, staged or pushed. The test-passphrase build
output has been deleted, so you need to build once with your real passphrase (steps below).

## What was built

1. `shelf/`: a static page published at `https://weilzx.com/shelf/`. It has a lock screen,
   search, target and tag filters, cards with Copy, template fields with live preview, and
   Download .md. It uses vanilla JS and system fonts, light and dark themes, and makes no
   network calls except loading its own data file.
2. `shelf-src/build.mjs` (Node, zero dependencies): encrypts `shelf-src/content/*.md` into
   `shelf/data.enc.json` plus single-file offline copies. It verifies the result decrypts
   with both Node crypto and the browser's own code, then runs the check.
3. `shelf-src/check.mjs`: fails loudly if content is tracked or not ignored, if prompt text
   appears in any committable file, if an existing site file changed, or if the Jekyll setup
   would publish `shelf-src/`.
4. `shelf-src/selftest.mjs`: 38 tests. They cover crypto compatibility, templates, search, and
   a UI smoke test that runs the real `app.js` against a fake DOM.
5. Five seed prompts in `shelf-src/content/` (gitignored), written for smaller open models.

## What I found about how the site is published

- The repo is `WeilZX/website` (origin `https://github.com/WeilZX/website.git`), branch
  `master`. It is not named `<username>.github.io`. `CNAME` is `weilzx.com`, so the shelf
  will live at **https://weilzx.com/shelf/**. A github.io address would only redirect there.
- There is no `_config.yml`, `.nojekyll`, `docs/` folder or `.github/workflows`. So this is
  classic Pages, deployed from a branch, served from the **repo root, with Jekyll on**
  (the default). I inferred this from the files; I did not look at the GitHub settings.
- Consequences I acted on:
  - The shelf goes in `/shelf/` at the root.
  - Files in `shelf/` have no front matter, so Jekyll copies them byte for byte. It does not
    run Liquid over them, which matters because `{{ }}` appears in the JS and the data.
    The check enforces this.
  - Without help, Jekyll would publish `shelf-src/`, including rendering `README.md` there as
    a page. See decision 1.

## Decisions I made on my own

1. **Added `_config.yml` at the root** (new file; no existing file touched). Its only setting
   is `exclude: [shelf-src]`. It was strictly necessary: Jekyll publishes every folder that
   does not start with `_` or `.`. The folder name `shelf-src/` was fixed by your amendment,
   and `.nojekyll` at the root was forbidden. All other Pages settings stay at their defaults,
   as before. The check fails if this exclude goes missing or a root `.nojekyll` appears.
2. **`.gitignore`: appended 3 lines** (a comment, `shelf-src/content/`, `shelf-src/dist/`).
   The check verifies the committed `.gitignore` is still an unchanged prefix.
3. **The offline copy is also published, as `shelf/shelf.html`**, in addition to
   `shelf-src/dist/shelf.html`. This is a deviation from the spec. A link on the lock screen
   ("offline copy") lets you save it at work with one click. If weilzx.com is blocked but
   github.com is not, you can get it from the repo with "Download raw file". It adds no
   exposure: it is the same ciphertext that is already public in `data.enc.json`.
4. **REVIEW.md is in `shelf-src/`, not the root.** A root `REVIEW.md` would be rendered
   onto the public site.
5. **Node, zero dependencies**, as `.mjs` scripts: `node shelf-src/build.mjs`. There is no
   package.json, because nothing needs installing.
6. **The passphrase is asked twice when typed.** A typo would otherwise lock you out at work.
   `SHELF_PASSPHRASE` also works, but it can end up in shell history, so typing is preferred.
   The build warns (but continues) under 16 characters, because the blob is public and can be
   attacked offline. Your test passphrase triggers this warning.
7. **Crypto extras that keep the required parameters exact.** The passphrase is
   Unicode-normalized (NFC) on both sides, so accented characters match between Mac and
   Windows. The plaintext is padded to 1 KiB multiples so the blob size reveals little.
   The browser refuses a blob whose parameters differ from the expected ones.
8. **Template syntax.**
   - Field names must be identifiers, so n8n expressions like `{{ $json.id }}` are left alone.
   - `\{{name}}` is an escape for literal braces. The meta-prompt needed it to show example
     fields without turning them into input boxes.
   - A repeated name is filled from one box.
   - Empty fields are copied as `{{name}}` and the status line warns, so nothing disappears
     silently.
   - Fields are auto-growing text areas, so whole meeting notes can be pasted into one.
9. **Keyboard additions beyond `/` and Enter.** These remove most mouse use:
   - Enter in search copies the top result, or jumps to its first field if it has fields.
   - Arrow keys move between cards.
   - Space expands a card; `f` jumps to its fields; `d` downloads.
   - Ctrl+Enter copies from inside a field.
   - Esc goes back.
   - A single search result auto-expands.
10. **Copy fallback chain.** First `navigator.clipboard`, then the hidden textarea with
    `execCommand`. If both are refused, a box opens with the text selected and asks you to
    press Ctrl+C. Copy never fails silently.
11. **Download .md** gives the prompt body without front matter, with fields left as
    `{{name}}`. That is the form you want for Notepad++ or an API system prompt.
12. **Hardening.**
    - A Content-Security-Policy meta tag. The offline file gets hash-based CSP for its
      inline code.
    - `noindex` and `no-referrer`.
    - No `<form>`, which makes Edge less likely to offer to save the passphrase.
    - "Lock" reloads the page, which wipes memory.
    - I considered and skipped an idle auto-lock: it adds friction, and reload already
      wipes memory.
13. **The check is broader than the spec.**
    - It scans every committable file for prompt text, not only `shelf/`, because the repo is
      public. It matches lines of 24 or more characters and titles of 12 or more, in raw,
      JSON-escaped and HTML-escaped forms.
    - It also scans the decoded ciphertext.
    - Changed `.DS_Store` files and untracked files outside the shelf are warnings, not
      errors. macOS touches the tracked `.DS_Store` on its own, and failing on that would be
      noise.
14. **Seed prompt choices.**
    - Fixed sections throughout: ROLE, TASK, input in tags, numbered RULES, and an exact
      OUTPUT FORMAT skeleton. The input goes last, with a closing line restating the output
      format, because small models drift after long pastes.
    - Meeting triage: the notes are a field, so you paste them into the shelf and copy once.
    - n8n: the test input comes as an upstream Code node, which is the easiest way to test
      inside n8n.
    - Python: the local wheel install line is
      `py -3.12 -m pip install --user --no-index --find-links <dir> <pkg>`.
    - Meta-prompt: its output starts with the shelf front matter, so the result can go
      straight into `content/`.
15. **Content conventions:** files or folders starting with `_` are skipped (drafts). A
    missing `target` defaults to `general` with a warning. An invalid target fails the build.
16. **Verification without a browser.**
    - No Chromium browser is installed on this Mac. Safari's WebDriver needs
      "Allow remote automation", which I did not turn on (a system setting outside this
      folder).
    - Instead, `selftest.mjs` runs the real `app.js` in Node against a fake DOM. That covered
      unlock, search, filters, fields, copy (including both fallbacks), download, keys and the
      offline file.
    - The 600000-iteration key derivation was cross-checked independently: I derived the key
      with Python `hashlib` and decrypted with WebCrypto.
    - The negative tests all failed as they should: a tracked content file, a changed CNAME,
      a missing `_config.yml`, a stale offline copy, front matter in `shelf/`, plaintext as
      ciphertext, and leaked lines in JS, JSON and HTML.
    - I used a throwaway git index file in `dist/` for the git cases, so your real index was
      never touched.
17. **Things I did outside the folder, all read-only or temporary.** I listed `/Applications`
    and checked for `safaridriver` to see which browsers exist. I started `safaridriver`
    briefly on port 4999 (stopped again). That probe wrote one log line to Claude's session
    temp directory. Nothing else outside the repo was read or changed.

## Unfinished or uncertain, most important first

1. **Not tested in a real browser, and specifically not in Edge.** The fake DOM catches logic
   and wiring errors. It cannot catch layout problems, Edge clipboard permissions on
   `file://`, or CSP quirks. Run the 3-minute local test below before pushing. If something
   misbehaves only in Edge, the first suspect is the CSP line in `shelf/index.html`. Deleting
   that line turns CSP off for both the site and the offline copy (rebuild afterwards).
2. **The meeting-triage prompt treats the name "Weil" as you.** I took the name from your git
   author name, so the "me / other" split can work. Edit the line starting with "WHO IS" in
   `shelf-src/content/meeting-note-triage.md` if that is wrong, or add initials.
3. **weilzx.com may be blocked or "uncategorized" at work.** Corporate proxies often block new
   personal domains even when github.io is allowed. With a custom domain, github.io only
   redirects to weilzx.com, so it does not help. Use the offline file in that case (see
   below).
4. **HTTPS must be enforced for the custom domain.** WebCrypto does not exist on plain http, so
   unlock would fail with a message saying so. Check Settings > Pages > "Enforce HTTPS".
5. **Jekyll behavior is inferred, not run.** Jekyll is not installed here. The rules relied on
   are standard: front-matter-less files are copied verbatim, and `exclude` drops a folder.
   Confirm after pushing with the URL checks in step 9.
6. **Edge may show a download prompt or warning** for the `.html` offline copy, depending on
   policy. If it is blocked, use USB or email from `shelf-src/dist/shelf.html`.
7. **Git history keeps every blob forever.** If the passphrase ever leaks, changing it
   protects only future builds. Choose a long one now.
8. **FYI, not touched:** `safety.md` and `safety2.md` at the root are public in the repo, and
   Jekyll renders root `.md` files, so they are likely live at `weilzx.com/safety` and
   `weilzx.com/safety2`. They look like work notes. That may be intended; flagging only.

## Commands for tomorrow, in order

```sh
cd ~/Documents/GitHub/website

# 1. Optional sanity test (no passphrase needed, about 5 s)
node shelf-src/selftest.mjs

# 2. Build with your real passphrase (typed twice, never shown or stored).
#    Must end with "check passed".
node shelf-src/build.mjs

# 3. Check again on its own (exit code 0 = safe)
node shelf-src/check.mjs

# 4. Optional local test before publishing (Safari; localhost counts as https for WebCrypto)
python3 -m http.server 8000
#    open http://localhost:8000/shelf/ : unlock, press /, type, Enter, paste somewhere
#    then Ctrl+C the server, and double-click shelf-src/dist/shelf.html to test the offline file

# 5. Stage. Expect: .gitignore, _config.yml, shelf/*, shelf-src/* (never content/ or dist/)
git add .gitignore _config.yml shelf shelf-src
git status --short
node shelf-src/check.mjs

# 6. Commit
git commit -m "Add prompt shelf"

# 7. GitHub repo: nothing to create. WeilZX/website already exists and is the origin.
# 8. Pages: already enabled. In github.com/WeilZX/website/settings/pages, confirm:
#    Source "Deploy from a branch", branch master, folder / (root), custom domain
#    weilzx.com, "Enforce HTTPS" ticked. Do NOT switch to /docs: the site lives at the root.

# 9. Push, then wait 1-2 minutes for the "pages build and deployment" run
git push origin master
#    Verify:
#    https://weilzx.com/                   still looks exactly as before
#    https://weilzx.com/shelf/             lock screen; unlock works
#    https://weilzx.com/shelf/data.enc.json   only base64, no readable text
#    https://weilzx.com/shelf-src/README.md   must be 404 (Jekyll exclude works)
```

### Testing from the work machine (Edge)

1. Open `https://weilzx.com/shelf/` and unlock. Expect a short pause while the key is
   derived.
2. Press `/`, type `meeting`, and press Enter. The notes field gets focus.
3. Paste some notes, press Ctrl+Enter, and paste into DeepSeek or Qwen. Check that the notes
   landed inside the tags.
4. Press Esc, then `/`, type `n8n`, and fill both fields. Press Copy and paste it into the
   web LLM.
5. Press Download .md on any card and open the file in Notepad++.
6. Fallback test: lock the page, click "offline copy", and save `prompt-shelf.html` to
   Documents. Double-click it to open in Edge as `file://`, unlock, and press Copy. This
   exercises the `file://` clipboard path.
7. If weilzx.com is blocked, try these in order:
   - Open `https://github.com/WeilZX/website/blob/master/shelf/shelf.html` and use
     "Download raw file".
   - Otherwise, bring `shelf-src/dist/shelf.html` on USB or by email.
   - Each copy is a snapshot. The build date is shown at the bottom after unlocking.

### Routine after that

Edit or add files in `shelf-src/content/`. Then run `node shelf-src/build.mjs`, then
`git add shelf && git commit -m "Update shelf" && git push`.
