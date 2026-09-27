import { LOGS, PROJECT, put, readJsonl, startServer } from './helpers.mjs';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const PORT = 4890 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let key;

put(PROJECT, 'TASKS.md', '| ID | Milestone | Owner | Status |\n|---|---|---|---|\n| M0-001 | M0 | a | blocked |\n');
put(PROJECT, 'CLAUDE.md', '- **Open questions for the user:**\n  - **Q1:** pick one.\n');
put(LOGS, 'activity.jsonl', `${JSON.stringify({ ts: new Date().toISOString(), event: 'tool', agent_id: 'ag1', agent_type: 'planner', tool: 'Read', subject: 'x' })}\n`);

// Plain http.request, so the Host and Origin headers are ours to set.
function call(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${BASE}${path}`, { method, headers }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const withKey = (extra = {}) => ({ 'X-Monitor-Key': key, ...extra });
const change = (path, value) =>
  call(path, { method: 'POST', headers: withKey({ Origin: BASE, 'Content-Type': 'application/json' }), body: JSON.stringify(value) });

before(async () => {
  server = await startServer(PORT);
  const page = await call('/');
  key = page.text.match(/name="monitor-key" content="([^"]+)"/)[1];
  assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'nonce-/);
});
after(() => server.kill());

test('only our own address, only with the key, changes only from the page', async () => {
  assert.equal((await call('/', { headers: { Host: `evil.test:${PORT}` } })).status, 403);
  assert.equal((await call('/api/state')).status, 403);
  assert.equal((await call('/api/state', { headers: withKey() })).status, 200);
  const noOrigin = await call('/api/answer', { method: 'POST', headers: withKey({ 'Content-Type': 'application/json' }), body: '{}' });
  assert.equal(noOrigin.status, 403);
  const big = await change('/api/note', { agentId: 'ag1', text: 'x'.repeat(40_000) });
  assert.equal(big.status, 413);
});

test('the live stream takes a ticket that works once', async () => {
  const { ticket } = JSON.parse((await call('/api/ticket', { method: 'POST', headers: withKey() })).text);
  const first = await new Promise((resolve) => {
    const req = request(`${BASE}/api/events?ticket=${ticket}`, (res) => {
      let text = '';
      res.on('data', (d) => {
        text += d;
        if (text.includes('event: tokens')) {
          req.destroy();
          resolve({ status: res.statusCode, text });
        }
      });
    });
    req.end();
  });
  assert.equal(first.status, 200);
  assert.match(first.text, /event: state\ndata: \{/);
  assert.equal((await call(`/api/events?ticket=${ticket}`)).status, 403);
});

test('the state has the board, questions (blocked tasks too) and agents', async () => {
  const s = JSON.parse((await call('/api/state', { headers: withKey() })).text);
  assert.deepEqual(s.questions.map((q) => [q.id, q.kind]), [['Q1', 'question'], ['M0-001', 'blocked task']]);
  assert.deepEqual(s.agents.map((a) => a.id), ['ag1']);
  assert.equal(s.milestones[0].blocked, 1);
});

test('one note to several agents, each with its own result; answers are queued', async () => {
  const res = JSON.parse((await change('/api/note', { agentIds: ['ag1', 'nobody'], text: 'hello' })).text);
  assert.deepEqual(res.results.map((r) => r.ok), [true, false]);
  const queued = readJsonl(join(LOGS, 'notes.jsonl'));
  assert.equal(queued.length, 1);
  assert.ok(queued[0].group_id);
  assert.equal((await change('/api/answer', { itemId: 'Q1', itemText: 'pick one.', text: 'Option (a).' })).status, 200);
  assert.deepEqual(readJsonl(join(LOGS, 'inbox', 'main-session.jsonl')).map((a) => [a.itemId, a.text]), [['Q1', 'Option (a).']]);
});

test('search filters the logs, newest first', async () => {
  const r = JSON.parse((await call('/api/search?log=activity&q=read', { headers: withKey() })).text);
  assert.deepEqual(r.entries.map((e) => e.agent_id), ['ag1']);
  const none = JSON.parse((await call('/api/search?log=activity&q=zzz', { headers: withKey() })).text);
  assert.equal(none.entries.length, 0);
});
