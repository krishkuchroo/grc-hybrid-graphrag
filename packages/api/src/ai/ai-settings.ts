// The AI clients' settings (D8, D19, D25, D34, D57, D63). OLLAMA_BASE_URL is Ollama on the Mac
// (http://127.0.0.1:11434) and http://host.docker.internal:11434 in the containers (compose.yaml).
// The two model names are optional settings, so the model stays swappable (D8).
// Errors name the setting only, never its value.

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
/** D34: gemma4:12b for extraction, suggestions and chat. */
export const DEFAULT_TEXT_MODEL = 'gemma4:12b';
/** D25: bge-m3 for every vector (1024 numbers). */
export const DEFAULT_EMBEDDING_MODEL = 'bge-m3';

export interface AiSettings {
  /** Ollama's address, without a trailing slash: scheme, host, port and any path prefix. */
  ollamaBaseUrl: string;
  textModel: string;
  embeddingModel: string;
}

/** An Ollama model tag such as `gemma4:12b`, `bge-m3` or `library/bge-m3:latest`. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

function modelName(setting: string, value: string | undefined, fallback: string): string {
  const name = value === undefined || value.trim() === '' ? fallback : value.trim();
  if (!MODEL_NAME.test(name)) throw new Error(`${setting} is not a valid model name`);
  return name;
}

/** Checks the Ollama address: http or https, no user name or password, no query or fragment. */
export function ollamaBaseUrl(value: string | undefined): string {
  const raw = value === undefined || value.trim() === '' ? DEFAULT_OLLAMA_BASE_URL : value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('OLLAMA_BASE_URL is not a valid address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OLLAMA_BASE_URL must start with http:// or https://');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('OLLAMA_BASE_URL must hold no user name, password, query or fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function aiSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): AiSettings {
  return {
    ollamaBaseUrl: ollamaBaseUrl(env.OLLAMA_BASE_URL),
    textModel: modelName('AI_TEXT_MODEL', env.AI_TEXT_MODEL, DEFAULT_TEXT_MODEL),
    embeddingModel: modelName('AI_EMBEDDING_MODEL', env.AI_EMBEDDING_MODEL, DEFAULT_EMBEDDING_MODEL),
  };
}
