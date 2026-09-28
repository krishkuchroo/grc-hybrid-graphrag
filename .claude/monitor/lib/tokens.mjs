// Token use per agent, task, milestone and day, plus the burn rate (D156),
// read from Claude Code's saved conversations. Each reply is saved once per
// content block with the same usage, so replies are counted by message ID.
// Files are read from where they left off; the position is saved in
// logs/state/monitor-tokens.json so a restart doesn't re-read everything.
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { LOGS_DIR, follow, readJson, writeJson } from './core.mjs';
import { lookUpTaskId, projectFolders } from './transcripts.mjs';

const CACHE_FILE = () => join(LOGS_DIR, 'state', 'monitor-tokens.json');
const CACHE_VERSION = 1;
const RECENT_IDS = 32;
const BURN_WINDOW_MS = 5 * 60_000;

const zero = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
const add = (a, b, sign = 1) => {
  a.input += sign * b.input;
  a.cacheWrite += sign * b.cacheWrite;
  a.cacheRead += sign * b.cacheRead;
  a.output += sign * b.output;
  return a;
};
export const totalOf = (t) => t.input + t.cacheWrite + t.cacheRead + t.output;

export function usageOf(u) {
  return {
    input: Number(u?.input_tokens) || 0,
    cacheWrite: Number(u?.cache_creation_input_tokens) || 0,
    cacheRead: Number(u?.cache_read_input_tokens) || 0,
    output: Number(u?.output_tokens) || 0,
  };
}

const dayOf = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Who a transcript belongs to, from where it sits.
export function identify(file, folder) {
  const m = file.match(/[/\\]subagents[/\\](?:workflows[/\\][^/\\]+[/\\])?agent-([^/\\]+)\.jsonl$/);
  if (m) {
    const meta = readJson(file.replace(/\.jsonl$/, '.meta.json')) ?? {};
    return { agentId: m[1], agentType: meta.agentType || 'agent', kind: 'agent', description: meta.description ?? '' };
  }
  if (!/^[0-9a-f-]{36}\.jsonl$/.test(basename(file)) || join(folder, basename(file)) !== file) return null;
  const sessionId = basename(file, '.jsonl');
  // A session started in a worktree folder is a run launched from the page.
  if (basename(folder).includes('--claude-worktrees-')) return { agentId: `run-${sessionId}`, agentType: 'launched', kind: 'launched', sessionId };
  return { agentId: `main-${sessionId}`, agentType: 'main', kind: 'main', sessionId };
}

