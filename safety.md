Your approach is sound: brief the work LLM like a capable contractor you can't talk to. Two caveats:

1. **It only knows what you paste.** The web box can't see your files, so the "person with the knowledge" has no knowledge until you give it some. That also answers your last question: don't ask the LLM to describe the project. Use a script. A script is deterministic, and the LLM would need everything pasted into it anyway. I've written one below.
2. **The loop itself needs the API, not the web box.** DeepSeek in the web box can write the code, but the automated runs have to call an endpoint. If V4 Flash isn't exposed on the platform you have client-credentials access to, the pipeline runs on whatever model that platform serves. The brief keeps the client model-agnostic, so you can swap models later.

On your two problems, I fixed the design in the brief rather than leaving it to the LLM. I've assumed "newer vs older version" means two versions of the same source checklist.

- **Problem 1:** The newer file is primary and gets extracted alone. The older file is then compared against the newer file's draft TSV, and anything missing or conflicting comes out as extra rows flagged `needs_review`. Nothing is merged silently, so you review a short diff instead of a blended hallucination.
- **Problem 2:** Python pairs the files, not the LLM. It groups them by name into a `manifest.tsv` that you can edit. Every call is at most one source plus one compact TSV. Oversized sources get split at section or round boundaries and are never truncated.

For updating prompts, use a single `prompts/rules.md` that is appended to every call. When the output goes wrong in a recurring way, add one numbered rule with a short example. Hashing the prompt then reruns only the affected units.

**Workflow on the work machine:**

```
python snapshot.py <project_root> --data <Unit_folder> --out project_snapshot.md
```

Paste `BRIEF.md`, then `project_snapshot.md`, into DeepSeek. If that's too large for the box, rerun the snapshot with a lower `--py-limit` or without `--data`.Before you paste anything:

- **Run the snapshot first.** Then check `project_snapshot.md` for anything that shouldn't go into the LLM, such as secrets in config files.
- **Correct my guesses before sending.** If I got anything wrong about your setup, like whether "older/newer" means the checklists or the prompts, fix that line in the brief before you paste it.
- **Review section A before the code.** DeepSeek's plan and assumptions list is where wrong guesses show up cheaply.
- **Test on one group first.** Get a single checklist working end to end through `Pass2_builder` before running the whole Unit folder.

Both files are below.

---

# Brief: automate the checklist -> TSV -> Pass2 pipeline

You are a senior Python engineer. A project snapshot (project_snapshot.md) follows this brief.
The author of this brief has NOT seen the code. For facts about what exists (file names, columns,
function signatures, prompt contents), the snapshot wins. For goals and design constraints, this
brief wins. Where they conflict, say so and choose the option that preserves existing behaviour.

You cannot ask me questions before starting. Make reasonable assumptions, state them, and proceed.

## Current process (manual)
1. A Unit folder holds many folders/subfolders of .docx checklists.
2. Existing Python scripts convert .docx -> .md (tables only; extracting body text too may be useful).
   Files for the same checklist are named similarly; some checklists exist in an OLDER and a NEWER
   version. The newer one is supposedly more accurate but less thorough; the older one is more
   thorough but may be outdated.
3. I paste an instruction prompt + a source .md into a web LLM by hand. The prompt defines the
   output: a TSV describing the hierarchy Rounds -> Tasks -> Assets (and related fields).
4. I review/edit the TSV. The TSV is the ONLY file I edit by hand, because LLM output is not reliable.
5. Pass2_builder (existing script) turns the TSV into the final flattened CSV for the system.

## Goal
One command turns the Unit folder into draft TSVs using the LLM API. My only manual jobs:
editing TSVs, and occasionally updating prompts when output is wrong.

## Environment constraints
- Windows 11, locked down: no new software. Use the Python standard library plus only packages the
  snapshot shows are already imported. Use pathlib and UTF-8 everywhere.
- LLM access is an internal HTTP API with OAuth client-credentials (client id + secret -> token).
  I have not given you the endpoints or payload format. Put ALL API details in one module
  (llm_client.py) exposing call_llm(system: str, user: str) -> str, reading endpoints, model name
  and secrets from a config file or environment variables (never hard-coded). Mark every unknown
  with a clear TODO. Do not invent URLs. Use urllib if requests is not already available.
  Keep it model-agnostic; the model may change.
- Context is limited. Assume a configurable max input size (default 24k tokens, estimate as
  chars/4).

## Required design (fixed - do not change these decisions)
1. Manifest, not LLM, for pairing. A deterministic script scans the converted .md files, groups
   versions of the same checklist by normalised name, marks the newest (define the rule from the
   file names/dates you see), and writes manifest.tsv (group_id, unit path, file, role=primary|older,
   include=yes|no). I can edit it. Ambiguous groupings are written with include=no and a note.
