// What `pnpm dataset:load` and `pnpm dataset:score` share (FT-001; D54, D57, D164, D230, D236,
// D238 (b)): finding an org and its Admin who holds Restricted by the org's slug, the run's
// short-lived Admin keys (made and revoked through ApiKeysService), and the documents step's model
// check. Loaded by the two commands after org-script-env.ts, which lets the api's `./x.js` imports
// load their `.ts`.
//
// The model check (D236): the documents step runs only when the models it needs answer.
// - Settings: AI-001's `aiSettingsFromEnv` over AI_TEXT_PROVIDER, AI_TEXT_MODEL, AI_TEXT_BASE_URL,
//   AI_TEXT_API_KEY, OLLAMA_BASE_URL and AI_EMBEDDING_MODEL as the command reads them (the
//   environment, then `.env`). AI_TEXT_BASE_URL goes through `macSideAddress` first, so an address
//   written for the containers (`host.docker.internal`) is reached on the Mac.
// - The embedding model, both modes, always on Ollama: `GET <OLLAMA_BASE_URL>/api/tags` answers 200
//   within 5 s and lists it.
// - The text model, full mode only, on the provider AI_TEXT_PROVIDER picks: `ollama`, the same list
//   holds it; `openai-compatible`, `GET <AI_TEXT_BASE_URL>/models` with `Authorization: Bearer
//   <AI_TEXT_API_KEY>` answers 200 within 5 s and its `data[].id` holds AI_TEXT_MODEL exactly.
// - On Ollama, a model name with no tag counts as `:latest`. Redirects are not followed.
// - A problem names the setting, the model or the HTTP status only: never the key or an address.
import { aiSettingsFromEnv, macSideAddress, type AiSettings } from '../../api/src/ai/ai-settings.js';
import type { ScriptDb } from './org-script-env.js';

/** How long each model server has to answer (D236). */
export const MODEL_CHECK_TIMEOUT_MS = 5000;

export type DatasetMode = 'full' | 'fast';

/** The settings the AI settings are read from. */
export const AI_SETTING_NAMES = [
  'AI_TEXT_PROVIDER',
  'AI_TEXT_MODEL',
  'AI_TEXT_BASE_URL',
  'AI_TEXT_API_KEY',
  'OLLAMA_BASE_URL',
  'AI_EMBEDDING_MODEL',
] as const;

/**
 * The AI settings as the documents step reads them, through `read` (a setting's value, or ''), with
 * AI_TEXT_BASE_URL on its Mac-side address. Throws AI-001's error, which names the setting only.
 */
export function datasetAiSettings(read: (name: string) => string): AiSettings {
  const env: NodeJS.ProcessEnv = {};
  for (const name of AI_SETTING_NAMES) {
    const value = read(name);
    if (value.trim() === '') continue;
    env[name] = name === 'AI_TEXT_BASE_URL' ? macSideAddress(value) : value;
  }
  return aiSettingsFromEnv(env);
}

/** An Ollama model name with its tag: `bge-m3` counts as `bge-m3:latest`. */
export function ollamaModelTag(name: string): string {
  const lastPart = name.slice(name.lastIndexOf('/') + 1);
  return lastPart.includes(':') ? name : `${name}:latest`;
}

export type ModelFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ModelCheckOptions {
  fetch?: ModelFetch;
  timeoutMs?: number;
}

type Answer = { ok: true; body: unknown } | { ok: false; problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One GET of a model server's list, read as JSON; the problem names `server` and the status only. */
async function getList(
  url: string,
  headers: Record<string, string>,
  server: string,
  opts: Required<ModelCheckOptions>,
): Promise<Answer> {
  const seconds = Math.round(opts.timeoutMs / 1000);
  // A timer of our own (it keeps the process waiting, unlike AbortSignal.timeout's), covering the
  // answer and its body.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  const noAnswer = (): Answer => ({
    ok: false,
    problem: timedOut
      ? `${server} gave no answer within ${seconds} s`
      : `${server} gave no answer (it isn't running, or the address is wrong)`,
  });
  try {
    let res: Response;
    try {
      res = await opts.fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...headers },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      return noAnswer();
    }
    if (res.status !== 200) {
      await res.arrayBuffer().catch(() => undefined);
      return { ok: false, problem: `${server} answered HTTP ${res.status} to its model list` };
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      return noAnswer();
    }
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, problem: `${server} answered its model list with something other than JSON` };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** The model names Ollama's `/api/tags` answer lists, each with its tag. */
function ollamaNames(body: unknown): Set<string> | null {
  const models = isRecord(body) ? body['models'] : undefined;
  if (!Array.isArray(models)) return null;
  const names = new Set<string>();
  for (const m of models) {
    if (!isRecord(m)) continue;
    for (const field of ['name', 'model']) {
      const value = m[field];
      if (typeof value === 'string' && value !== '') names.add(ollamaModelTag(value));
    }
  }
  return names;
}

/** The model IDs an OpenAI-compatible `/models` answer lists. */
function openAiIds(body: unknown): Set<string> | null {
  const data = isRecord(body) ? body['data'] : undefined;
  if (!Array.isArray(data)) return null;
  return new Set(data.flatMap((m) => (isRecord(m) && typeof m['id'] === 'string' ? [m['id']] : [])));
}

/**
 * The problems with the models the documents step needs in this mode (see the top of the file);
 * empty when every one answers. Sends the text model server's key only in its own request.
 */
