// The API key check (D54, D230). A request with `Authorization: Bearer …` runs as the key's org,
// role and clearance, all three from the key's row: `request.principal = { orgId, userId:
// 'api_key:<id>', role, clearance, apiKeyId }`, so `@Requires` + `AccessGuard` limit it by the D50
// table, and the clearance is what its label checks, its Postgres org context (row security) and
// its Neo4j read account (role × clearance) use. Keys made before D230 have clearance `internal`.
// The org comes from the key only, never from a header, the body or the query. An unknown,
// malformed, expired or revoked key gets 401. The global SessionGuard calls this when the request
// carries a bearer credential, so it runs before any route guard.
import type { FastifyRequest } from 'fastify';
import type { ApiKeysService } from './api-keys.service.js';
import type { AuthedRequest } from './session.guard.js';

const BEARER = /^Bearer(?:\s+(.*))?$/i;

/** The bearer credential, '' for a bearer with nothing after it, or null when there is none. */
export function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = BEARER.exec(header.trim());
  if (!match) return null;
  return (match[1] ?? '').trim();
}

export class ApiKeyGuard {
  constructor(private readonly keys: ApiKeysService) {}

  /** Sets `request.principal` from the key, or throws a 401. */
  async authenticate(request: FastifyRequest & AuthedRequest, credential: string): Promise<void> {
    request.principal = await this.keys.authenticate(credential, request.log);
  }
}
