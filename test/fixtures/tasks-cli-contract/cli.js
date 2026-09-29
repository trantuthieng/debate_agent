#!/usr/bin/env node
// A tiny local contract fixture, with deliberate regressions for harness tests.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
let mode = 'working';
if (args[0] === '--fixture-mode') { args.shift(); mode = args.shift(); }
if (args.includes('--help')) {
  console.log('tasks: add <title>, list, done <id>, remove <id>; --data <file>, --json, --help');
  process.exit(0);
}
const dataIndex = args.indexOf('--data');
let file = dataIndex < 0 ? path.join(process.cwd(), 'tasks.json') : args[dataIndex + 1];
if (dataIndex >= 0) { args.splice(dataIndex, 2); }
const jsonIndex = args.indexOf('--json');
if (jsonIndex >= 0) { args.splice(jsonIndex, 1); }
if (mode === 'isolation') { file = path.join(process.cwd(), '.shared-fixture-data.json'); }
const [command, value] = args;
let tasks = [];
try {
  try { tasks = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') {
      if (mode !== 'malformed-overwrite') { throw new Error(`Invalid data: ${error.message}`); }
    }
  }
  if (!Array.isArray(tasks)) { throw new Error('Invalid data: expected a task array'); }
  let output;
  let changed = true;
  if (command === 'list') { output = tasks; changed = false; }
  else if (command === 'add') {
    if (!value || !value.trim()) { throw new Error('A nonblank title is required'); }
    output = { id: crypto.randomUUID(), title: value, done: false };
    tasks.push(output);
  } else if (command === 'done' || command === 'remove') {
    const index = tasks.findIndex(task => String(task.id) === value);
    if (index < 0) { throw new Error(`Unknown task ID: ${value}`); }
    if (command === 'done') {
      if (mode === 'done-all') { tasks.forEach(task => { task.done = true; }); }
      else { tasks[index].done = true; }
      output = tasks[index];
    } else {
      output = tasks[index];
      if (mode === 'remove-all') { tasks = []; }
      else { tasks.splice(index, 1); }
    }
  } else { throw new Error(`Unknown command: ${command}`); }
  if (changed && mode !== 'persistence') {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(tasks));
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* moved or never created */ }
    }
  }
  if (mode === 'json-noise') { process.stdout.write('Working...\n'); }
  console.log(JSON.stringify(output));
} catch (error) {
  if (mode === 'corrupt-on-error') {
    try { fs.writeFileSync(file, '[]'); } catch { /* invalid destination */ }
  }
  console.error(error.message);
  process.exitCode = mode === 'error-code' ? 0 : 1;
}