2. Prompts live as files in prompts/. Templates use simple {placeholders}. A shared
   prompts/rules.md is appended to every call; it holds short numbered rules I add when output
   goes wrong. Reuse the existing prompt text from the snapshot rather than rewriting it.
3. Extraction per group: the primary (newest) file is extracted ALONE into a draft TSV.
4. Reconcile step: the LLM receives the primary's draft TSV + the older .md and outputs ONLY rows
   that are missing from, or conflict with, the draft - in the same columns plus source=older and
   status=needs_review. These rows are appended to the draft. Never merge silently. Never send
   more than one full source document per call.
5. Oversized sources are split at natural boundaries (sections / rounds / tables), processed per
   chunk, and concatenated. Never truncate silently; log any split.
6. Validation: check every LLM output against what Pass2_builder expects (derive the columns and
   rules from its code; if it can be run as a dry-run validator, do that). On failure, retry once
   with the error message included; if it still fails, save the raw output to failed/ with the error.
7. Caching: skip a group if hash(source files + prompt files + rules.md) is unchanged. Provide --force
   and --only <group_id|unit> flags.
8. Safety of my edits: LLM output goes to drafts/. It never overwrites a TSV in final/ (the folder
   I edit and feed to Pass2_builder). Promoting a draft is an explicit copy command.
9. Every run writes one log line per group: group, status, tokens estimate, retries, output path.
10. Existing scripts: import or call them; do not rewrite working code; do not change
    Pass2_builder's input contract.

## Left to your judgement
File/module names, CLI shape, how to wire the existing converters in, TSV column list (take it
from the existing prompts and Pass2_builder), chunking heuristics, and anything else not fixed above.

## Deliverables, in this order
A. Plan: what exists (from the snapshot), what you will add, a numbered list of assumptions, and a
   short list of things I should verify on my side (for example the API details).
B. Code: one fenced block per file, each headed with its path. Complete files, no "..." elisions.
C. How to run it, step by step, including a first run on a single group.
D. How I should update prompts/rules.md when output is wrong (with one worked example).

If the full answer will not fit, deliver A plus llm_client.py and the manifest script, then stop
and write CONTINUE; I will reply "continue" for the rest.

---

Go simpler. Built-in commands produce a good-enough snapshot without any script. If you'd rather have the script, the recipe below is short enough to retype into DeepSeek.

## Option 1: no script (PowerShell, run from the project root)

Replace `Unit` with your data folder's name.

```
Get-ChildItem -Path . -Recurse -File -Include *.py,*.md,*.txt,*.tsv,*.json | Where-Object FullName -notlike "*\Unit\*" | ForEach-Object { "`n==== $($_.FullName)"; Get-Content $_.FullName -TotalCount 300 } | Out-File snapshot.txt -Encoding utf8
tree Unit /a | Out-File snapshot.txt -Append -Encoding utf8
```

The first line dumps your scripts, prompts and TSVs, capped at 300 lines each. The second appends the folder structure of Unit without listing individual files.

Then append one sample converted markdown by hand, since the LLM needs to see what the input looks like:

```
Get-Content "Unit\<some folder>\<some file>.md" -TotalCount 40 | Out-File snapshot.txt -Append -Encoding utf8
```

If PowerShell is blocked, `cmd` can do a cruder version, but only for scripts sitting in the root folder:

```
tree /a > snapshot.txt
for %f in (*.py prompts\*.md) do @(echo ==== %f & type "%f") >> snapshot.txt
```

## Option 2: recipe for DeepSeek to write the script

```
Write snapshot.py using only the Python standard library (Windows, Python 3.9+).
Args: root folder, --data <data folder>, --out <file>.
Output a markdown file containing:
1. Directory tree of root, excluding the data folder, .git, __pycache__ and venv; max 15 files listed per folder.
2. Every .py file: in full if 150 lines or fewer; otherwise, using ast, only imports, top-level constants, function and class signatures with the first docstring line, and the __main__ block.
3. Every .md/.txt/.tsv/.csv/.json outside the data folder: first 300 lines.
4. Data folder: file counts per extension, directory tree with max 5 files per folder, and the first 40 lines of 2 sample files per text extension.
Read files as utf-8 with errors="replace". Print the output size and estimated tokens (chars/4).
```

Option 1 is enough for this job. Scripts over 300 lines get cut off, but the LLM mostly needs the top of each script (imports, constants, column definitions) plus `Pass2_builder`'s input handling. If `Pass2_builder` is long, paste its input-parsing part manually.