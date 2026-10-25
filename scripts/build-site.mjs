#!/usr/bin/env node
/**
 * Build the static site payload.
 *
 * The site is deliberately dumb: everything it needs is pre-resolved into one JSON file,
 * so GitHub Pages only has to serve three static files and there is no client-side join
 * between claims and sources that could silently disagree with the validator.
 *
 *   node scripts/build-site.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TK_ROOT ? path.resolve(process.env.TK_ROOT) : path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'site', 'data', 'index.json');

const DIMENSIONS = ['period', 'lineage', 'comparison', 'material', 'composition', 'subject_matter'];
const COMPOSITION_FIELDS = ['structure_proportion', 'color', 'framing', 'light_shadow', 'brushwork'];

const read = (rel) => yaml.load(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.yaml') || entry.name.endsWith('.yml') ? [full] : [];
  });
}

const artists = new Map(read('data/registry/artists.yaml').artists.map((a) => [a.id, a]));
const works = new Map(read('data/registry/works.yaml').works.map((w) => [w.id, w]));
const sources = new Map(read('data/registry/sources.yaml').sources.map((s) => [s.id, s]));

const gradeLabel = {
  A: '学术 catalogue raisonné / 论文',
  B: '机构 馆藏官网 / 档案',
  C: '次级 展览页 / 媒体',
};

function citation(src) {
  const c = src.citation ?? {};
  const authors = (c.authors ?? []).join(', ');
  const parts = [];
  if (authors) parts.push(authors);
  parts.push(c.title);
  if (c.container) parts.push(c.container);
  if (c.publisher) parts.push(c.publisher);
  if (c.place) parts.push(c.place);
  return `${parts.join(' · ')}${c.year ? `, ${c.year}` : ''}${c.pages ? `, ${c.pages}` : ''}`;
}

function enrichEvidence(ev) {
  const src = sources.get(ev.source);
  return {
    grade: src?.grade ?? '?',
    gradeLabel: gradeLabel[src?.grade] ?? '未登记来源',
    citation: src ? citation(src) : ev.source,
    url: src?.url ?? null,
    kind: src?.kind ?? null,
    locator: ev.locator,
    quote: ev.quote,
    quote_lang: ev.quote_lang ?? null,
    translation_zh: ev.translation_zh ?? null,
    unverified: String(ev.locator ?? '').includes('待核验'),
  };
}

function enrichClaim(claim) {
  const evidence = (claim.evidence ?? []).map(enrichEvidence);
  return {
    statement_zh: claim.statement_zh ?? null,
    not_applicable: claim.not_applicable === true,
    reason_zh: claim.reason_zh ?? null,
    medium: claim.medium ?? [],
    confidence: claim.confidence ?? null,
    status: claim.status,
    note_zh: claim.note_zh ?? null,
    signed_by: claim.signed_by ?? null,
    evidence,
    grades: [...new Set(evidence.map((e) => e.grade))].sort(),
    iiif: (claim.iiif_evidence ?? []).map((ref) => ({ ...ref, workTitle: works.get(ref.work)?.title?.zh ?? ref.work })),
  };
}

const claims = (list) => (list ?? []).map(enrichClaim);

function buildDossier(doc) {
  const artist = artists.get(doc.artist);

  const dimensions = {
    period: claims(doc.period?.claims),
    lineage: (doc.lineage ?? []).map((entry) => ({
      id: entry.id,
      relation: entry.relation,
      counterpart: entry.counterpart?.label_zh ?? '—',
      counterpartType: entry.counterpart?.type ?? null,
      window: entry.window ?? null,
      elements: entry.transmitted_elements ?? [],
      summary_zh: entry.summary_zh,
      claims: claims(entry.claims),
    })),
    comparison: (doc.comparison ?? []).map((entry) => ({
      id: entry.id,
      counterpart: entry.counterpart?.label_zh ?? '—',
      axis: entry.axis,
      their_practice_zh: entry.their_practice_zh,
      his_difference_zh: entry.his_difference_zh,
      claims: claims(entry.claims),
    })),
    material: {
      supports: doc.material?.supports ?? [],
      mediums: doc.material?.mediums ?? [],
      ground_zh: doc.material?.ground_zh ?? null,
      process_zh: doc.material?.process_zh ?? null,
      claims: claims(doc.material?.claims),
    },
    composition: Object.fromEntries(
      COMPOSITION_FIELDS.map((field) => [
        field,
        {
          summary_zh: doc.composition?.[field]?.summary_zh ?? null,
          claims: claims(doc.composition?.[field]?.claims),
        },
      ]),
    ),
    subject_matter: {
      motifs: doc.subject_matter?.motifs ?? [],
      rationale_zh: doc.subject_matter?.rationale_zh ?? null,
      claims: claims(doc.subject_matter?.claims),
    },
  };

  const allClaims = collectClaims(dimensions);
  const gradeCount = { A: 0, B: 0, C: 0 };
  for (const claim of allClaims) for (const grade of claim.grades) gradeCount[grade] = (gradeCount[grade] ?? 0) + 1;

  // 画种: which media this dossier speaks for, and how many entries answer each
  const mediaCounts = {};
  for (const claim of allClaims) {
    for (const medium of claim.medium) {
      if (medium === 'period_level') continue;
      mediaCounts[medium] = (mediaCounts[medium] ?? 0) + 1;
    }
  }
  const declaredMedia = doc.media_covered ?? Object.keys(mediaCounts);

  return {
    id: doc.dossier_id,
    artist: { id: doc.artist, zh: artist?.names?.zh ?? doc.artist, en: artist?.names?.en ?? '' },
    artistMeta: {
      birth: artist?.birth_year ?? null,
      death: artist?.death_year ?? null,
      birthPlace: artist?.birth_place_zh ?? null,
      corpus: allClaims.length,
    },
    period: {
      label: doc.period?.label ?? { zh: doc.dossier_id, en: '' },
      start_year: doc.period?.start_year,
      end_year: doc.period?.end_year,
      basis_zh: doc.period?.basis_zh,
      anchors: (doc.period?.anchors ?? []).map((a) => ({
        year: a.year,
        month_day: a.month_day ?? null,
        event_zh: a.event_zh,
        evidence: (a.evidence ?? []).map(enrichEvidence),
      })),
    },
    dimensions,
    works: (doc.works ?? []).map((id) => {
      const w = works.get(id);
      return {
        id,
        title: w?.title ?? { zh: id, en: '' },
        year: w?.year?.from ?? null,
        medium_category: w?.medium_category ?? null,
        support: w?.support ?? null,
        mediums: w?.mediums ?? [],
        collection: w?.collection ?? null,
        attribution: w?.attribution ?? null,
        iiif: w?.iiif ?? null,
      };
    }),
    media: { declared: declaredMedia, counts: mediaCounts },
    open_questions: (doc.open_questions ?? []).map((q) => ({
      question_zh: q.question_zh,
      why_open_zh: q.why_open_zh,
      needs: q.needs ?? [],
    })),
    stats: {
      claims: allClaims.length,
      signed: allClaims.filter((c) => c.status === 'signed').length,
      notApplicable: allClaims.filter((c) => c.not_applicable).length,
      grades: gradeCount,
      unverifiedLocators: allClaims.reduce((n, c) => n + c.evidence.filter((e) => e.unverified).length, 0),
    },
    meta: {
      status: doc.meta?.status,
      version: doc.meta?.version,
      updated: doc.meta?.updated,
      example: doc.meta?.example === true,
      notes_zh: doc.meta?.notes_zh ?? null,
      signers: [...new Set(allClaims.map((c) => c.signed_by?.reviewer).filter(Boolean))],
    },
  };
}

function collectClaims(dimensions) {
  const out = [...dimensions.period];
  for (const entry of dimensions.lineage) out.push(...entry.claims);
  for (const entry of dimensions.comparison) out.push(...entry.claims);
  out.push(...dimensions.material.claims);
  for (const field of COMPOSITION_FIELDS) out.push(...dimensions.composition[field].claims);
  out.push(...dimensions.subject_matter.claims);
  return out;
}

const dossiers = walk(path.join(ROOT, 'data', 'dossiers'))
  .map((file) => buildDossier(yaml.load(fs.readFileSync(file, 'utf8'))))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));

const payload = {
  generated_at: new Date().toISOString(),
  schema_version: '0.1.0',
  dims: DIMENSIONS,
  composition_fields: COMPOSITION_FIELDS,
  counts: {
    artists: artists.size,
    works: works.size,
    sources: sources.size,
    dossiers: dossiers.length,
    claims: dossiers.reduce((n, d) => n + d.stats.claims, 0),
  },
  sources: [...sources.values()].map((s) => ({
    id: s.id,
    grade: s.grade,
    kind: s.kind,
    citation: citation(s),
    url: s.url ?? null,
    lang: s.lang,
    note_zh: s.notes_zh ?? null,
  })),
  dossiers,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1), 'utf8');

const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1);
console.log(`site/data/index.json  ${dossiers.length} dossier(s) · ${payload.counts.claims} claims · ${payload.counts.sources} sources · ${kb} KB`);
