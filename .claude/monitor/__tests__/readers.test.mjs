import { LOGS, ROOT, TRANSCRIPTS, jsonl, put } from './helpers.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { milestonesOf, parseBoard, parseOpenQuestions } from '../lib/board.mjs';
import { DEFAULT_CONFIG, follow, loadConfig, redact } from '../lib/core.mjs';
import { checkContainers, checkHttp, checkPort } from '../lib/health.mjs';
import { createTokenStore, identify, totalOf } from '../lib/tokens.mjs';
import { conversation, projectKey, taskIdFromTranscript } from '../lib/transcripts.mjs';

test('the config falls back to defaults, merges nested sections and reports broken JSON', () => {
  assert.equal(loadConfig(join(ROOT, 'missing.json')), DEFAULT_CONFIG);
  const partial = put(ROOT, 'partial.json', JSON.stringify({ health: { ports: [{ port: 1 }] }, milestones: ['A'] }));
  const c = loadConfig(partial);
  assert.deepEqual([c.health.ports, c.health.intervalSeconds, c.milestones, c.launch.maxConcurrent], [[{ port: 1 }], 15, ['A'], 2]);
  assert.equal(loadConfig(put(ROOT, 'broken.json', '{ nope')), DEFAULT_CONFIG);
});

test('secrets are hidden before anything is shown', () => {
  // Fake secrets, assembled at run time so this source never holds one.
  const key = ['AKIA', 'Z7Q3XJ2L', 'KM4NP8R5'].join('');
  const url = ['postgres://app', 'hunter2secret@db'].join(':');
  const assignment = ['pass', 'word="', 'Sup3rS3cretValue', '"'].join('');
  const out = redact(`key ${key} and ${url} and ${assignment}`);
  assert.ok(!out.includes(key) && !out.includes('hunter2secret') && !out.includes('Sup3rS3cretValue'), out);
});

test('follow reads only what was added, and starts over when a file is replaced', () => {
  const file = join(ROOT, 'f.jsonl');
  writeFileSync(file, jsonl([{ n: 1 }]));
  const seen = [];
  const read = follow(file, (e) => seen.push(e.n), () => seen.push('reset'));
  read();
  appendFileSync(file, '{"n":2}\n{"n":');
  read();
  appendFileSync(file, '3}\n');
  read();
  assert.deepEqual(seen, ['reset', 1, 2, 3]);
  writeFileSync(file, jsonl([{ n: 9 }]));
  read();
  assert.deepEqual(seen.slice(-2), ['reset', 9]);
});

test('the board: configured columns, milestones in order', () => {
  const text = '# Board\n\n| ID | Milestone | Owner | Status | Notes |\n|---|---|---|---|---|\n| **M0-001** | M0 | a | Done | x \\| y |\n| S1-001 | S1 | b | in progress | |\n| X-1 | X | c | blocked | |\n\nafter\n';
  const { tasks, columns } = parseBoard(text, { id: 'id', milestone: 'milestone', status: 'status', notes: 'blockedNotes' });
  assert.deepEqual(tasks.map((t) => [t.id, t.status]), [['M0-001', 'done'], ['S1-001', 'in progress'], ['X-1', 'blocked']]);
  assert.equal(tasks[0].blockedNotes, 'x | y');
  assert.deepEqual(columns.map((c) => c.key), ['id', 'milestone', 'status', 'blockedNotes']);
  assert.deepEqual(milestonesOf(tasks, ['M0', 'S1', 'S2']).map((m) => [m.id, m.total, m.done]), [['M0', 1, 1], ['S1', 1, 0], ['S2', 0, 0], ['X', 1, 0]]);
});

test('open questions: bold-ID bullets under the heading, until the section ends', () => {
  const md = '- **Blocked:** M0-003\n- **Open questions for the user:**\n  - **Q33:** the dev switch\n    can\'t publish.\n  - **Q34:** pgvector needs a superuser.\n- **Environment as left:**\n  - **Docker:** running\n';
  assert.deepEqual(parseOpenQuestions(md, 'Open questions for the user'), [{ id: 'Q33', text: "the dev switch can't publish." }, { id: 'Q34', text: 'pgvector needs a superuser.' }]);
  assert.deepEqual(parseOpenQuestions(md, 'Nope'), []);
});

// A transcript line for one content block of an assistant reply.
const reply = (id, usage, content, ts = new Date().toISOString()) => ({ type: 'assistant', timestamp: ts, message: { id, usage, content } });
const U = (i, o) => ({ input_tokens: i, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: o });

