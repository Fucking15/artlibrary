# technique-kb

An open, machine-checkable knowledge base of **how a painter's technique changed over time** — built to sit underneath an AI Q&A layer, not to be read front to back.

Every sentence in this repository is a *claim*: one falsifiable statement, tied to a **graded source** (A / B / C), filed under one of six dimensions of one artist's period. The point is that an answer can always be traced back to a page, and that a **blank dimension is a validation error**, not an editorial choice.

> **Status: v0.1 scaffold.** One example dossier is included (`data/dossiers/schiele/1911-1914.yaml`). Its citations are schematic and explicitly flagged `example: true` — it demonstrates the structure, it is not publishable content.

## What this is not

- Not an art encyclopedia: no biography timelines, no "top 10 works", no plot summaries.
- Not image hosting: no image bytes are stored here (see [Images](#images)).
- Not a chatbot in disguise: the Q&A layer retrieves claims; it does not generate art history.

## Layout

```
schema/            JSON Schema (structure only, English field names)
  common.schema.json     enums + claim / evidence / IIIF reference / signature
  artists.schema.json    artist registry
  works.schema.json      work registry (carries the IIIF pointer)
  sources.schema.json    source registry (carries the A/B/C grade)
  dossier.schema.json    one artist-period: the six dimensions
data/
  registry/*.yaml        shared registries
  dossiers/<artist>/<period>.yaml
scripts/
  validate.mjs           structural + semantic validation, coverage report
  selftest.mjs           negative tests: proves each rule can actually fail
docs/
  schema.zh.md           中文字段说明与填写规则
```

## The six dimensions

A dossier is refused unless all six are present, each with at least one sourced claim:

| # | Dimension | What goes in it |
|---|---|---|
| 1 | `period` | start/end, the **basis for cutting the period here**, dated anchors |
| 2 | `lineage` | teacher / peer / group / movement → **which craft elements actually transferred** |
| 3 | `comparison` | a named counterpart on a named axis, what they did, what he did differently |
| 4 | `material` | support, medium, ground, **order of operations** |
| 5 | `composition` | five required sub-fields: `structure_proportion`, `color`, `framing`, `light_shadow`, `brushwork` |
| 6 | `subject_matter` | motifs, and why these motifs in this period |

Dimension 3 is the one no dataset can supply: "influenced by Klimt" with no axis named is exactly the vague sentence this repository exists to replace.

## Source grades

| Grade | Meaning | Examples |
|---|---|---|
| **A** | Scholarly | catalogue raisonné, monograph, peer-reviewed article, museum research document |
| **B** | Institutional | museum object page, official collection database, archive record |
| **C** | Secondary | exhibition microsite, press article, interview, documentary |

The grade is a property of the source, never of how much we like the claim. Rules the validator enforces:

- C-only evidence forces `confidence: low` **and** a `note_zh` stating the limit.
- A `signed` claim needs explicit confidence, a signer, and preferably two independent sources.
- Signed without any A-grade source is allowed but flagged.

## Validation

```bash
npm install
npm run validate          # structure + references + grading + coverage report
npm run validate:strict   # additionally: every dimension needs a signed claim
npm run selftest          # negative tests — breaks one rule at a time, expects refusal
```

Errors block. Warnings are debt. Notes are expected states (an example dossier, an unquoted date).

The rules that cannot be expressed in JSON Schema live in `scripts/validate.mjs`: cross-file reference resolution, C-only grading discipline, signature attribution (`example-*` reviewers may only sign example dossiers), and the no-blank-area rule.

`npm run selftest` exists because **a validator nobody has watched fail is a validator nobody can trust** — it mutates the real dataset six ways and asserts the refusal each time.

## Adding a period

1. Extract candidate claims from A/B sources into draft form (LLM assistance is fine here).
2. Fill all six dimensions; put anything unresolved in `open_questions` instead of guessing.
3. Replace every `（待核验）` locator with a page, plate or catalogue number.
4. Sign the claims you have personally checked (`status: signed` + `signed_by`).
5. `npm run validate` — no errors, and no `待核验` locators left in signed claims.

## Images

Works carry a **IIIF pointer**, never image bytes:

```yaml
iiif:
  status: resolved
  manifest: https://institution.example/iiif/manifest/1234
```

Claims can then point at the exact region they are talking about (`region: pct:25,10,50,60`), which is how "the contour runs uninterrupted" becomes something a reader can look at rather than take on faith. Photographic rights in the museum's surrogate stay with the institution; this repository only stores the pointer and the quote.

## Licensing

- Code (`scripts/`, `schema/`): MIT.
- **Data (`data/`): decision pending.** Quoted passages are short quotations for scholarship; the compilation itself needs an explicit licence (CC BY-SA 4.0 is the natural candidate) before any public release. Do not publish `data/` under MIT by default.

## Roadmap

- [ ] Replace the example dossier's schematic locators with real ones (blocking any release).
- [ ] Retrieval + answer layer: claim cards with grade, source, and IIIF region; explicit refusal when `open_questions` covers the question.
- [ ] Evaluation set: 50 questions with expected claims, so answer quality is measured rather than felt.
- [ ] Second artist, to prove the schema is not Schiele-shaped.
