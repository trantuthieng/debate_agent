const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CollectionAcceptanceService, extractCollectionCountRequirements } = require('../../out/services/collectionAcceptanceService');

function fixture(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-acceptance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const jsonBinding = (file = 'levels.json', pointer = '') => ({ label: 'levels', source: { kind: 'json-array', file, pointer } });
const moduleBinding = (file = 'levels.cjs', name = 'levels', pointer = '') => ({ label: 'levels', source: { kind: 'module-export', file, export: name, pointer } });

test('count extraction uses explicit collection nouns, modifiers, and bilingual quantifiers', () => {
  const requirements = extractCollectionCountRequirements('Build exactly 20 distinct playable levels, at least 12 questions, and at most 8 pages. Tạo đúng 15 màn chơi, tối thiểu 3 giai đoạn và tối đa 9 mục.');
  assert.deepEqual(requirements.map(({ label, expectedCount, comparison }) => [label, expectedCount, comparison]), [
    ['levels', 20, 'exactly'], ['questions', 12, 'at-least'], ['pages', 8, 'at-most'],
    ['levels', 15, 'exactly'], ['stages', 3, 'at-least'], ['items', 9, 'at-most'],
  ]);
});

test('count extraction ignores hardware, suffix level numbers, decimal fragments, negation, and pagination size', () => {
  assert.deepEqual(extractCollectionCountRequirements('Use M4 24 GB RAM; 5 models debate for 4 rounds. Show victory after level 20. Use 2.5 items, 20 MB pages, 10 items per page, not 30 levels, 100 questions/page.'), []);
  assert.deepEqual(extractCollectionCountRequirements('Create a 20-level game with 20 levels; test all 20 levels.').map(item => item.expectedCount), [20]);
});

test('exact count is measured from JSON and cannot be replaced by a manifest claim', async t => {
  const root = fixture(t, { 'levels.json': [{ id: 1 }], 'acceptance.json': {
    collections: [{ ...jsonBinding(), expectedCount: 1, actualCount: 20 }],
  } });
  const report = await new CollectionAcceptanceService(root).verify('Create exactly 20 playable levels.');
  assert.equal(report.failed, true);
  assert.equal(report.unverified, false);
  assert.equal(report.checks[0].expectedCount, 20);
  assert.equal(report.checks[0].actualCount, 1);
  assert.match(report.checks[0].diagnostic, /contains 1 levels.*original goal requires exactly 20/);
});

test('a complete JSON collection passes, and the original goal wins over any declared expectation', async t => {
  const root = fixture(t, { 'levels.json': Array.from({ length: 20 }, (_, id) => ({ id })) });
  const service = new CollectionAcceptanceService(root);
  const passed = await service.verify('Build 20 levels.', [jsonBinding()]);
  assert.equal(passed.checks[0].status, 'passed');
  assert.equal(passed.failed, false);
  assert.equal(passed.unverified, false);
  const failed = await service.verify('Build 30 levels.', [{ ...jsonBinding(), expectedCount: 20 }]);
  assert.equal(failed.checks[0].status, 'failed');
  assert.equal(failed.checks[0].expectedCount, 30);
});

test('at-least and at-most comparisons use measured counts rather than exact equality', async t => {
  const root = fixture(t, { 'levels.json': [1, 2, 3] });
  const service = new CollectionAcceptanceService(root);
  assert.equal((await service.verify('At least 2 levels', [jsonBinding()])).checks[0].status, 'passed');
  assert.equal((await service.verify('At most 4 levels', [jsonBinding()])).checks[0].status, 'passed');
  assert.equal((await service.verify('At most 2 levels', [jsonBinding()])).checks[0].status, 'failed');
});

test('JSON Pointers resolve nested escaped names and do not count scalar declarations', async t => {
  const root = fixture(t, { 'levels.json': { 'campaign/a~b': { levels: [1, 2, 3] }, count: 20 } });
  const service = new CollectionAcceptanceService(root);
  assert.equal((await service.verify('3 levels', [jsonBinding('levels.json', '/campaign~1a~0b/levels')])).checks[0].status, 'passed');
  const scalar = await service.verify('20 levels', [jsonBinding('levels.json', '/count')]);
  assert.equal(scalar.failed, true);
  assert.match(scalar.checks[0].diagnostic, /array, not a declared numeric count/);
  const missing = await service.verify('20 levels', [jsonBinding('levels.json', '/missing')]);
  assert.match(missing.checks[0].diagnostic, /Pointer.*not found/);
  assert.equal((await service.verify('20 levels', [jsonBinding('levels.json', '/bad~2pointer')])).failed, true);
});

test('no binding is unverified, even when a one-level JSON file could be a procedural template', async t => {
  const root = fixture(t, { 'levels.json': [{ template: true }] });
  const report = await new CollectionAcceptanceService(root).verify('20 levels');
  assert.equal(report.failed, false);
  assert.equal(report.unverified, true);
  assert.equal(report.checks[0].status, 'unverified');
  assert.equal(report.checks[0].actualCount, undefined);
  assert.match(report.checks[0].diagnostic, /acceptance\.json.*Procedural collections are supported/);
});

test('ambiguous declarations are unverified, never guessed from a file name', async t => {
  const root = fixture(t, { 'levels.json': [1] });
  const report = await new CollectionAcceptanceService(root).verify('20 levels', [jsonBinding(), jsonBinding()]);
  assert.equal(report.unverified, true);
  assert.equal(report.failed, false);
  assert.match(report.checks[0].diagnostic, /Multiple bindings.*authoritative/);
});

test('actual procedural CommonJS array is measured despite a one-entry JSON template', async t => {
  const root = fixture(t, {
    'levels.json': [{ template: true }],
    'levels.cjs': 'const template=require("./levels.json")[0];module.exports={levels:Array.from({length:20},(_,id)=>({...template,id}))};',
  });
  const report = await new CollectionAcceptanceService(root).verify('Exactly 20 distinct playable levels', [moduleBinding()]);
  assert.equal(report.checks[0].status, 'passed', JSON.stringify(report));
  assert.equal(report.checks[0].actualCount, 20);
});

test('ESM default exports, nested module pointers, and Vietnamese binding labels are supported', async t => {
  const root = fixture(t, { 'levels.mjs': 'export default {campaign:{levels:Array.from({length:4},(_,id)=>({id}))}};' });
  const binding = { ...moduleBinding('levels.mjs', 'default', '/campaign/levels'), label: 'màn' };
  const report = await new CollectionAcceptanceService(root).verify('Tạo 4 màn chơi', [binding]);
  assert.equal(report.checks[0].status, 'passed', JSON.stringify(report));
  assert.equal(report.checks[0].actualCount, 4);
});

test('module stdout claims cannot substitute for the measured exported array', async t => {
  const root = fixture(t, { 'levels.cjs': 'console.log(JSON.stringify({actualCount:20}));console.log("20 levels passed");module.exports.levels=[1];' });
  const report = await new CollectionAcceptanceService(root).verify('20 levels', [moduleBinding()]);
  assert.equal(report.failed, true);
  assert.equal(report.checks[0].actualCount, 1);
});

test('non-array export and module runtime failure are failing evidence', async t => {
  const root = fixture(t, { 'count.cjs': 'module.exports.levels=20;', 'broken.cjs': 'throw new Error("missing runtime dependency");' });
  const service = new CollectionAcceptanceService(root);
  const count = await service.verify('20 levels', [moduleBinding('count.cjs')]);
  assert.equal(count.failed, true);
  assert.match(count.checks[0].diagnostic, /array, not a function or declared count/);
  const broken = await service.verify('20 levels', [moduleBinding('broken.cjs')]);
  assert.equal(broken.failed, true);
  assert.match(broken.checks[0].diagnostic, /missing runtime dependency/);
});

test('an infinite procedural module times out instead of hanging the agent', async t => {
  const root = fixture(t, { 'levels.cjs': 'while(true) {}' });
  const started = Date.now();
  const report = await new CollectionAcceptanceService(root, { moduleTimeoutMs: 100 }).verify('20 levels', [moduleBinding()]);
  assert.equal(report.failed, true);
  assert.match(report.checks[0].diagnostic, /timed out after 100 ms/);
  assert.ok(Date.now() - started < 2_000);
});

test('reserved empty slots and runaway console output cannot pass as a complete collection', async t => {
  const root = fixture(t, { 'sparse.cjs': 'module.exports.levels=new Array(20);',
    'noisy.cjs': 'const fs=require("node:fs"); const chunk=Buffer.alloc(8192, "x"); while(true) fs.writeSync(1, chunk);' });
  const service = new CollectionAcceptanceService(root);
  const sparse = await service.verify('20 levels', [moduleBinding('sparse.cjs')]);
  assert.equal(sparse.failed, true);
  assert.match(sparse.checks[0].diagnostic, /reserved array slots are not materialized/);
  const noisy = await service.verify('20 levels', [moduleBinding('noisy.cjs')]);
  assert.equal(noisy.failed, true);
  assert.match(noisy.checks[0].diagnostic, /exceeded its output limit/);
});

test('wrong JSON pointer fails with the actual array pointer needed for repair', async t => {
  const root = fixture(t, { 'levels.json': { levels: Array.from({ length: 20 }, (_, id) => ({ id })) } });
  const service = new CollectionAcceptanceService(root);
  const bindings = [{ label: 'levels', source: { kind: 'json-array', file: 'levels.json', pointer: '' } }];
  const failed = await service.verify('20 levels', bindings);
  assert.equal(failed.failed, true);
  assert.match(failed.checks[0].diagnostic, /JSON Pointer\(s\): \/levels/);
  bindings[0].source.pointer = '/levels';
  assert.equal((await service.verify('20 levels', bindings)).failed, false);
});

test('source paths cannot escape via traversal, absolute paths, or symlinks', async t => {
  const outside = fixture(t, { 'outside.json': Array.from({ length: 20 }, () => ({})) });
  const root = fixture(t);
  fs.symlinkSync(path.join(outside, 'outside.json'), path.join(root, 'linked.json'));
  const service = new CollectionAcceptanceService(root);
  for (const file of [path.join(outside, 'outside.json'), path.relative(root, path.join(outside, 'outside.json')), 'linked.json']) {
    const report = await service.verify('20 levels', [jsonBinding(file)]);
    assert.equal(report.failed, true);
    assert.match(report.checks[0].diagnostic, /relative to the workspace|outside the workspace/);
  }
});

test('bad JSON, malformed manifest, missing source, and metadata counts cannot claim success', async t => {
  const root = fixture(t, { 'levels.json': '[{bad]', 'acceptance.json': { collections: '20 levels passed' }, '.agent-workspace/fake.json': [1, 2] });
  const service = new CollectionAcceptanceService(root);
  assert.equal((await service.verify('20 levels', [jsonBinding()])).failed, true);
  assert.equal((await service.verify('20 levels')).failed, true);
  assert.equal((await service.verify('20 levels', [{ label: 'levels', actualCount: 20 }])).failed, true);
  assert.equal((await service.verify('2 levels', [jsonBinding('.agent-workspace/fake.json')])).failed, true);
});

test('goals without explicit supported counts need no invented acceptance obligation', async t => {
  const root = fixture(t, { 'acceptance.json': 'invalid but irrelevant' });
  const report = await new CollectionAcceptanceService(root).verify('Build a complete browser game.');
  assert.deepEqual(report.checks, []);
  assert.equal(report.failed, false);
  assert.equal(report.unverified, false);
});
