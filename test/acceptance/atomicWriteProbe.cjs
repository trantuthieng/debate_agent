// Test-only Node preload: fail replacement of exactly the disposable data file.
// It never changes application source or intercepts unrelated filesystem paths.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const target = process.env.MCORE_ATOMIC_TARGET;
const trace = process.env.MCORE_ATOMIC_TRACE;
const append = fs.appendFileSync.bind(fs);
const matches = value => {
  if (typeof value === 'number') return false;
  try { return path.resolve(value instanceof URL ? fileURLToPath(value) : String(value)) === target; }
  catch { return false; }
};
const record = operation => append(trace, JSON.stringify({ operation }) + '\n');
const fault = () => Object.assign(new Error('Injected pre-replacement failure'), { code: 'EACCES' });
if (!target || !trace) throw new Error('Atomic probe requires a disposable target and trace');
const renameSync = fs.renameSync.bind(fs);
fs.renameSync = (from, to) => {
  if (matches(to)) { record('rename-fault'); throw fault(); }
  return renameSync(from, to);
};
const rename = fs.rename.bind(fs);
fs.rename = (from, to, callback) => {
  if (matches(to)) { record('rename-fault'); queueMicrotask(() => callback(fault())); return; }
  return rename(from, to, callback);
};
const renameAsync = fs.promises.rename.bind(fs.promises);
fs.promises.rename = async (from, to) => {
  if (matches(to)) { record('rename-fault'); throw fault(); }
  return renameAsync(from, to);
};
for (const name of ['writeFileSync', 'appendFileSync', 'truncateSync', 'unlinkSync']) {
  const original = fs[name].bind(fs);
  fs[name] = (file, ...args) => {
    if (matches(file)) record(`direct-${name}`);
    return original(file, ...args);
  };
}
syncBuiltinESMExports();
