#!/usr/bin/env node
'use strict';

// Usage: node tasksCliAcceptance.js WORKSPACE REPORT.json -- EXECUTABLE ARG...
// Example: ... /tmp/generated /tmp/report.json -- node /tmp/generated/bin/tasks.js
// commandArgv is explicit and executed without a shell, with cwd=workspaceRoot.
// Flags are appended as: --data FILE COMMAND ARGS... --json. list may return
// either an array or { tasks: [...] }; each task needs id, title and boolean done.
// Exit 1 = failure, 2 = incomplete verification. T06/T08 are never certified by
// this subset harness, even when every implemented check passes.

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function runTasksCliAcceptance({ workspaceRoot, commandArgv, timeoutMs = 5000 }) {
  if (!Array.isArray(commandArgv) || commandArgv.length === 0 || commandArgv.some(arg => typeof arg !== 'string')) {
    throw new Error('An explicit, nonempty commandArgv array of strings is required.');
  }
  workspaceRoot = path.resolve(workspaceRoot);
  assert.ok(fs.statSync(workspaceRoot).isDirectory(), 'workspaceRoot must be a directory');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-cli-acceptance-'));
  const data = path.join(scratch, 'tasks.json');
  const isolatedData = path.join(scratch, 'isolated.json');
  const evidence = [];
  const checks = [];
  const jsonFailures = [];
  let successfulJsonCommands = 0;

  const invoke = args => {
    const result = cp.spawnSync(commandArgv[0], [...commandArgv.slice(1), ...args], {
      cwd: workspaceRoot, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024,
      shell: false, windowsHide: true,
    });
    const item = {
      args, exitCode: result.status, signal: result.signal,
      stdout: String(result.stdout ?? '').slice(-8000), stderr: String(result.stderr ?? '').slice(-8000),
      error: result.error?.message,
    };
    evidence.push(item);
    assert.ifError(result.error);
    assert.equal(result.signal, null, `CLI terminated by signal: ${result.signal}`);
    return result;
  };
  const json = (file, ...args) => {
    try {
      const result = invoke(['--data', file, ...args, '--json']);
      assert.equal(result.status, 0, `${args[0]} failed: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      successfulJsonCommands++;
      return parsed;
    } catch (error) {
      jsonFailures.push(`${args[0]}: ${error.message}`);
      throw error;
    }
  };
  const list = file => {
    const output = json(file, 'list');
    const tasks = Array.isArray(output) ? output : output?.tasks;
    assert.ok(Array.isArray(tasks), 'list --json must contain a task array');
    for (const task of tasks) {
      assert.ok(task && typeof task === 'object', 'Each task must be an object');
      assert.ok((typeof task.id === 'string' && task.id.trim()) || (typeof task.id === 'number' && Number.isFinite(task.id)), 'Task IDs must be nonempty strings or finite numbers');
      assert.equal(typeof task.title, 'string', 'Task title must be a string');
      assert.equal(typeof task.done, 'boolean', 'Task done must be a boolean');
    }
    assert.equal(new Set(tasks.map(task => String(task.id))).size, tasks.length, 'Task IDs must be distinct when passed back as CLI arguments');
    return tasks.map(({ id, title, done }) => ({ id, title, done }));
  };
  const normalized = tasks => [...tasks].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const check = (id, label, run) => {
    try { run(); checks.push({ id, label, status: 'passed' }); }
    catch (error) { checks.push({ id, label, status: 'failed', diagnostic: error.message }); }
  };
  const unchangedError = (file, args, messagePattern) => {
    const before = fs.readFileSync(file);
    const result = invoke(['--data', file, ...args, '--json']);
    assert.notEqual(result.status, 0, `${args[0]} incorrectly exited zero`);
    assert.match(result.stderr.trim(), messagePattern, `${args[0]} needs useful stderr`);
    assert.deepEqual(fs.readFileSync(file), before, `${args[0]} changed existing data on failure`);
  };

  try {
    check('T01', 'help documents commands and flags; a new store lists no tasks', () => {
      const help = invoke(['--help']);
      assert.equal(help.status, 0, '--help must exit zero');
      const text = `${help.stdout}\n${help.stderr}`;
      for (const command of ['add', 'list', 'done', 'remove']) { assert.match(text, new RegExp(`\\b${command}\\b`, 'i')); }
      for (const flag of ['--data', '--json']) { assert.ok(text.includes(flag), `Help is missing ${flag}`); }
      assert.deepEqual(list(data), []);
    });

    let initial;
    check('T02', 'separate add processes persist Unicode titles with stable distinct IDs', () => {
      json(data, 'add', 'Buy milk');
      json(data, 'add', 'Đọc sách 📚');
      initial = list(data);
      assert.equal(initial.length, 2, 'Exactly both added tasks must survive');
      assert.deepEqual(initial.map(task => task.title).sort(), ['Buy milk', 'Đọc sách 📚'].sort());
      assert.ok(initial.every(task => task.done === false), 'New tasks must be not done');
      assert.deepEqual(normalized(list(data)), normalized(initial), 'A separate list process must preserve IDs and values');
    });

    let afterDone;
    check('T03', 'done persists only the selected flag and is idempotent', () => {
      assert.ok(initial?.length === 2, 'T02 must supply two persisted tasks');
      const target = initial.find(task => task.title === 'Buy milk');
      json(data, 'done', String(target.id));
      afterDone = initial.map(task => ({ ...task, done: task.id === target.id ? true : task.done }));
      assert.deepEqual(normalized(list(data)), normalized(afterDone));
      json(data, 'done', String(target.id));
      assert.deepEqual(normalized(list(data)), normalized(afterDone), 'Repeating done must leave the same persisted state');
    });

    check('T04', 'remove affects only its target; separate data files are isolated', () => {
      assert.ok(afterDone?.length === 2, 'T03 must supply the completed task');
      const target = afterDone.find(task => task.title === 'Buy milk');
      const remaining = afterDone.filter(task => task.id !== target.id);
      json(data, 'remove', String(target.id));
      assert.deepEqual(list(data), remaining);
      assert.deepEqual(list(isolatedData), [], 'A different --data file must start empty');
      json(isolatedData, 'add', 'Independent store');
      const separate = list(isolatedData);
      assert.equal(separate.length, 1);
      assert.equal(separate[0].title, 'Independent store');
      assert.equal(separate[0].done, false);
      assert.deepEqual(list(data), remaining, 'Writing the second store must not modify the first');
    });

    check('T05', 'invalid input fails usefully without changing existing bytes', () => {
      unchangedError(data, ['add', '   '], /title|blank|empty|required/i);
      unchangedError(data, ['done', '__missing_task__'], /task|id|not found|unknown/i);
      unchangedError(data, ['remove', '__missing_task__'], /task|id|not found|unknown/i);
      unchangedError(data, ['__unknown_command__'], /command|unknown|usage/i);
      const malformed = path.join(scratch, 'malformed.json');
      fs.writeFileSync(malformed, '{"tasks": [truncated');
      unchangedError(malformed, ['list'], /json|data|corrupt|pars|invalid/i);
      unchangedError(malformed, ['add', 'Must not overwrite corruption'], /json|data|corrupt|pars|invalid/i);
    });

    check('T06', 'partial: invalid destination fails; successful stores contain complete JSON', () => {
      JSON.parse(fs.readFileSync(data, 'utf8'));
      JSON.parse(fs.readFileSync(isolatedData, 'utf8'));
      const parentFile = path.join(scratch, 'not-a-directory');
      fs.writeFileSync(parentFile, 'preserve me');
      const result = invoke(['--data', path.join(parentFile, 'tasks.json'), 'add', 'Cannot save', '--json']);
      assert.notEqual(result.status, 0, 'An invalid data destination must fail');
      assert.match(result.stderr, /directory|ENOTDIR|path|write|save|data|file/i);
      assert.equal(fs.readFileSync(parentFile, 'utf8'), 'preserve me');
    });
    check('T07', 'successful add/list/done/remove --json outputs are JSON without progress text', () => {
      assert.equal(jsonFailures.length, 0, jsonFailures.join('\n'));
      assert.ok(successfulJsonCommands >= 15, 'All success command paths must actually be exercised');
    });

    const requirements = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08'].map(id => {
      const result = checks.find(item => item.id === id);
      if (result?.status === 'failed') { return { id, status: 'failed', diagnostic: result.diagnostic }; }
      if (id === 'T06') { return { id, status: 'unverified', diagnostic: 'Invalid destination and complete JSON checked; unwritable permissions and injected pre-replacement failure/atomicity were not tested.' }; }
      if (id === 'T08') { return { id, status: 'unverified', diagnostic: 'No clean-copy installation, README command validation, or inspection of the generated project\'s subprocess tests was performed.' }; }
      return { id, status: result?.status ?? 'unverified' };
    });
    const failed = requirements.some(item => item.status === 'failed');
    return {
      goal: { id: 'tasks-cli', version: 1 }, workspaceRoot, commandArgv,
      passed: false, status: failed ? 'failed' : 'unverified',
      subsetPassed: !failed, requirements, checks, evidence,
      unverifiedRequirements: requirements.filter(item => item.status === 'unverified').map(item => item.id),
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { runTasksCliAcceptance };

if (require.main === module) {
  const [workspaceRoot, reportFile, separator, ...commandArgv] = process.argv.slice(2);
  try {
    if (!workspaceRoot || !reportFile || separator !== '--') {
      throw new Error('Usage: node tasksCliAcceptance.js WORKSPACE REPORT.json -- EXECUTABLE ARG...');
    }
    const report = runTasksCliAcceptance({ workspaceRoot, commandArgv });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`tasks-cli: ${report.status}; subset ${report.subsetPassed ? 'passed' : 'failed'}; unverified: ${report.unverifiedRequirements.join(', ')}\n`);
    process.exitCode = report.status === 'failed' ? 1 : 2;
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
