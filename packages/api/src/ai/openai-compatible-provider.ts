// The one route to an OpenAI-compatible text-model server (D236): the user's Unsloth Studio model
// through its local API (POST <AI_TEXT_BASE_URL>/chat/completions), with AI SDK v7's
// OpenAI-compatible provider. Only this file and the OpenAI-compatible text model know the provider.
//
// Nothing else is called (D57, D63): every request goes through a fetch that refuses any address
// outside AI_TEXT_BASE_URL and any redirect, models are always passed as objects (a model given as
// a plain string would go to the AI SDK's hosted gateway), and the SDK's warning printer is off, so
// the SDK itself writes nothing to the console (D163). The key (D57) leaves the program only as
// this provider's `Authorization: Bearer` header, and only to AI_TEXT_BASE_URL.
import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import type { OpenAiCompatibleSettings } from './ai-settings.js';
import type { FetchLike } from './ollama-provider.js';

globalThis.AI_SDK_LOG_WARNINGS = false;

/** The provider's name; the name its per-call options go under is its camelCase form. */
export const OPENAI_COMPATIBLE_PROVIDER_NAME = 'openai-compatible';

export interface OpenAiCompatibleConnection extends OpenAiCompatibleSettings {
  /** Stands in for the network, for tests. Still limited to `baseUrl`. */
  fetch?: FetchLike;
}

/** Thrown, before anything is sent, for a request to an address outside AI_TEXT_BASE_URL. */
export class TextModelAddressRefused extends Error {
  constructor() {
    super('The AI client refused a request outside AI_TEXT_BASE_URL.');
    this.name = 'TextModelAddressRefused';
  }
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

/** A fetch limited to the text-model server's address: same origin, under its path, no redirects. */
export function openAiCompatibleOnlyFetch(baseUrl: string, inner: FetchLike = globalThis.fetch): FetchLike {
  const base = new URL(baseUrl);
  const prefix = `${base.pathname.replace(/\/+$/, '')}/`;
  return async (input, init) => {
    let url: URL;
    try {
      url = requestUrl(input);
    } catch {
      throw new TextModelAddressRefused();
    }
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) throw new TextModelAddressRefused();
    return inner(input, { ...init, redirect: 'error' });
  };
}

export function createOpenAiCompatibleProvider(connection: OpenAiCompatibleConnection): OpenAICompatibleProvider {
  return createOpenAICompatible({
    name: OPENAI_COMPATIBLE_PROVIDER_NAME,
    baseURL: connection.baseUrl,
    apiKey: connection.apiKey,
    fetch: openAiCompatibleOnlyFetch(connection.baseUrl, connection.fetch),
    // The server takes a JSON schema in `response_format` (llama-server), so answers are held to it.
    supportsStructuredOutputs: true,
    // Token counts for streams too.
    includeUsage: true,
  });
}
