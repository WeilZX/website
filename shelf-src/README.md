# prompt-shelf

A passphrase-locked prompt library published at `/shelf/` on this site. Authored on the Mac,
read-only at work: open, search, fill, copy.

- `shelf-src/content/`: plaintext prompts. **Gitignored. Never commit.**
- `shelf-src/build.mjs`: encrypts content into `shelf/data.enc.json` and the offline copies.
- `shelf-src/check.mjs`: safety check, run automatically at the end of every build.
- `shelf-src/selftest.mjs`: crypto, template and UI tests (synthetic data only).
- `shelf/`: the published page (`index.html`, `app.js`, `style.css`) plus build output.
- `shelf-src/dist/shelf.html`: single-file copy for USB or email. Gitignored.

Requirements: Node 20 or newer. No npm packages, no network.

## Everyday use (Mac)

```sh
# 1. add or edit a file in shelf-src/content/
# 2. build: asks for the passphrase twice, encrypts, verifies, runs the check
node shelf-src/build.mjs
# 3. publish
git add shelf && git commit -m "Update shelf" && git push
```

Pages updates in a minute or two. Pages caches files for up to 10 minutes, so a hard
refresh (Ctrl+F5) may be needed at work.

If the check fails, it prints `CHECK FAILED` and exits with code 1. Do not commit until it passes.

## Prompt file format

Any `.md` file works as is: paste markdown, save, build. The file name becomes the title
(`Roaming Strings.md` shows as "Roaming Strings"), with no tags and target `general`.

Optionally, start the file with a header to set a title, tags (filter chips) and a target:

```markdown
---
title: Example title
tags: [tag-one, tag-two]
target: web-llm
---
The prompt text. Anything in double braces such as {{topic}} becomes an input box.
```

- `target`: one of `web-llm`, `api`, `n8n`, `python`, `general`. Missing means `general`.
- `tags`: `[a, b]` or a `- item` list. Lowercased.
- Fields: `{{name}}` with a letter or underscore first, then letters, digits, `_` or `-`.
  Repeating a name fills every occurrence from one box. Empty fields are copied as
  `{{name}}`, and the status line warns about them.
- n8n expressions like `{{ $json.id }}` are not fields and are copied unchanged.
- To show literal braces around a name, write `\{{name}}`. It copies as `{{name}}`.
- Files or folders starting with `_` or `.` are skipped, which is useful for drafts.
- Subfolders are fine; the file path becomes the download name.

## At work

Open `https://weilzx.com/shelf/`, enter the passphrase, and type to search.

| Key | Action |
|-----|--------|
| `/` | focus search |
| Enter in search | copy the top result, or open its fields if it has any |
| Arrow up and down | move between cards and back to search |
| Enter on a card | copy |
| Space on a card | expand or collapse |
| `f` / `d` on a card | jump to fields / download .md |
| Ctrl+Enter in a field | copy |
| Esc | leave the field, or clear search |

Decrypted prompts live in memory only. Nothing is stored, sent or saved by the page. Reloading
or pressing Lock means unlocking again.

Fallback when the site is blocked: open `shelf.html` from disk in Edge. Get it from the
"offline copy" link on the lock screen, from `shelf-src/dist/shelf.html`, or from the GitHub
repo (`shelf/shelf.html`, "Download raw file"). It needs the same passphrase and no network.
Each copy is a snapshot from its build date, which is shown at the bottom of the page.

## Changing the passphrase

Rebuild with the new one and push. Old copies of `shelf.html` keep working with the old
passphrase, and git history keeps the old blobs, so a passphrase you have published stays
attackable offline forever. Pick a long one (4 or more random words).

## Crypto

PBKDF2-SHA256 with 600000 iterations and a random 16-byte salt derives an AES-256-GCM key.
A random 12-byte IV is used, and everything is base64. The salt and IV are new on every build.
The browser uses WebCrypto (`shelf/app.js`) and the build uses Node `crypto` (`lib.mjs`).
The build decrypts its own output with both before writing, and the check confirms the two
files declare the same parameters. The plaintext is padded to a multiple of 1 KiB so the
blob size reveals little.

`shelf-src/` is excluded from the published site by the root `_config.yml`.
