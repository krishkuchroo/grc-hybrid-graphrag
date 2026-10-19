// The AI clients' settings (D8, D19, D25, D34, D57, D63, D236, D242). OLLAMA_BASE_URL is Ollama on
// the Mac (http://127.0.0.1:11434) and http://host.docker.internal:11434 in the containers
// (compose.yaml). The two model names are optional settings, so the model stays swappable (D8).
//
// AI_TEXT_PROVIDER picks the text model's server (D236): `ollama` (the default, gemma4:12b) or
// `openai-compatible` (the user's Unsloth Studio model through its local OpenAI-compatible API, at
// AI_TEXT_BASE_URL with the secret AI_TEXT_API_KEY). Embeddings always stay on Ollama (bge-m3).
// No address is refused for being off the Mac (D242): `offMacAddressSettings` names the ones that
// are, for a warning at start-up.
//
// Errors name the setting only, never its value.

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
/** D34: gemma4:12b for extraction, suggestions and chat. */
export const DEFAULT_TEXT_MODEL = 'gemma4:12b';
/** D25: bge-m3 for every vector (1024 numbers). */
export const DEFAULT_EMBEDDING_MODEL = 'bge-m3';

/** The servers the text model can run on (D236). */
export const TEXT_PROVIDERS = ['ollama', 'openai-compatible'] as const;
export type TextProvider = (typeof TEXT_PROVIDERS)[number];
export const DEFAULT_TEXT_PROVIDER: TextProvider = 'ollama';

/** An OpenAI-compatible text-model server (Unsloth Studio, D236). The key is a secret (D57). */
export interface OpenAiCompatibleSettings {
  /** The server's address up to and including `/v1`, without a trailing slash. */
  baseUrl: string;
  /** Sent only as the `Authorization: Bearer` header. Never logged or printed. */
  apiKey: string;
}

export interface AiSettings {
  /** Ollama's address, without a trailing slash: scheme, host, port and any path prefix. */
  ollamaBaseUrl: string;
  textModel: string;
  embeddingModel: string;
  textProvider: TextProvider;
  /** Present exactly when `textProvider` is `openai-compatible`. */
  openAiCompatible?: OpenAiCompatibleSettings;
}

/** An Ollama model tag such as `gemma4:12b`, `bge-m3` or `library/bge-m3:latest`. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/** A key made of visible ASCII characters only (0x21 to 0x7E): nothing that could break a header. */
const API_KEY = /^[\x21-\x7E]+$/;

/** The hosts that are this Mac (D242): the loopback names, and the Mac as the containers see it. */
const MAC_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', 'host.docker.internal']);

const DOCKER_HOST = 'host.docker.internal';

function isBlank(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === '';
}

function modelName(setting: string, value: string | undefined, fallback: string): string {
  const name = isBlank(value) ? fallback : value.trim();
  if (!MODEL_NAME.test(name)) throw new Error(`${setting} is not a valid model name`);
  return name;
}

