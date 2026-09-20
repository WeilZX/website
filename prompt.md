Below are four prompts. Run 1 first — it's the diagnostic and it decides whether 2 vs 3 is even a real choice. Use one representative document for all of them so the comparison is clean.

## 1. Diagnostic — run this first

Paste with: the hierarchy document, the current schema, one source document, and ~20 rows of current flattened output.

```
You are analysing a document-to-spreadsheet extraction pipeline. I have
attached four things:

1. A document that defines the hierarchy of the domain
2. The current target schema for the flattened output
3. One representative source document to be converted
4. A sample of the flattened records currently produced

The final deliverable is a flat table in Excel. I am considering an
intermediate representation: the LLM extracts a structured, non-flattened
form, and deterministic spreadsheet logic expands that into the flat rows.

Answer the following. Be specific and cite the attached material. Do not
give general advice about data modelling.

A. HIERARCHY
   State the containment hierarchy actually present in the source document,
   level by level, from outermost to innermost. For each level give: the
   name it is called in the documents, roughly how many instances appear
   per parent, and the fields that belong at that level and no other.

B. AGREEMENT
   Does the hierarchy in document (1) match the hierarchy implied by the
   flattened schema in (2)? List every disagreement. For each, say which
   of the two is consistent with the source document (3).

C. COLUMN CLASSIFICATION
   Produce a table with one row per column in the flattened schema and
   these columns:
     - column name
     - hierarchy level it belongs to
     - SOURCE (stated in the document) / DERIVED (computed, defaulted,
       looked up, or a sequence number) / INHERITED (a parent field
       repeated onto child rows)
     - if DERIVED, the exact rule
   Be exhaustive. Do not omit columns you are unsure about; mark them
   UNKNOWN and say why.

D. CARDINALITY
   Identify any relationship in this domain that is genuinely many-to-many
   rather than strict containment - for example an item that legitimately
   belongs to more than one parent. If there are none, say so explicitly.

E. VARIABILITY
   The existing tool handles only one type. Looking at the source document
   and the schema, identify what specifically breaks when a different type
   is processed: which fields appear or disappear, which levels change
   depth, which assumptions in the flat schema stop holding.

F. RECOMMENDATION
   Given all the above, recommend an intermediate representation and
   justify it in terms of what you found, not in general terms. Then state
   the exact deterministic rule that converts your recommended
   intermediate form into the flattened schema.
```

C and E are the ones to read carefully. C tells you exactly what to delete from the extraction prompt; E tells you why the macro is stuck on one type.

## 2. Variant A — nested JSON

```
Extract the attached document into structured JSON.

HIERARCHY
Use exactly this nesting: [PASTE HIERARCHY FROM DIAGNOSTIC ANSWER A]

RULES
- Output JSON only. No prose, no explanation, no markdown fences.
- Extract only what the document states. Do not compute, infer, default,
  or look up any value.
- Do not emit row IDs, sequence numbers, or composite keys.
- Never repeat a parent's field onto a child object. Each field appears
  exactly once, at the level it belongs to.
- If a field applies at a level but the document does not state a value,
  emit null. If a field does not apply at that level at all, omit the key.
  These are different and the distinction matters.
- Every object carries a "source" field: the page, section, or table
  number it was read from.
- Preserve the document's original wording for names and descriptive text.
  Do not normalise, retitle, or expand abbreviations.
- Preserve document order at every level.
- If the document is ambiguous or self-contradictory at some point, still
  emit your best reading, and add a "flag" field on that object with a
  one-sentence description of the problem.

SCHEMA
[PASTE THE NESTED SCHEMA - SOURCE FIELDS ONLY, NO DERIVED COLUMNS]
```

## 3. Variant B — one table per level, tab-separated

This is the one I would bet on for your situation. Each level becomes its own Excel sheet, you join them with Power Query or lookups, and every level is short enough to eyeball against the document by hand.

```
Extract the attached document into one table per hierarchy level.

HIERARCHY
[PASTE HIERARCHY FROM DIAGNOSTIC ANSWER A]

OUTPUT FORMAT
One block per level, in order from outermost to innermost. Each block:

### [level name]
A tab-separated table. First line is the header row. No other formatting,
no markdown table pipes, no code fences, no prose between blocks.

KEYS
- Each table's first column is "key": a stable identifier you assign,
  built from the level name and a number, e.g. ASSET_01, TASK_014.
- Every table below the top level has a second column "parent_key"
  containing the key of its parent row.
- Keys must be unique within a table and every parent_key must exist in
  the table above. Check this before you finish.

RULES
- Extract only what the document states. Do not compute, infer, default,
  or look up any value.
- A field appears in exactly one table - the level it belongs to. Never
  repeat a parent's field in a child table.
- Empty cell means the document does not state a value. Never write "N/A",
  "none", "-", or a guess.
- Last column of every table is "source": page, section, or table number.
- Preserve the document's original wording and the document's row order.
- If a value contains a tab or newline, replace it with a single space.
- After the tables, output one line per table: "### counts" followed by
  level name and row count, tab separated. Nothing else.
```

The count block at the end is your first sanity check — you verify it against the document before you look at a single field.

## 4. Verification — run against each variant's output

Fresh context, so it re-reads rather than defends its earlier work.

```
Attached are a source document and a structured extraction of it.

Check the extraction against the document only. Do not assume the
extraction is correct.

Report, in this order:
1. Rows or objects present in the extraction that you cannot find in the
   document.
2. Items in the document that are missing from the extraction.
3. Fields whose value differs from the document, with both values quoted.
4. Fields where the extraction has filled in a value the document does not
   state - defaults, inferences, expanded abbreviations, normalised names.
5. Any place a parent-level field has been copied onto child items.
6. Broken parent references, if the format uses keys.

If a category is empty, write "none". Output nothing else.
```

## Running the comparison

Run 2 and 3 three times each on the same document at whatever temperature the platform gives you. You are measuring two things:

- **Variance across the three runs** — diff them against each other. This is the number that decides it. A representation the model can't reproduce consistently is unusable regardless of how good the best run looks.
- **Defect count from prompt 4** — especially categories 4 and 5, since those are exactly what the flat approach produces most of.

Then flatten one good output and diff it against the macro's output on the same document. Remaining differences are either macro bugs or derived fields you haven't implemented yet — both worth knowing.

One note on B: since your keys are assigned by the model, verify uniqueness in Excel with a `COUNTIF` on the key column before joining anything. It takes ten seconds and catches the one failure mode that would otherwise silently duplicate rows in your final output.