export async function checkDatasetModels(
  settings: AiSettings,
  mode: DatasetMode,
  options: ModelCheckOptions = {},
): Promise<string[]> {
  const opts: Required<ModelCheckOptions> = {
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    timeoutMs: options.timeoutMs ?? MODEL_CHECK_TIMEOUT_MS,
  };
  const problems: string[] = [];
  const ollamaServer = 'Ollama (OLLAMA_BASE_URL)';
  const tags = await getList(`${settings.ollamaBaseUrl}/api/tags`, {}, ollamaServer, opts);
  const ollama = tags.ok ? ollamaNames(tags.body) : null;
  if (!tags.ok) problems.push(tags.problem);
  else if (ollama === null) problems.push(`${ollamaServer} answered its model list in a shape it doesn't use`);
  else if (!ollama.has(ollamaModelTag(settings.embeddingModel))) {
    problems.push(`Ollama doesn't have the embedding model ${settings.embeddingModel} (AI_EMBEDDING_MODEL)`);
  }

  if (mode === 'full') {
    if (settings.textProvider === 'ollama') {
      // The same answer as above; its problem is already listed when there is none.
      if (ollama !== null && !ollama.has(ollamaModelTag(settings.textModel))) {
        problems.push(`Ollama doesn't have the text model ${settings.textModel} (AI_TEXT_MODEL)`);
      }
    } else {
      const server = 'the text model server (AI_TEXT_BASE_URL)';
      const own = settings.openAiCompatible;
      if (own === undefined) {
        problems.push('AI_TEXT_BASE_URL and AI_TEXT_API_KEY are needed when AI_TEXT_PROVIDER is openai-compatible');
      } else {
        const list = await getList(`${own.baseUrl}/models`, { authorization: `Bearer ${own.apiKey}` }, server, opts);
        const ids = list.ok ? openAiIds(list.body) : null;
        if (!list.ok) problems.push(list.problem);
        else if (ids === null) problems.push(`${server} answered its model list in a shape it doesn't use`);
        else if (!ids.has(settings.textModel)) {
          problems.push(`${server} doesn't list the text model ${settings.textModel} (AI_TEXT_MODEL)`);
        }
      }
    }
  }
  return problems;
}

// ---- The org and its Admin ------------------------------------------------------------------

/** The drizzle `sql` tag (org-script-env.ts's `sqlTag`). */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

export type OrgAdmin = { found: true; adminId: string } | { found: false; missing: 'org' | 'admin' };

/**
 * The org of the slug (its ID comes from the slug, so nothing is read across the org wall) and its
 * first Admin who holds Restricted, whom the run's key is made by (D230 caps a key at its maker's
 * clearance).
 */
export async function findOrgAdmin(db: ScriptDb, sql: SqlTag, orgId: string, slug: string): Promise<OrgAdmin> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    const org = await tx.execute(sql`SELECT slug FROM "organization" WHERE id = ${orgId}::uuid`);
    if (org.rows[0]?.['slug'] !== slug) return { found: false, missing: 'org' };
    const admin = await tx.execute(
      sql`SELECT user_id FROM "member" WHERE org_id = ${orgId}::uuid AND role = 'admin' AND clearance = 'restricted'
          ORDER BY created_at, id LIMIT 1`,
    );
    const userId = admin.rows[0]?.['user_id'];
    return typeof userId === 'string' ? { found: true, adminId: userId } : { found: false, missing: 'admin' };
  });
}

// ---- The run's API keys ---------------------------------------------------------------------

/** The org context the keys are made and revoked in: the org's Admin at Restricted. */
export interface AdminCtx {
  orgId: string;
  userId: string;
  role: 'admin';
  clearance: 'restricted';
}

/** The slice of ApiKeysService the commands use. */
export interface KeysApi {
  create(ctx: AdminCtx, body: unknown): Promise<{ id: string; key: string }>;
  revoke(ctx: AdminCtx, id: string): Promise<void>;
}

/** Each run's API keys live at most this long (D54); they are revoked at the end anyway. */
export const DATASET_KEY_LIFETIME_MS = 60 * 60 * 1000;

/** The run's Admin keys at Restricted: made through ApiKeysService (audited), revoked once, however
 * the run ends. The secret is handed to the caller and never kept or printed here. */
export class RunKeys {
  private readonly made: { id: string; ctx: AdminCtx }[] = [];
  private revoking: Promise<{ revoked: number; failed: number }> | null = null;

  constructor(private readonly apiKeys: KeysApi) {}

  /** How many keys this run made. */
  get count(): number {
    return this.made.length;
  }

  /** A new Admin key at Restricted for the org, expiring after `DATASET_KEY_LIFETIME_MS`. */
  async make(ctx: AdminCtx, name: string): Promise<string> {
    if (this.revoking !== null) throw new Error('RunKeys: the run is ending; no new key');
    const made = await this.apiKeys.create(ctx, {
      name,
      role: 'admin',
      clearance: 'restricted',
      expiresAt: new Date(Date.now() + DATASET_KEY_LIFETIME_MS).toISOString(),
    });
    this.made.push({ id: made.id, ctx });
    return made.key;
  }

  /** Revokes every key this run made, once; later calls get the same answer. */
  revokeAll(): Promise<{ revoked: number; failed: number }> {
    this.revoking ??= (async () => {
      let revoked = 0;
      let failed = 0;
      for (const k of this.made) {
        try {
          await this.apiKeys.revoke(k.ctx, k.id);
          revoked += 1;
        } catch {
          failed += 1;
        }
      }
      return { revoked, failed };
    })();
    return this.revoking;
  }
}
