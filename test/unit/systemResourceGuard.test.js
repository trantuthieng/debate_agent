const assert = require('node:assert/strict');
const test = require('node:test');

const { SystemResourceService, estimateModelContextLimit } = require('../../out/services/systemResourceService');

test('context capacity accounts for model weights, attention cache, and real host RAM', () => {
  const modelInfo = {
    'general.architecture': 'mistral3',
    'mistral3.context_length': 393216,
    'mistral3.block_count': 40,
    'mistral3.attention.head_count_kv': 8,
    'mistral3.attention.key_length': 128,
    'mistral3.attention.value_length': 128,
  };
  const constrained = estimateModelContextLimit(gb(24), gb(15), modelInfo);
  const largerHost = estimateModelContextLimit(gb(32), gb(15), modelInfo);
  assert.ok(constrained < 32768, `15 GiB weights need context headroom on 24 GiB: ${constrained}`);
  assert.ok(largerHost >= 32768, `32 GiB can use a full 32K context: ${largerHost}`);
  assert.ok(largerHost > constrained);
  assert.equal(estimateModelContextLimit(gb(64), gb(4), { ...modelInfo, 'mistral3.context_length': 8192 }), 8192);
  assert.equal(estimateModelContextLimit(gb(24), 0, {}), 16384);
});

const baseConfig = { enabled: true, minFreeMemoryPercent: 10, topProcessCount: 5 };

function gb(n) { return n * 1024 * 1024 * 1024; }

function psOutput(rows) {
  const header = '  PID    RSS COMM';
  const lines = rows.map(([pid, rssKb, comm]) => `${pid} ${rssKb} ${comm}`);
  return [header, ...lines].join('\n');
}

test('resource check is always advisory even when disabled', () => {
  const service = new SystemResourceService({ ...baseConfig, enabled: false }, {
    totalMemoryBytes: () => gb(32),
    freeMemoryBytes: () => gb(1),
    platform: () => 'darwin',
    execFile: () => { throw new Error('no sysctl in test'); },
  });
  const result = service.check();
  assert.equal(result.blocked, false);
  assert.match(result.advisory, /System resources before starting/);
});

test('macOS critical memory pressure blocks the run even when raw free% looks fine', () => {
  const service = new SystemResourceService(baseConfig, {
    totalMemoryBytes: () => gb(32),
    freeMemoryBytes: () => gb(16), // 50% "free" by the naive metric — would look safe
    platform: () => 'darwin',
    execFile: (cmd, args) => {
      if (args.includes('kern.memorystatus_vm_pressure_level')) { return '4\n'; }
      if (args[0] === 'vm.swapusage') { return 'vm.swapusage: total = 6144.00M  used = 4546.12M  free = 1597.88M  (encrypted)\n'; }
      return psOutput([]);
    },
  });
  const result = service.check();
  assert.equal(result.blocked, true);
  assert.match(result.reasons[0], /critical memory pressure/i);
  assert.match(result.advisory, /BLOCKED/);
});

test('macOS normal pressure does not block regardless of swap usage', () => {
  const service = new SystemResourceService(baseConfig, {
    totalMemoryBytes: () => gb(32),
    freeMemoryBytes: () => gb(1),
    platform: () => 'darwin',
    execFile: (cmd, args) => {
      if (args.includes('kern.memorystatus_vm_pressure_level')) { return '1\n'; }
      if (args[0] === 'vm.swapusage') { return 'vm.swapusage: total = 6144.00M  used = 4546.12M  free = 1597.88M  (encrypted)\n'; }
      return psOutput([]);
    },
  });
  const result = service.check();
  assert.equal(result.blocked, false, 'normal OS pressure should not block even with high swap and low freemem');
});

test('non-macOS falls back to the free-memory-percent threshold', () => {
  const service = new SystemResourceService(baseConfig, {
    totalMemoryBytes: () => gb(16),
    freeMemoryBytes: () => gb(1), // 6.25% < 10% threshold
    platform: () => 'linux',
    execFile: () => { throw new Error('no ps/sysctl in this fake test env'); },
  });
  const result = service.check();
  assert.equal(result.blocked, true);
  assert.match(result.reasons[0], /Free memory is 6\.3%/);
});

