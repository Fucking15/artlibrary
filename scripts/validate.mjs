#!/usr/bin/env node
/**
 * technique-kb validator
 *
 * Structure is checked by JSON Schema. What the schema cannot check is checked here:
 * cross-file references, source grading discipline, and the "no blank dimension" rule.
 *
 *   node scripts/validate.mjs            # validate + report
 *   node scripts/validate.mjs --strict   # also require a signed claim in every dimension
 *   node scripts/validate.mjs --stats-only
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// TK_ROOT lets the self-test point the same rule engine at a mutated copy of the data
const ROOT = process.env.TK_ROOT ? path.resolve(process.env.TK_ROOT) : path.resolve(HERE, '..');
const SCHEMA_DIR = path.join(ROOT, 'schema');
const DATA_DIR = path.join(ROOT, 'data');

const STRICT = process.argv.includes('--strict');
const STATS_ONLY = process.argv.includes('--stats-only');
const TODAY = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

const DIMENSIONS = ['period', 'lineage', 'comparison', 'material', 'composition', 'subject_matter'];
const COMPOSITION_FIELDS = ['structure_proportion', 'color', 'framing', 'light_shadow', 'brushwork'];

const problems = [];
const err = (where, message) => problems.push({ level: 'error', where, message });
const warn = (where, message) => problems.push({ level: 'warn', where, message });
const note = (where, message) => problems.push({ level: 'note', where, message });

/* ---------------------------------------------------------------- loading */

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

for (const file of fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json'))) {
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8')));
}

/**
 * js-yaml turns unquoted ISO dates into Date objects, while the schema wants ISO strings.
 * Normalise them here (so a forgotten pair of quotes never blocks the build) and say so.
 */
function normalizeDates(node, file) {
  if (node instanceof Date) {
    note(rel0(file), `unquoted date normalised to "${node.toISOString().slice(0, 10)}" — please quote it in the YAML`);
    return node.toISOString().slice(0, 10);
  }
  if (Array.isArray(node)) return node.map((item) => normalizeDates(item, file));
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) node[key] = normalizeDates(value, file);
    return node;
  }
  return node;
}

const rel0 = (file) => path.relative(ROOT, file).split(path.sep).join('/');

const readYaml = (file) => normalizeDates(yaml.load(fs.readFileSync(file, 'utf8')), file);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.yaml') || entry.name.endsWith('.yml') ? [full] : [];
  });
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function validateAgainst(schemaFile, doc, file) {
  const validate = ajv.getSchema(path.join(SCHEMA_DIR, schemaFile).replace(/\\/g, '/')) ??
    ajv.getSchema(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, schemaFile), 'utf8')).$id);
  if (!validate) {
    err(rel(file), `schema not registered: ${schemaFile}`);
    return false;
  }
  if (validate(doc)) return true;
  for (const e of validate.errors) {
    err(rel(file), `${e.instancePath || '/'} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`);
  }
  return false;
}

/* --------------------------------------------------------------- registries */

const registry = { artists: new Map(), works: new Map(), sources: new Map() };
const registryIds = new Set();

for (const [schemaFile, key, dir] of [
  ['artists.schema.json', 'artists', 'artists'],
  ['works.schema.json', 'works', 'works'],
  ['sources.schema.json', 'sources', 'sources'],
]) {
  const file = path.join(DATA_DIR, 'registry', `${dir}.yaml`);
  if (!fs.existsSync(file)) {
    err(`data/registry/${dir}.yaml`, 'registry file missing');
    continue;
  }
  const doc = readYaml(file);
  validateAgainst(schemaFile, doc, file);
  for (const item of doc?.[key] ?? []) {
    if (registryIds.has(item.id)) err(rel(file), `duplicate id: ${item.id}`);
    registryIds.add(item.id);
    registry[key].set(item.id, item);
  }
}

/* ---------------------------------------------------------------- dossiers */

const dossiers = [];
for (const file of walk(path.join(DATA_DIR, 'dossiers'))) {
  const doc = readYaml(file);
  const ok = validateAgainst('dossier.schema.json', doc, file);
  if (registryIds.has(doc?.dossier_id)) err(rel(file), `duplicate id: ${doc.dossier_id}`);
  registryIds.add(doc?.dossier_id);
  dossiers.push({ file, doc, schemaOk: ok });
}

/* ------------------------------------------------------------ claim walker */

