// logs/state/<agent>.<kind>.json: what the hooks remember about each agent
// between calls: when it started, its finish-check attempts, its task.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOGS_DIR } from './paths.mjs';

const stateDir = () => join(LOGS_DIR, 'state');

export function agentKey(agentId) {
  const id = String(agentId);
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : createHash('sha256').update(id).digest('hex').slice(0, 32);
}

const stateFile = (agentId, kind) => join(stateDir(), `${agentKey(agentId)}.${kind}.json`);

export function readState(agentId, kind) {
  try {
    return JSON.parse(readFileSync(stateFile(agentId, kind), 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(agentId, kind, value) {
  mkdirSync(stateDir(), { recursive: true });
  const target = stateFile(agentId, kind);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, target);
}

// Creates the state only if none exists; true when this call created it.
export function createStateOnce(agentId, kind, value) {
  mkdirSync(stateDir(), { recursive: true });
  try {
    writeFileSync(stateFile(agentId, kind), JSON.stringify(value), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}