test('non-macOS with healthy free memory is not blocked', () => {
  const service = new SystemResourceService(baseConfig, {
    totalMemoryBytes: () => gb(16),
    freeMemoryBytes: () => gb(8),
    platform: () => 'linux',
    execFile: () => { throw new Error('no ps/sysctl in this fake test env'); },
  });
  const result = service.check();
  assert.equal(result.blocked, false);
});

test('top RAM consumers are aggregated by app and never suggest closing Ollama or the extension host', () => {
  const service = new SystemResourceService(baseConfig, {
    totalMemoryBytes: () => gb(32),
    freeMemoryBytes: () => gb(8),
    platform: () => 'darwin',
    execFile: (cmd, args) => {
      if (args.includes('kern.memorystatus_vm_pressure_level')) { return '1\n'; }
      if (args[0] === 'vm.swapusage') { return 'vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M\n'; }
      return psOutput([
        [100, 800_000, '/Applications/Microsoft Edge.app/Contents/Frameworks/Microsoft Edge Framework.framework/Helpers/Microsoft Edge Helper (Renderer).app/Contents/MacOS/Microsoft Edge Helper (Renderer)'],
        [101, 500_000, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
        [102, 300_000, '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Renderer).app/Contents/MacOS/Code Helper (Renderer)'],
        [103, 900_000, 'ollama'],
        [104, 50_000, '/usr/libexec/some_daemon'],
      ]);
    },
  });
  const result = service.check();
  const names = result.snapshot.topProcesses.map(p => p.name);
  assert.ok(names.includes('Microsoft Edge'), `expected Microsoft Edge in ${JSON.stringify(names)}`);
  assert.ok(!names.some(n => /visual studio code|ollama/i.test(n)), `should exclude the IDE/Ollama: ${JSON.stringify(names)}`);
  const edge = result.snapshot.topProcesses.find(p => p.name === 'Microsoft Edge');
  assert.equal(edge.processCount, 2);
  assert.equal(edge.residentMb, Math.round((800_000 + 500_000) / 1024));
});

test('closableApps picks foreground apps greedily until the gap is closed', () => {
  const service = new SystemResourceService(baseConfig, {
    totalMemoryBytes: () => gb(32),
    platform: () => 'darwin',
    execFile: () => psOutput([
      [100, 4_000_000, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'], // ~3906 MB
      [101, 2_000_000, '/Applications/Calendar.app/Contents/MacOS/Calendar'], // ~1953 MB
      [102, 9_000_000, '/usr/libexec/corespotlightd'], // huge, but not a foreground app
    ]),
    listForegroundApps: () => ['Finder', 'Microsoft Edge', 'Calendar'],
  });
  // 4096 MB free, want 10240 MB free -> 6144 MB gap. Edge alone (~3906) isn't
  // enough, so Calendar (~1953) should also be picked (3906+1953 >= 6144);
  // corespotlightd must never appear even though it's the single biggest process.
  const apps = service.closableApps(4096, 10240);
  assert.deepEqual(apps.map(a => a.name), ['Microsoft Edge', 'Calendar']);
});

test('closableApps returns nothing once the gap is already closed', () => {
  const service = new SystemResourceService(baseConfig, {
    totalMemoryBytes: () => gb(32),
    platform: () => 'darwin',
    execFile: () => psOutput([[100, 4_000_000, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']]),
    listForegroundApps: () => ['Microsoft Edge'],
  });
  assert.deepEqual(service.closableApps(20 * 1024, 20 * 1024), []);
  assert.deepEqual(service.closableApps(21 * 1024, 20 * 1024), []);
});

test('closableApps returns nothing when foreground-app detection is unavailable', () => {
  const service = new SystemResourceService(baseConfig, {
    totalMemoryBytes: () => gb(32),
    platform: () => 'darwin',
    execFile: () => psOutput([[100, 4_000_000, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']]),
    listForegroundApps: () => [],
  });
  assert.deepEqual(service.closableApps(1024, 20 * 1024), []);
});
