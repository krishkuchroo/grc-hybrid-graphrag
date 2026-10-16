// The one route to Ollama (D31): AI SDK v7 with the community Ollama provider, which talks to
// Ollama's own API (/api/chat, /api/embed). That route takes Ollama's `options` (num_ctx, seed,
// temperature) and JSON-schema structured output, which the OpenAI-compatible endpoint can't set
// per call (no num_ctx). Switching routes stays local to src/ai/: only this file and the two
// Ollama clients know the provider.
//
// Nothing else is called (D57, D63): every request goes through a fetch that refuses any address
// outside OLLAMA_BASE_URL and any redirect, models are always passed as objects (a model given as a
// plain string would go to the AI SDK's hosted gateway), and the SDK's warning printer is off, so
// the SDK itself writes nothing to the console (D163).
import { createOllama, type OllamaProvider } from 'ollama-ai-provider-v2';

globalThis.AI_SDK_LOG_WARNINGS = false;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OllamaConnection {
  /** Ollama's address (AiSettings.ollamaBaseUrl). */
  baseUrl: string;
  /** Stands in for the network, for tests. Still limited to `baseUrl`. */
  fetch?: FetchLike;
}

/** Thrown, before anything is sent, for a request to an address outside OLLAMA_BASE_URL. */
export class OllamaAddressRefused extends Error {
  constructor() {
    super('The AI client refused a request outside OLLAMA_BASE_URL.');
    this.name = 'OllamaAddressRefused';
  }
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

/** A fetch limited to the Ollama address: same origin, under its path, no redirects. */
export function ollamaOnlyFetch(baseUrl: string, inner: FetchLike = globalThis.fetch): FetchLike {
  const base = new URL(baseUrl);
  const prefix = `${base.pathname.replace(/\/+$/, '')}/`;
  return async (input, init) => {
    const url = requestUrl(input);
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) throw new OllamaAddressRefused();
    return inner(input, { ...init, redirect: 'error' });
  };
}

export function createOllamaProvider(connection: OllamaConnection): OllamaProvider {
  return createOllama({
    baseURL: `${connection.baseUrl}/api`,
    fetch: ollamaOnlyFetch(connection.baseUrl, connection.fetch),
  });
}