/** The address rule: http or https, no user name or password, no query or fragment. */
function checkedAddress(setting: 'OLLAMA_BASE_URL' | 'AI_TEXT_BASE_URL', raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${setting} is not a valid address`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${setting} must start with http:// or https://`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`${setting} must hold no user name, password, query or fragment`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Checks the Ollama address: http or https, no user name or password, no query or fragment. */
export function ollamaBaseUrl(value: string | undefined): string {
  return checkedAddress('OLLAMA_BASE_URL', isBlank(value) ? DEFAULT_OLLAMA_BASE_URL : value.trim());
}

function textProvider(value: string | undefined): TextProvider {
  const name = isBlank(value) ? DEFAULT_TEXT_PROVIDER : value.trim();
  const known = TEXT_PROVIDERS.find((provider) => provider === name);
  if (known === undefined) throw new Error('AI_TEXT_PROVIDER must be ollama or openai-compatible');
  return known;
}

function openAiCompatibleBaseUrl(value: string | undefined): string {
  if (isBlank(value)) throw new Error('AI_TEXT_BASE_URL is required when AI_TEXT_PROVIDER is openai-compatible');
  return checkedAddress('AI_TEXT_BASE_URL', value.trim());
}

function openAiCompatibleApiKey(value: string | undefined): string {
  if (isBlank(value)) throw new Error('AI_TEXT_API_KEY is required when AI_TEXT_PROVIDER is openai-compatible');
  const key = value.trim();
  if (!API_KEY.test(key)) throw new Error('AI_TEXT_API_KEY must hold only visible ASCII characters');
  return key;
}

function openAiCompatibleModel(value: string | undefined): string {
  // gemma4:12b is an Ollama tag, so this server's model has no default.
  if (isBlank(value)) throw new Error('AI_TEXT_MODEL is required when AI_TEXT_PROVIDER is openai-compatible');
  return modelName('AI_TEXT_MODEL', value, DEFAULT_TEXT_MODEL);
}

export function aiSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): AiSettings {
  const provider = textProvider(env.AI_TEXT_PROVIDER);
  // The embedder needs these under both providers.
  const ollama = ollamaBaseUrl(env.OLLAMA_BASE_URL);
  const embeddingModel = modelName('AI_EMBEDDING_MODEL', env.AI_EMBEDDING_MODEL, DEFAULT_EMBEDDING_MODEL);
  if (provider === 'ollama') {
    // As before: the openai-compatible settings are ignored, not even checked.
    return {
      ollamaBaseUrl: ollama,
      textModel: modelName('AI_TEXT_MODEL', env.AI_TEXT_MODEL, DEFAULT_TEXT_MODEL),
      embeddingModel,
      textProvider: provider,
    };
  }
  return {
    ollamaBaseUrl: ollama,
    textModel: openAiCompatibleModel(env.AI_TEXT_MODEL),
    embeddingModel,
    textProvider: provider,
    openAiCompatible: {
      baseUrl: openAiCompatibleBaseUrl(env.AI_TEXT_BASE_URL),
      apiKey: openAiCompatibleApiKey(env.AI_TEXT_API_KEY),
    },
  };
}

/**
 * The address as a command on the Mac reaches it: `host.docker.internal` (the Mac as the
 * containers see it, D170) becomes `127.0.0.1`, keeping the port and path. Any other address,
 * or a value that isn't an address, comes back unchanged. Only the Mac-side commands use it,
 * never the API or the worker.
 */
export function macSideAddress(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url;
  }
  if (parsed.hostname !== DOCKER_HOST) return url;
  // Swap only the host, keeping the rest as written.
  const swapped = url.replace(
    /^(\s*[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/?#@]*@)?)host\.docker\.internal(?=[:/?#\s]|$)/i,
    (_match, prefix: string) => `${prefix}127.0.0.1`,
  );
  if (swapped !== url) return swapped;
  // Written in a form the pattern doesn't cover (for example an encoded host): the parsed form.
  parsed.hostname = '127.0.0.1';
  return parsed.href;
}

function onTheMac(address: string): boolean {
  try {
    return MAC_HOSTS.has(new URL(address).hostname);
  } catch {
    // Not readable as an address: never assume it stays on the Mac (fail safe).
    return false;
  }
}

/**
 * The names of the AI address settings in use whose host isn't this Mac (D242), in the order
 * OLLAMA_BASE_URL, AI_TEXT_BASE_URL. AI_TEXT_BASE_URL counts only under `openai-compatible`.
 * Holds names only, never an address or a key.
 */
export function offMacAddressSettings(settings: AiSettings): string[] {
  const off: string[] = [];
  if (!onTheMac(settings.ollamaBaseUrl)) off.push('OLLAMA_BASE_URL');
  if (settings.textProvider === 'openai-compatible') {
    const baseUrl = settings.openAiCompatible?.baseUrl;
    if (baseUrl === undefined || !onTheMac(baseUrl)) off.push('AI_TEXT_BASE_URL');
  }
  return off;
}
