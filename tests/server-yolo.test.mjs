import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { hostOverlay, parseServerArgs } from '../scripts/host.mjs';
import { servicePlan, serviceDefinition } from '../scripts/server-service.mjs';
import { BrowserAccess } from '../plugins/browser/access.mjs';
import { formatStatus } from '../plugins/browser/presentation.mjs';

const temp = t => {
  const dir = mkdtempSync(join(tmpdir(), 'dscode-yolo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('YOLO is an explicit server option and survives service-manager restart arguments', t => {
  const home = temp(t);
  const options = parseServerArgs(['--port', '8080', '--bind', '127.0.0.1', '--yolo']);
  assert.equal(options.yolo, true);
  assert.equal(parseServerArgs(['--port', '8080']).yolo, undefined);
  for (const platform of ['darwin', 'linux']) {
    const plan = servicePlan(options, { home, platform, userHome: home, env: { PATH: '/bin' } });
    assert.equal(plan.yolo, true);
    assert(plan.command.includes('--yolo'));
    assert.match(serviceDefinition(plan), /--yolo/);
  }
  assert.throws(() => hostOverlay(home, 0, { yolo: true }), /explicit server/);
  const tcp = { port: 8080, bind: '127.0.0.1', tokenFile: join(home, 'token') };
  const enabled = parse(readFileSync(hostOverlay(home, 0, { tcp, yolo: true }), 'utf8'));
  assert.equal(enabled.find(row => row.id === 'dscode-auto-review').disabled, true);
  assert.equal(enabled.find(row => row.id === 'dscode-computer-use').config.allowAllApps, true);
  assert(enabled.flatMap(row => row.insert ?? []).some(row => row.id === 'dscode-server-yolo'));
  const normal = readFileSync(hostOverlay(home, 0, { tcp }), 'utf8');
  assert(!normal.includes('dscode-server-yolo'));
  assert(!normal.includes('yolo: true'));
  assert(!normal.includes('allowAllApps'));
});

test('YOLO browser grants are temporary, retain target validation, and restore existing denials', async t => {
  const home = temp(t), normal = new BrowserAccess(home), yolo = new BrowserAccess(home, { yolo: true });
  await normal.update('block', 'https://blocked.example');
  const before = readFileSync(join(home, 'permissions.json'), 'utf8');
  for (const url of ['https://blocked.example/a', 'http://unknown.example:8080/b']) {
    await yolo.checkUrl(url, true);
    await assert.rejects(normal.checkUrl(url, true), /blocked|permission/);
  }
  await assert.rejects(yolo.checkUrl('file:///etc/passwd'), /HTTP/);
  await assert.rejects(yolo.check('click', {}, []), /explicit live pageId/);
  await assert.rejects(yolo.check('click', { pageId: 9 }, []), /unavailable/);
  await assert.rejects(yolo.update('block', 'https://new.example'), /Server YOLO/);
  const status = await yolo.status();
  assert.equal(status.yolo, true); assert.equal(status.developerMode, true);
  assert.match(formatStatus({ permissions: status }), /Stored sites \(inactive\)/);
  assert.equal(readFileSync(join(home, 'permissions.json'), 'utf8'), before);
  await assert.rejects(new BrowserAccess(home).checkUrl('https://blocked.example'), /blocked/);
});
