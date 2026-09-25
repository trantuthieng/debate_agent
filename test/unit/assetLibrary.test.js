const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AssetLibraryService } = require('../../out/services/assetLibraryService');
const { AutonomousToolRegistry } = require('../../out/tools/AutonomousToolRegistry');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-assets-'));
}

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() };
}

function imageResponse(bytes, contentType = 'image/png', ok = true, status = 200) {
  const headers = new Map([['content-type', contentType]]);
  return {
    ok, status,
    headers: { get: key => headers.get(key.toLowerCase()) ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const baseConfig = { enabled: true, maxResults: 8, maxBytes: 5_000_000, allowedLicenses: ['cc0', 'by'] };

test('asset search is a no-op when the config is disabled', async () => {
  const service = new AssetLibraryService(tempDir(), { ...baseConfig, enabled: false }, async () => { throw new Error('should not call network'); });
  const outcome = await service.searchImages('robot character');
  assert.deepEqual(outcome.hits, []);
  assert.match(outcome.warnings[0], /disabled/i);
});

test('asset search returns license-filtered hits from Openverse', async () => {
  const request = async () => jsonResponse({
    results: [
      { id: '1', title: 'Robot sprite', url: 'https://example.com/robot.png', license: 'cc0', creator: 'Ada' },
      { id: '2', title: 'Copyrighted art', url: 'https://example.com/nope.png', license: 'nc', creator: 'Bob' },
    ],
  });
  const service = new AssetLibraryService(tempDir(), baseConfig, request);
  const outcome = await service.searchImages('robot character');
  assert.equal(outcome.hits.length, 1);
  assert.equal(outcome.hits[0].id, '1');
  assert.equal(outcome.hits[0].license, 'cc0');
});

test('asset search reports a warning instead of throwing on HTTP failure', async () => {
  const request = async () => jsonResponse({}, false, 503);
  const service = new AssetLibraryService(tempDir(), baseConfig, request);
  const outcome = await service.searchImages('robot character');
  assert.deepEqual(outcome.hits, []);
  assert.match(outcome.warnings[0], /503/);
});

test('fetchImage downloads, caps size, and records attribution', async () => {
  const root = tempDir();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const request = async () => imageResponse(bytes);
  const service = new AssetLibraryService(root, baseConfig, request);
  const result = await service.fetchImage('https://example.com/robot.png', 'assets/robot.png', {
    title: 'Robot sprite', creator: 'Ada', license: 'cc0', licenseVersion: '1.0',
    source: 'openverse', foreignLandingUrl: 'https://example.com/page',
  });
  assert.equal(result.success, true);
  assert.equal(result.bytes, bytes.length);
  assert.ok(fs.existsSync(path.join(root, 'assets', 'robot.png')));
  const manifest = fs.readFileSync(path.join(root, 'ASSET_LICENSES.md'), 'utf8');
  assert.match(manifest, /assets\/robot\.png/);
  assert.match(manifest, /Ada/);
  assert.match(manifest, /cc0/);
});

test('fetchImage rejects a destination outside the workspace', async () => {
  const service = new AssetLibraryService(tempDir(), baseConfig, async () => { throw new Error('should not call network'); });
  const result = await service.fetchImage('https://example.com/robot.png', '../outside.png', {
    title: 't', creator: 'c', license: 'cc0', licenseVersion: '', source: '', foreignLandingUrl: '',
  });
  assert.equal(result.success, false);
  assert.match(result.error, /workspace/i);
});

test('fetchImage rejects a non-image content-type', async () => {
  const request = async () => imageResponse(Buffer.from('not an image'), 'text/html');
  const service = new AssetLibraryService(tempDir(), baseConfig, request);
  const result = await service.fetchImage('https://example.com/robot.png', 'assets/robot.png', {
    title: 't', creator: 'c', license: 'cc0', licenseVersion: '', source: '', foreignLandingUrl: '',
  });
  assert.equal(result.success, false);
  assert.match(result.error, /content-type/i);
});

test('autonomous tool registry hides image-asset tools when the library is disabled', () => {
  const service = new AssetLibraryService(tempDir(), { ...baseConfig, enabled: false });
  const registry = new AutonomousToolRegistry(null, null, null, null, null, undefined, undefined, undefined, service);
  assert.equal(registry.definitions().some(tool => tool.name === 'search_image_assets'), false);
});

test('autonomous tool registry exposes and executes image-asset tools when enabled', async () => {
  const root = tempDir();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const request = async url => (String(url).includes('openverse')
    ? jsonResponse({ results: [{ id: '1', title: 'Robot', url: 'https://example.com/robot.png', license: 'cc0', creator: 'Ada' }] })
    : imageResponse(bytes));
  const service = new AssetLibraryService(root, baseConfig, request);
  const registry = new AutonomousToolRegistry(null, null, null, null, null, undefined, undefined, undefined, service);
  assert.ok(registry.definitions().some(tool => tool.name === 'search_image_assets'));

  const searched = await registry.execute({ id: 'a', name: 'search_image_assets', args: { query: 'robot character' } });
  assert.equal(searched.success, true);
  assert.match(searched.output, /robot\.png/);

  const fetched = await registry.execute({
    id: 'b', name: 'fetch_image_asset',
    args: { imageUrl: 'https://example.com/robot.png', destPath: 'assets/robot.png', title: 'Robot', creator: 'Ada', license: 'cc0' },
  });
  assert.equal(fetched.success, true);
  assert.ok(fs.existsSync(path.join(root, 'assets', 'robot.png')));
});

test('fetchImage rejects a file over the configured byte cap', async () => {
  const bytes = Buffer.alloc(10);
  const request = async () => imageResponse(bytes);
  const service = new AssetLibraryService(tempDir(), { ...baseConfig, maxBytes: 5 }, request);
  const result = await service.fetchImage('https://example.com/robot.png', 'assets/robot.png', {
    title: 't', creator: 'c', license: 'cc0', licenseVersion: '', source: '', foreignLandingUrl: '',
  });
  assert.equal(result.success, false);
  assert.match(result.error, /exceeds/i);
});