function* claimsOf(dossier) {
  for (const claim of dossier.period?.claims ?? []) yield { dim: 'period', field: 'period', claim };
  for (const entry of dossier.lineage ?? []) {
    for (const claim of entry.claims ?? []) yield { dim: 'lineage', field: entry.id, claim };
  }
  for (const entry of dossier.comparison ?? []) {
    for (const claim of entry.claims ?? []) yield { dim: 'comparison', field: entry.id, claim };
  }
  for (const claim of dossier.material?.claims ?? []) yield { dim: 'material', field: 'material', claim };
  for (const field of COMPOSITION_FIELDS) {
    for (const claim of dossier.composition?.[field]?.claims ?? []) {
      yield { dim: 'composition', field, claim };
    }
  }
  for (const claim of dossier.subject_matter?.claims ?? []) yield { dim: 'subject_matter', field: 'subject_matter', claim };
}

/* ------------------------------------------------------- semantic rules */

for (const { file, doc } of dossiers) {
  const where = rel(file);
  const artist = registry.artists.get(doc.artist);
  if (!artist) err(where, `artist not found in registry: ${doc.artist}`);
  if (doc.period?.id !== doc.dossier_id) err(where, 'period.id must equal dossier_id');
  if ((doc.period?.start_year ?? 0) > (doc.period?.end_year ?? 0)) err(where, 'period.start_year > end_year');

  for (const anchor of doc.period?.anchors ?? []) {
    if (anchor.year < doc.period.start_year || anchor.year > doc.period.end_year) {
      warn(where, `anchor ${anchor.year} (${anchor.event_zh.slice(0, 18)}…) falls outside the period`);
    }
  }

  for (const [kind, list] of [['lineage', doc.lineage], ['comparison', doc.comparison]]) {
    for (const entry of list ?? []) {
      const cp = entry.counterpart ?? {};
      if (cp.registry_ref && !registry.artists.has(cp.registry_ref)) {
        err(where, `${kind}.${entry.id}: counterpart registry_ref not found: ${cp.registry_ref}`);
      }
      if (!cp.registry_ref && !cp.external_authority && cp.type !== 'self_prior_period' && cp.type !== 'group') {
        warn(where, `${kind}.${entry.id}: counterpart has neither registry_ref nor external_authority`);
      }
    }
  }

  for (const workId of doc.works ?? []) {
    const work = registry.works.get(workId);
    if (!work) {
      err(where, `works: unknown work ${workId}`);
      continue;
    }
    if (work.artist !== doc.artist) err(where, `works: ${workId} belongs to ${work.artist}, not ${doc.artist}`);
    if (work.attribution !== 'autograph') {
      err(where, `works: ${workId} is "${work.attribution}" — copies can never be evidence`);
    }
  }

  const byDim = Object.fromEntries(DIMENSIONS.map((d) => [d, []]));
  const isExampleDoc = doc.meta?.example === true;
  // in an example dossier unverified locators are the expected state, not a finding
  const flag = (m) => (isExampleDoc ? note(where, m) : warn(where, m));

  for (const { dim, field, claim } of claimsOf(doc)) {
    byDim[dim].push({ field, claim });

    // evidence must resolve, and grading discipline must hold
    const grades = [];
    for (const ev of claim.evidence ?? []) {
      const source = registry.sources.get(ev.source);
      if (!source) {
        err(where, `${dim}/${field}: unknown source ${ev.source}`);
        continue;
      }
      grades.push(source.grade);
      if ((ev.locator ?? '').includes('待核验')) {
        flag(`${dim}/${field}: locator still unverified → ${ev.locator}`);
      }
    }

    const worst = grades.length ? grades.reduce((a, b) => (a > b ? a : b)) : null; // C > B > A
    const best = grades.length ? grades.reduce((a, b) => (a < b ? a : b)) : null;

    const allC = grades.length > 0 && grades.every((g) => g === 'C');
    if (allC) {
      if (claim.confidence && claim.confidence !== 'low') {
        err(where, `${dim}/${field}: C-only evidence must be confidence "low" (got "${claim.confidence}")`);
      }
      if (!claim.note_zh) err(where, `${dim}/${field}: C-only evidence requires note_zh stating the limit`);
    }
    if (claim.status === 'signed' && !claim.confidence) {
      err(where, `${dim}/${field}: signed claim requires explicit confidence`);
    }

    for (const ref of claim.iiif_evidence ?? []) {
      const work = registry.works.get(ref.work);
      if (!work) err(where, `${dim}/${field}: iiif_evidence points at unknown work ${ref.work}`);
      else if (work.attribution !== 'autograph') {
        err(where, `${dim}/${field}: iiif_evidence points at a ${work.attribution} object`);
      } else if (work.iiif?.status !== 'resolved') {
        flag(`${dim}/${field}: iiif_evidence on ${ref.work} but its manifest is "${work.iiif?.status ?? 'unset'}"`);
      }
    }

    // signing discipline
    if (claim.status === 'signed') {
      const signer = claim.signed_by?.reviewer ?? '';
      const isExample = doc.meta?.example === true;
      if (isExample && !signer.startsWith('example-')) {
        err(where, `${dim}/${field}: example dossier may only carry example-* signatures (got "${signer}")`);
      }
      if (!isExample && signer.startsWith('example-')) {
        err(where, `${dim}/${field}: example-* signature in a real dossier`);
      }
      if (claim.signed_by?.date && claim.signed_by.date > TODAY) {
        err(where, `${dim}/${field}: signature dated in the future (${claim.signed_by.date})`);
      }
      if ((claim.evidence ?? []).length < 2) {
        warn(where, `${dim}/${field}: signed on a single piece of evidence — prefer two independent sources`);
      }
      if (best && best !== 'A') {
        warn(where, `${dim}/${field}: signed without any A-grade source (best: ${best})`);
      }
    }

    // a statement should be one sentence: strip the closing punctuation, then look for an internal break
    const statementBody = (claim.statement_zh ?? '').replace(/[。．.！!？?]+$/, '');
    if (/[。；;]/.test(statementBody)) {
      warn(where, `${dim}/${field}: statement contains more than one sentence — split it`);
    }
  }

  // the point of the whole format: no blank areas
  const dimSigneds = {};
  for (const dim of DIMENSIONS) {
    const items = byDim[dim];
    if (items.length === 0) err(where, `blank area: dimension "${dim}" has no claim`);
    dimSigneds[dim] = items.filter((i) => i.claim.status === 'signed').length;
    if (STRICT && dimSigneds[dim] === 0) err(where, `strict: dimension "${dim}" has no signed claim`);
  }
  for (const field of COMPOSITION_FIELDS) {
    const items = byDim.composition.filter((i) => i.field === field);
    if (items.length === 0) err(where, `blank area: composition.${field} has no claim`);
    if (STRICT && !items.some((i) => i.claim.status === 'signed')) {
      err(where, `strict: composition.${field} has no signed claim`);
    }
  }

  const allGrades = [...claimsOf(doc)].flatMap(({ claim }) =>
    (claim.evidence ?? []).map((ev) => registry.sources.get(ev.source)?.grade).filter(Boolean),
  );
  if (allGrades.length && !allGrades.includes('A')) {
    warn(where, 'no A-grade source anywhere in this dossier — it cannot be called scholarly yet');
  }
  if (doc.meta?.example === true) {
    note(where, 'example dossier: citations are schematic, must not be published as-is');
  }

  doc.__stats = { byDim, dimSigneds, allGrades };
}