export function createTokenStore({ folders = () => projectFolders(), launchedType = () => null } = {}) {
  const records = new Map();
  const recent = []; // { t, n } for the burn rate
  let dirty = false;

  function track(rec) {
    rec.ids = new Map(rec.lastIds ?? []);
    rec.read = follow(
      rec.file,
      (entry) => {
        const id = entry?.message?.id;
        if (entry?.type !== 'assistant' || !id || !entry.message.usage) return;
        const usage = usageOf(entry.message.usage);
        const day = dayOf(entry.timestamp) ?? 'unknown';
        const before = rec.ids.get(id);
        if (before) {
          add(rec.totals, before.usage, -1);
          add(rec.byDay[before.day] ?? (rec.byDay[before.day] = zero()), before.usage, -1);
          rec.ids.delete(id);
        }
        rec.ids.set(id, { usage, day });
        if (rec.ids.size > RECENT_IDS) rec.ids.delete(rec.ids.keys().next().value);
        add(rec.totals, usage);
        add(rec.byDay[day] ?? (rec.byDay[day] = zero()), usage);
        rec.lastTs = entry.timestamp ?? rec.lastTs;
        const t = Date.parse(entry.timestamp);
        if (!before && t > Date.now() - BURN_WINDOW_MS) recent.push({ t, n: totalOf(usage), agentId: rec.agentId });
      },
      () => {
        rec.totals = zero();
        rec.byDay = {};
        rec.ids = new Map();
      },
      (line) => line.includes('"usage"') && line.includes('"assistant"'),
    );
    if (rec.pos) rec.read.seek(rec.pos);
  }

  // Loads the saved counts once.
  const saved = readJson(CACHE_FILE());
  if (saved?.version === CACHE_VERSION) {
    for (const [file, r] of Object.entries(saved.files ?? {})) {
      const rec = { ...r, file, totals: { ...zero(), ...r.totals }, byDay: r.byDay ?? {} };
      track(rec);
      records.set(file, rec);
    }
  }

  function scan() {
    let changed = false;
    for (const folder of folders()) {
      let names = [];
      try {
        names = readdirSync(folder, { recursive: true });
      } catch {
        continue;
      }
      for (const name of names) {
        if (!String(name).endsWith('.jsonl') || String(name).startsWith('tool-results')) continue;
        const file = join(folder, String(name));
        let rec = records.get(file);
        if (!rec) {
          const who = identify(file, folder);
          if (!who) continue;
          rec = { file, ...who, taskId: null, taskTries: 0, totals: zero(), byDay: {}, lastTs: null };
          track(rec);
          records.set(file, rec);
        }
        if (rec.kind !== 'main') ({ taskId: rec.taskId, tries: rec.taskTries } = lookUpTaskId({ taskId: rec.taskId, tries: rec.taskTries }, [file]));
        if (rec.kind === 'launched') rec.agentType = launchedType(rec.sessionId) ?? rec.agentType;
        if (rec.read()) changed = true;
      }
    }
    // Files that were deleted drop out.
    for (const file of records.keys()) {
      try {
        statSync(file);
      } catch {
        records.delete(file);
        changed = true;
      }
    }
    const cutoff = Date.now() - BURN_WINDOW_MS;
    while (recent.length && recent[0].t < cutoff) recent.shift();
    if (changed) dirty = true;
    return changed;
  }

  function save() {
    if (!dirty) return;
    dirty = false;
    const files = {};
    for (const [file, r] of records) {
      files[file] = {
        agentId: r.agentId,
        agentType: r.agentType,
        kind: r.kind,
        description: r.description,
        sessionId: r.sessionId,
        taskId: r.taskId,
        taskTries: r.taskTries,
        totals: r.totals,
        byDay: r.byDay,
        lastTs: r.lastTs,
        pos: r.read.position(),
        lastIds: [...r.ids],
      };
    }
    writeJson(CACHE_FILE(), { version: CACHE_VERSION, files });
  }

  // The file behind an agent ID (for its conversation).
  function fileOf(agentId) {
    for (const rec of records.values()) if (rec.agentId === agentId) return rec.file;
    return null;
  }

  function summary(milestoneOf = () => null) {
    const today = dayOf(Date.now());
    const all = zero();
    const todayTotals = zero();
    const byAgent = [];
    const groups = { task: new Map(), milestone: new Map(), type: new Map() };
    const bump = (map, key, t, extra) => {
      if (!key) return;
      const row = map.get(key) ?? { key, ...extra, totals: zero(), agents: 0 };
      add(row.totals, t);
      row.agents += 1;
      map.set(key, row);
    };
    for (const r of records.values()) {
      if (!totalOf(r.totals)) continue;
      add(all, r.totals);
      const t = r.byDay[today] ?? zero();
      add(todayTotals, t);
      const milestone = r.taskId ? milestoneOf(r.taskId) : null;
      byAgent.push({ agentId: r.agentId, agentType: r.agentType, kind: r.kind, taskId: r.taskId, milestone, totals: r.totals, today: totalOf(t), lastTs: r.lastTs });
      bump(groups.task, r.taskId, r.totals, { milestone });
      bump(groups.milestone, milestone, r.totals);
      bump(groups.type, r.agentType, r.totals);
    }
    const byTotal = (a, b) => totalOf(b.totals) - totalOf(a.totals);
    const burn = recent.reduce((n, x) => n + x.n, 0) / (BURN_WINDOW_MS / 60_000);
    const burnByAgent = {};
    for (const x of recent) burnByAgent[x.agentId] = (burnByAgent[x.agentId] ?? 0) + x.n / (BURN_WINDOW_MS / 60_000);
    return {
      today: todayTotals,
      all,
      burnPerMinute: Math.round(burn),
      burnByAgent,
      byAgent: byAgent.sort((a, b) => String(b.lastTs ?? '').localeCompare(String(a.lastTs ?? ''))),
      byTask: [...groups.task.values()].sort(byTotal),
      byMilestone: [...groups.milestone.values()].sort(byTotal),
      byType: [...groups.type.values()].sort(byTotal),
    };
  }

  return { scan, save, summary, fileOf, records };
}
