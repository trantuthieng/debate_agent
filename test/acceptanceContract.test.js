const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const { BrowserSmokeService } = require('../out/services/browserSmokeService');
const { parseAcceptanceContract, describeAcceptanceContract, acceptanceContractInteraction } = require('../out/services/acceptanceContract');

// A small notes journey: add, persist across reload, cancel then confirm delete.
const notesContract = {
  applicable: true,
  steps: [
    { do: 'expect', label: 'the empty state is shown', expression: "document.querySelector('#empty') && !document.querySelector('#empty').hidden" },
    { do: 'type', selector: '#title', text: 'Groceries <b>' },
    { do: 'click', selector: '#add' },
    { do: 'expect', label: 'the new note is listed as text', expression: "[...document.querySelectorAll('.note')].some(n => n.querySelector('span').textContent === 'Groceries <b>')" },
    { do: 'remember', name: 'count', expression: "document.querySelectorAll('.note').length" },
    { do: 'reload' },
    { do: 'expect', label: 'notes persist across reload', expression: "document.querySelectorAll('.note').length === memo.count" },
    { do: 'dialog', accept: false },
    { do: 'click', selector: '.note .delete' },
    { do: 'expect', label: 'cancelled delete keeps the note', expression: "document.querySelectorAll('.note').length === memo.count" },
    { do: 'dialog', accept: true },
    { do: 'click', selector: '.note .delete' },
    { do: 'expect', label: 'confirmed delete removes the note', expression: "document.querySelectorAll('.note').length === memo.count - 1" },
  ],
};

const notesPage = ({ persist = true } = {}) => `<!doctype html><html><body>
<input id="title"><button id="add">Add</button><p id="empty">No notes yet</p><ul id="list"></ul>
<script>
  let notes = JSON.parse(localStorage.getItem('notes') || '[]');
  const render = () => {
    document.querySelector('#empty').hidden = notes.length > 0;
    const list = document.querySelector('#list');
    list.replaceChildren(...notes.map((title, i) => {
      const li = document.createElement('li'); li.className = 'note';
      const span = document.createElement('span'); span.textContent = title;
      const del = document.createElement('button'); del.className = 'delete'; del.textContent = 'x';
      del.onclick = () => { if (confirm('Delete?')) { notes.splice(i, 1); save(); } };
      li.append(span, del);
      return li;
    }));
  };
  const save = () => { ${persist ? "localStorage.setItem('notes', JSON.stringify(notes));" : ''} render(); };
  document.querySelector('#add').onclick = () => { const t = document.querySelector('#title').value; if (t.trim()) { notes.push(t); save(); } };
  render();
</script></body></html>`;

test('acceptance contract parser accepts a behavioural walk-through', () => {
  const { contract, errors } = parseAcceptanceContract(notesContract);
  assert.deepEqual(errors, []);
  assert.equal(contract.steps.length, notesContract.steps.length);
  const lines = describeAcceptanceContract(contract);
  assert.match(lines[1], /^2\. type "Groceries <b>" into #title$/);
  assert.match(lines[3], /EXPECT the new note is listed as text/);
});

test('acceptance contract parser accepts a reasoned non-browser verdict and rejects a bare one', () => {
  assert.equal(parseAcceptanceContract({ applicable: false, reason: 'CLI tool' }).contract.applicable, false);
  assert.match(parseAcceptanceContract({ applicable: false }).errors[0], /reason/);
});

test('acceptance contract parser rejects contracts that cannot show behaviour', () => {
  const loadOnly = { applicable: true, steps: [
    { do: 'expect', label: 'a', expression: 'true' },
    { do: 'expect', label: 'b', expression: 'true' },
    { do: 'expect', label: 'c', expression: 'true' },
  ] };
  assert.ok(parseAcceptanceContract(loadOnly).errors.some(e => /follow a user input/.test(e)));
  const tooFew = { applicable: true, steps: [{ do: 'press', key: 'Enter' }, { do: 'expect', label: 'a', expression: 'true' }] };
  assert.ok(parseAcceptanceContract(tooFew).errors.some(e => /At least 3/.test(e)));
});

test('acceptance contract parser reports each malformed step', () => {
  const { contract, errors } = parseAcceptanceContract({ applicable: true, steps: [
    { do: 'press', key: 'Enter' },
    { do: 'expect', label: 'syntax', expression: 'document.querySelector(' },
    { do: 'expect', label: 'memo', expression: 'memo.later > 0' },
    { do: 'click' },
    { do: 'eval', code: 'process.exit()' },
    { do: 'wait', ms: 60_000 },
  ] });
  assert.equal(contract, undefined);
  assert.ok(errors.some(e => /Step 2: "expression" is not a valid JavaScript expression/.test(e)), errors.join('\n'));
  assert.ok(errors.some(e => /Step 3: memo\.later is used before/.test(e)));
  assert.ok(errors.some(e => /Step 4: a click needs/.test(e)));
  assert.ok(errors.some(e => /Step 5: unknown "do" value "eval"/.test(e)));
  assert.ok(errors.some(e => /Step 6: "ms" must be a number from 0 to 10000/.test(e)));
});

async function replay(t, html) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-contract-'));
  const service = new BrowserSmokeService(root);
  if (!service._browserExecutable()) { fs.rmSync(root, { recursive: true }); t.skip('No supported browser'); return undefined; }
  const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { contract } = parseAcceptanceContract(notesContract);
  return service.verify(`http://127.0.0.1:${server.address().port}`, acceptanceContractInteraction(contract));
}

test('a locked contract passes a product that implements the journey', async t => {
  const result = await replay(t, notesPage());
  if (!result) { return; }
  assert.equal(result.success, true, result.stderr);
  const checks = JSON.parse(result.stdout).interaction;
  assert.equal(checks.length, 5);
  assert.ok(checks.every(check => check.passed));
});

test('a locked contract fails a product that forgets to persist, naming the first broken expectation', async t => {
  const result = await replay(t, notesPage({ persist: false }));
  if (!result) { return; }
  assert.equal(result.success, false);
  assert.match(result.stderr, /Acceptance failed: notes persist across reload — step 7/);
  assert.match(result.stderr, /2 later expectation\(s\) not reached/);
});
