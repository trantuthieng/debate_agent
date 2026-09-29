const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const { BrowserSmokeService } = require('../out/services/browserSmokeService');

test('browser driver sends trusted keyboard events and executes normal text input actions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-browser-input-'));
  const service = new BrowserSmokeService(root);
  if (!service._browserExecutable()) { fs.rmSync(root, { recursive: true }); t.skip('No supported browser'); return; }
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<html><body><input autofocus><p>Keyboard acceptance</p><script>window.events=[];window.addEventListener("keydown",e=>events.push({key:e.key,trusted:e.isTrusted}));</script></body></html>');
  });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = await service.verify(`http://127.0.0.1:${server.address().port}`, async page => {
    await page.press('Enter');
    await page.press('ArrowLeft', 400);
    await page.press('a');
    const events = await page.evaluate('window.events');
    const value = await page.evaluate('document.querySelector("input").value');
    return [
      { label: 'Trusted keyboard events', passed: events.length === 3 && events.every(event => event.trusted), detail: JSON.stringify(events) },
      { label: 'Native text input default action', passed: value === 'a', detail: value },
    ];
  });
  assert.equal(result.success, true, result.stderr);
});
