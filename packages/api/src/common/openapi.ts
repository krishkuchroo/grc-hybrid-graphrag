// The OpenAPI document, generated from the Zod schemas (D30). Each controller documents its
// routes with `documentRoute`, and GET /api/v1/openapi.json serves the result.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';

export const API_PREFIX = '/api/v1';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteDoc {
  method: Method;
  /** The path under the /api/v1 prefix, for example `/health`. */
  path: string;
  summary: string;
  /** The schema of the 200 JSON response. */
  response: z.ZodType;
}

const routes = new Map<string, RouteDoc>();

export function documentRoute(route: RouteDoc): void {
  routes.set(`${route.method} ${route.path}`, route);
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;
  delete result.$schema;
  return result;
}

export function openApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes.values()) {
    const path = `${API_PREFIX}${route.path}`;
    paths[path] ??= {};
    paths[path][route.method] = {
      summary: route.summary,
      responses: {
        '200': {
          description: 'OK',
          content: { 'application/json': { schema: jsonSchema(route.response) } },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'GRC API', version: '1' },
    paths,
  };
}

export class OpenApiController {
  document(): Record<string, unknown> {
    return openApiDocument();
  }
}
Controller()(OpenApiController);
Get('openapi.json')(
  OpenApiController.prototype,
  'document',
  Object.getOwnPropertyDescriptor(OpenApiController.prototype, 'document')!,
);
