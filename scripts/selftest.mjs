#!/usr/bin/env node
/**
 * Negative tests for the rule engine.
 *
 * A validator nobody has seen fail is a validator nobody can trust. Each case below takes the
 * real dataset, breaks exactly one rule, and asserts the validator refuses it.
 *
 *   node scripts/selftest.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');


/* The validator resolves data paths from ROOT; the self-test therefore swaps files in place
   inside a scratch copy of the project rather than inventing a second code path. */
function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'technique-kb-'));
  fs.cpSync(path.join(ROOT, 'schema'), path.join(dir, 'schema'), { recursive: true });
  fs.cpSync(DATA, path.join(dir, 'data'), { recursive: true });
  return dir;
}

const cases = [
  {
    name: 'blank composition field is rejected',
    expect: /blank area: composition\.color/,
    mutate(dir) {
      const doc = yaml.load(fs.readFileSync(path.join(dir, 'data/dossiers/schiele/1911-1914.yaml'), 'utf8'));
      delete doc.composition.color;
      fs.writeFileSync(path.join(dir, 'data/dossiers/schiele/1911-1914.yaml'), yaml.dump(doc));
    },
  },
  {
    name: 'C-only evidence cannot claim high confidence',
    expect: /C-only evidence must be confidence "low"/,
    mutate(dir) {
      const file = path.join(dir, 'data/dossiers/schiele/1911-1914.yaml');
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      const claim = doc.subject_matter.claims[1];
      claim.confidence = 'high';
      delete claim.note_zh;
      fs.writeFileSync(file, yaml.dump(doc));
    },
  },
  {
    name: 'unknown source reference is rejected',
    expect: /unknown source src.does-not-exist/,
    mutate(dir) {
      const file = path.join(dir, 'data/dossiers/schiele/1911-1914.yaml');
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      doc.period.claims[0].evidence[0].source = 'src.does-not-exist';
      fs.writeFileSync(file, yaml.dump(doc));
    },
  },
  {
    name: 'an "after Schiele" copy can never be evidence',
    expect: /copies can never be evidence/,
    mutate(dir) {
      const file = path.join(dir, 'data/registry/works.yaml');
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      doc.works[0].attribution = 'workshop_or_copy';
      fs.writeFileSync(file, yaml.dump(doc));
    },
  },
  {
    name: 'a real dossier may not carry example-* signatures',
    expect: /example-\* signature in a real dossier/,
    mutate(dir) {
      const file = path.join(dir, 'data/dossiers/schiele/1911-1914.yaml');
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      delete doc.meta.example;
      fs.writeFileSync(file, yaml.dump(doc));
    },
  },
  {
    name: 'a signature dated in the future is rejected',
    expect: /signature dated in the future/,
    mutate(dir) {
      const file = path.join(dir, 'data/dossiers/schiele/1911-1914.yaml');
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      doc.material.claims[0].signed_by.date = '2099-01-01';
      fs.writeFileSync(file, yaml.dump(doc));
    },
  },
  {
    name: 'a periodization claim tied to one 画种 is rejected',
    expect: /periodization claim must be "period_level"/,
    mutate(dir) {
      const file = path.join(dir, 'data/dossiers/schiele/1911-1914.yaml');
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      doc.period.claims[0].medium = ['oil'];
      fs.writeFileSync(file, yaml.dump(doc));
    },
  },
  {
    name: 'a paper claim illustrated with an oil painting is rejected',
    expect: /iiif_evidence points at a oil work/,
    mutate(dir) {
      const file = path.join(dir, 'data/dossiers/schiele/1911-1914.yaml');
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      doc.composition.structure_proportion.claims[0].medium = ['drawing_on_paper'];
      fs.writeFileSync(file, yaml.dump(doc));
    },
  },
  {
    name: 'a 画种 that answers nothing for one dimension is rejected',
    expect: /blank area: 画种 "drawing_on_paper" answers nothing for "composition\.color"/,
    mutate(dir) {
      const file = path.join(dir, 'data/dossiers/schiele/1911-1914.yaml');
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      doc.composition.color.claims = doc.composition.color.claims.filter((c) => c.not_applicable !== true);
      fs.writeFileSync(file, yaml.dump(doc));
    },
  },
  {
    name: 'a six-画种 general rule with one 画种 of evidence is rejected in strict mode',
    strict: true,
    expect: /claims to hold for all six 画种/,
    mutate(dir) {
      const file = path.join(dir, 'data/dossiers/schiele/1911-1914.yaml');
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      doc.composition.brushwork.claims[0].medium = [
        'oil',
        'oil_on_panel',
        'watercolor',
        'colored_on_paper',
        'drawing_on_paper',
        'print',
      ];
      fs.writeFileSync(file, yaml.dump(doc));
    },
  },
];

/* --- baseline: the shipped dataset must pass -------------------------------------------- */

const baseline = spawnSync(process.execPath, [path.join(HERE, 'validate.mjs')], {
  env: { ...process.env, TK_ROOT: ROOT },
  encoding: 'utf8',
});
let failures = 0;

if (baseline.status !== 0) {
  console.log('FAIL  baseline: the shipped dataset does not validate');
  console.log(`${baseline.stdout ?? ""}${baseline.stderr ?? ""}`.split('\n').filter((l) => l.includes('ERROR')).join('\n'));
  process.exit(1);
}
console.log('PASS  baseline: shipped dataset validates');

/* --- negative cases --------------------------------------------------------------------- */

for (const testCase of cases) {
  const dir = scratchRepo();
  try {
    testCase.mutate(dir);
    const args = [path.join(HERE, 'validate.mjs')];
    if (testCase.strict) args.push('--strict');
    const result = spawnSync(process.execPath, args, {
      env: { ...process.env, TK_ROOT: dir },
      encoding: 'utf8',
    });
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const caught = result.status !== 0 && testCase.expect.test(out);
    console.log(`${caught ? 'PASS' : 'FAIL'}  ${testCase.name}`);
    if (!caught) {
      failures += 1;
      console.log(out.split('\n').slice(0, 12).map((l) => `        ${l}`).join('\n'));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('');
console.log(failures === 0 ? `all ${cases.length + 1} checks passed` : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
