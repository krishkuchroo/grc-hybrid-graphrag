// The system-health panel (D148): containers, ports, local services and
// memory. Every check is read-only, has its own short timeout, and reports
// "unknown" rather than failing when a tool is missing.
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { freemem, totalmem } from 'node:os';

const GB = 1024 ** 3;
const LOCAL_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i;

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? { error } : { stdout }));
  });
}

export function checkPort({ label, port, host = '127.0.0.1' }, timeout = 800) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve({ kind: 'port', label: label ?? String(port), status: ok ? 'ok' : 'down', detail: `${host}:${port}` });
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function checkHttp({ label, url }, timeout = 1500) {
  if (!LOCAL_URL.test(String(url))) return { kind: 'http', label, status: 'unknown', detail: 'only 127.0.0.1 or localhost addresses are checked' };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'manual' });
    return { kind: 'http', label, status: res.status < 500 ? 'ok' : 'down', detail: `HTTP ${res.status}` };
  } catch (error) {
    return { kind: 'http', label, status: 'down', detail: error.name === 'TimeoutError' ? 'no answer' : 'not reachable' };
  }
}

// One row per container whose name starts with a configured prefix.
export async function checkContainers(prefixes, runFn = run) {
  if (!prefixes.length) return [];
  const { stdout, error } = await runFn('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}']);
  if (error) return [{ kind: 'container', label: 'Docker', status: 'unknown', detail: error.code === 'ENOENT' ? 'docker not found' : 'Docker is not answering' }];
  const rows = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [name, state, status] = line.split('\t');
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    rows.push({ kind: 'container', label: name, status: state === 'running' ? 'ok' : 'down', detail: status });
  }
  if (!rows.length) rows.push({ kind: 'container', label: prefixes.join(', '), status: 'down', detail: 'no matching containers' });
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

export async function checkMemory(limitGB, runFn = run) {
  const total = totalmem();
  const used = total - freemem();
  const rows = [{ kind: 'memory', label: 'This computer', status: used / total > 0.92 ? 'warn' : 'ok', detail: `${(used / GB).toFixed(1)} of ${(total / GB).toFixed(0)} GB used`, used, total }];
  const { stdout, error } = await runFn('docker', ['info', '--format', '{{.MemTotal}}']);
  const dockerTotal = Number(stdout?.trim());
  if (!error && dockerTotal > 0) {
    const off = limitGB && Math.abs(dockerTotal / GB - limitGB) > 0.5;
    rows.push({
      kind: 'memory',
      label: 'Docker limit',
      status: off ? 'warn' : 'ok',
      detail: `${(dockerTotal / GB).toFixed(1)} GB${limitGB ? ` (meant to be ${limitGB} GB)` : ''}`,
    });
  }
  return rows;
}

export async function runHealth(health, runFn = run) {
  const results = await Promise.all([
    checkContainers(health.containers ?? [], runFn),
    Promise.all((health.ports ?? []).map((p) => checkPort(p))),
    Promise.all((health.http ?? []).map((h) => checkHttp(h))),
    checkMemory(health.dockerMemoryLimitGB, runFn),
  ]);
  return { at: new Date().toISOString(), checks: results.flat() };
}