/* --------------------------------------------------------------------- report */

const color = (code, text) => (process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text);
const errors = problems.filter((p) => p.level === 'error');
const warns = problems.filter((p) => p.level === 'warn');
const notes = problems.filter((p) => p.level === 'note');

if (!STATS_ONLY) {
  for (const p of problems) {
    const tag = p.level === 'error' ? color(31, 'ERROR') : p.level === 'warn' ? color(33, 'WARN ') : color(36, 'NOTE ');
    console.log(`${tag} ${p.where}\n      ${p.message}`);
  }
  if (problems.length === 0) console.log(color(32, '✓ schema, references and grading rules all clean'));
  console.log('');
}

console.log(`artists ${registry.artists.size} · works ${registry.works.size} · sources ${registry.sources.size} · dossiers ${dossiers.length}`);
console.log('');

for (const { doc } of dossiers) {
  const s = doc.__stats;
  if (!s) continue;
  console.log(`${doc.dossier_id}  [${doc.meta?.status}]${doc.meta?.example ? ' (example)' : ''}`);
  for (const dim of DIMENSIONS) {
    const items = s.byDim[dim];
    const grades = items
      .flatMap((i) => (i.claim.evidence ?? []).map((ev) => registry.sources.get(ev.source)?.grade ?? '?'))
      .sort()
      .join('');
    const pad = dim.padEnd(16, ' ');
    console.log(`  ${pad} claims ${String(items.length).padStart(2)}  signed ${String(s.dimSigneds[dim]).padStart(2)}  grades ${grades || '—'}`);
    if (dim === 'composition') {
      for (const field of COMPOSITION_FIELDS) {
        const fItems = items.filter((i) => i.field === field);
        console.log(`    ${field.padEnd(22, ' ')} claims ${String(fItems.length).padStart(2)}`);
      }
    }
  }
  console.log('');
}

console.log(
  `${color(31, String(errors.length) + ' error(s)')} · ${color(33, String(warns.length) + ' warning(s)')} · ${notes.length} note(s)`,
);

process.exit(errors.length > 0 ? 1 : 0);
