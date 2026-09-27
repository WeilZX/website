The approach: one kickoff prompt tells the work LLM what the system is, what we've already decided, and that it leads. It asks you for files and gives you commands to run, so you never have to explain the system yourself. Short phase prompts then move it through the work. At the end of each phase it writes a `PROJECT.md`, which becomes the shared memory between chats. That also settles your earlier question: the LLM writes the project description after it has seen your files.

**How to use it:** start each phase in a fresh chat to save context. Paste the kickoff prompt, then the latest `PROJECT.md` if you have one, then the phase prompt.

**Kickoff (paste at the start of every chat)**
```
You are my lead engineer for automating a document-processing pipeline. You cannot see my machine; I run whatever you ask and paste back results. You lead: tell me exactly what to run or paste, one step at a time, and keep requests small because context is limited.

SYSTEM (my summary)
- A Unit folder with nested subfolders of .docx checklists.
- Python scripts convert .docx -> .md (tables only for now; body text may be worth adding).
- Similar file names = versions of the same checklist. Newer version: more accurate, less thorough. Older: more thorough, may be outdated.
- Instruction prompts + one source .md go into an LLM (currently by hand in a web UI). The prompt defines the output: a TSV encoding the hierarchy Rounds -> Tasks -> Assets (and related fields).
- I review and edit the TSV. It is the only file I edit by hand.
- Pass2_builder.py turns the TSV into the final flattened CSV.

GOAL
One command: Unit folder -> draft TSVs via the internal LLM API. My manual work: editing TSVs, and adding rules to prompts when output is wrong. The code must be clean enough that I understand every file.

CONSTRAINTS
- Windows 11, locked down: Python standard library plus already-installed packages only. Ask me to check before relying on any package.
- The LLM API uses OAuth client credentials. Never ask for the secret value; read it from environment variables.
- Limited context on every LLM call, including this chat.

FIXED DESIGN DECISIONS
1. Pairing file versions is deterministic (Python, name normalisation), written to an editable manifest.tsv. Not done by the LLM.
2. The newest version is extracted alone. The older version is then compared against that draft TSV; only missing or conflicting rows are added, marked source=older, status=needs_review. Never merge silently; never send two full sources in one call.
3. Oversized sources are split at natural boundaries (section, round, table); never truncated silently.
4. Every LLM output is validated against what Pass2_builder expects; one retry with the error message; then saved to failed/.
5. Prompts are files in prompts/; a shared prompts/rules.md is appended to every call.
6. LLM output goes to drafts/ and never overwrites my edited TSVs in final/.
7. Caching by hash of sources + prompts; flags --force and --only.
8. Reuse working code; do not change Pass2_builder's input format without asking me.

WORKING RULES
- Phases: 1 Discovery, 2 Cleanup, 3 API client, 4 Pipeline, 5 Prompt refinement. Do not start a phase until I say so.
- Before writing code, state what you know, what you assume, and what you need from me.
- Code: complete files only, one block per file with its path. No "..." placeholders.
- Give me Windows commands (PowerShell or cmd) to run and tell me what output to paste back.
- End every phase by giving me the full updated PROJECT.md.

PROJECT.md is our shared memory across chats: folder layout, what each script does with its inputs and outputs, TSV columns and rules, decisions made, open issues, current phase. Keep it under 150 lines.

If I paste a PROJECT.md below, continue from its current phase. Otherwise wait for my phase instruction.
```

**Phase 1: Discovery**
```
Start Phase 1: Discovery. Do not propose changes yet.
1. Give me one PowerShell command that lists the project folder with file sizes (excluding the contents of the Unit folder), plus a directory-only tree of the Unit folder.
2. From that listing, ask for files in priority order, a few at a time: Pass2_builder first, then my prompts, then the conversion scripts, then one sample .md and one sample TSV. For long files, ask only for the parts you need.
3. When you have enough, write PROJECT.md. Include the exact TSV columns and rules Pass2_builder enforces, and a list of problems you noticed (duplication, hard-coded paths, fragile parsing, unclear names).
```

**Phase 2: Cleanup**
```
Start Phase 2: Cleanup.
Using PROJECT.md, propose a target folder layout and the minimal changes that make the existing code clean and understandable: one config file for paths and settings, no hard-coded paths, clear names, shared helpers in one module, a short docstring at the top of every script.
Show the plan first as a table: current -> proposed -> reason. Wait for my approval, then deliver files one at a time. After each file, give me a command to confirm it still produces the same output as before.
```

**Phase 3: API client**
```
Start Phase 3: API client.
I have a client id and secret. Tell me exactly what else you need (token URL, API URL, model name, request and response format, proxy or certificate requirements) and where I would typically find each one. Then write llm_client.py:
- call_llm(system, user) -> str, standard library only (urllib)
- endpoints and secrets from environment variables or config, never in code
- token caching until expiry, timeouts, retry with backoff on network and 5xx errors, clear error messages
- test mode: python llm_client.py --test sends a one-line prompt and prints the reply and token usage if returned
Give me the PowerShell commands to set the environment variables for my user account only.
```

**Phase 4: Pipeline**
```
Start Phase 4: Pipeline.
Build the pipeline per the fixed design decisions, reusing the Phase 2 code and the Phase 3 client. Deliver in this order, stopping after each step so I can test:
1. manifest step (writes manifest.tsv; ambiguous groups get include=no and a note)
2. extraction for one group (primary only) + validation
3. reconcile step (older version vs draft)
4. batch runner with caching, --force, --only, splitting, and one log line per group
5. promote command (drafts/ -> final/) and the Pass2_builder call
For each step, give me the command to test it on a single group first.
```

**Phase 5: Prompt refinement**
```
Start Phase 5: Prompt refinement.
I will paste my existing prompts. Convert them into:
- prompts/extract.md and prompts/reconcile.md: templates with {placeholders}, containing only task-specific instructions, the exact TSV format, and one short example
- prompts/rules.md: numbered one-line rules that apply to every call
Remove duplication and contradictions. List every rule you dropped or changed and why, so I can veto it. Keep each prompt as short as possible without losing a rule.
```

**Maintenance (whenever output is wrong)**
```
The pipeline produced a bad output. Below: the source excerpt, the LLM output, and what it should have been.
1. Name the error type: missed item, invented item, wrong hierarchy level, wrong column, or formatting.
2. Say where the fix belongs: rules.md, the template, the splitting logic, or the validator. Prefer a validator check whenever the error can be detected mechanically.
3. Give the exact change: one new numbered rule of at most two lines, or a code diff. Do not rewrite the whole prompt.
```

If any line in the SYSTEM summary is wrong, fix it once in the kickoff prompt. Phase 1 will surface anything else.