test('tokens: each reply counted once, per agent, task and day; saved and read back', () => {
  const folder = join(TRANSCRIPTS, projectKey('/p'));
  const file = put(folder, 'sess-a/subagents/workflows/wf_1/agent-a1.jsonl', jsonl([
    { type: 'user', message: { content: 'Task: M0-002\nBuild it.' } },
    reply('m1', U(1, 5), [{ type: 'thinking' }]),
    reply('m1', U(1, 5), [{ type: 'tool_use', name: 'Bash' }]),
    reply('m2', U(2, 7), [{ type: 'text', text: 'done' }]),
  ]));
  put(folder, 'sess-a/subagents/workflows/wf_1/agent-a1.meta.json', JSON.stringify({ agentType: 'builder-platform' }));
  const store = createTokenStore({ folders: () => [folder] });
  store.scan();
  const s = store.summary(() => 'M0');
  const a1 = s.byAgent.find((r) => r.agentId === 'a1');
  assert.deepEqual([a1.agentType, a1.taskId, a1.totals], ['builder-platform', 'M0-002', { input: 3, cacheWrite: 20, cacheRead: 200, output: 12 }]);
  assert.equal(totalOf(s.today), 235);
  assert.deepEqual(s.byMilestone.map((m) => [m.key, totalOf(m.totals)]), [['M0', 235]]);
  // A reply split across a save and a restart is still counted once.
  appendFileSync(file, jsonl([reply('m2', U(2, 7), [{ type: 'tool_use', name: 'Read' }]), reply('m3', U(1, 1), [])]));
  store.save();
  const again = createTokenStore({ folders: () => [folder] });
  again.scan();
  assert.equal(totalOf(again.summary().all), 235 + 112);
  assert.equal(again.fileOf('a1'), file);
});

test('tokens: who a transcript belongs to', () => {
  const sid = '11111111-2222-3333-4444-555555555555';
  assert.deepEqual(identify(join('/x/-p', `${sid}.jsonl`), '/x/-p'), { agentId: `main-${sid}`, agentType: 'main', kind: 'main', sessionId: sid });
  assert.equal(identify(join('/x/-p--claude-worktrees-run-1', `${sid}.jsonl`), '/x/-p--claude-worktrees-run-1').agentId, `run-${sid}`);
  assert.equal(identify('/x/-p/tool-results/a.jsonl', '/x/-p'), null);
});

test('a conversation: what was said, one line per tool, the hand-off, secrets hidden', () => {
  const file = put(ROOT, 'conv.jsonl', jsonl([
    { type: 'user', timestamp: 't0', message: { content: 'Task: S1-001\nDo it. token=abcdef1234567890xyz' } },
    reply('r1', U(1, 1), [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'List' } }]),
    reply('r1', U(1, 1), [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'List' } }]),
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'boom' }] } },
    { type: 'user', message: { content: '<system-reminder>ignore</system-reminder>' } },
    reply('r2', U(1, 1), [{ type: 'tool_use', name: 'StructuredOutput', input: { taskId: 'S1-001', status: 'done' } }]),
  ]));
  const items = conversation(file);
  assert.deepEqual(items.map((i) => i.role), ['user', 'agent', 'tool', 'error', 'handoff']);
  assert.ok(!items[0].text.includes('abcdef1234567890xyz'));
  assert.equal(items[2].text, 'List — ls');
  assert.equal(taskIdFromTranscript(file), 'S1-001');
});

test('health: container rows by prefix, ports, and only local addresses', async () => {
  const run = async () => ({ stdout: 'grc-postgres\trunning\tUp 2 hours\norion-neo4j\trunning\tUp\ngrc-seaweedfs\texited\tExited (1)\n' });
  assert.deepEqual((await checkContainers(['grc-'], run)).map((r) => [r.label, r.status]), [['grc-postgres', 'ok'], ['grc-seaweedfs', 'down']]);
  assert.equal((await checkContainers(['grc-'], async () => ({ error: { code: 'ENOENT' } })))[0].status, 'unknown');
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  assert.equal((await checkPort({ port: server.address().port })).status, 'ok');
  server.close();
  assert.equal((await checkHttp({ label: 'x', url: 'http://example.com/' })).status, 'unknown');
});

test('logs stay where the config says', () => {
  assert.ok(LOGS.startsWith(ROOT));
});
