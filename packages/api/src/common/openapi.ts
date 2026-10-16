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
  /** The schema of the JSON request body, if the route takes one. */
  body?: z.ZodType;
  /** A multipart/form-data request body instead: its text fields, and its file parts by name with
   * their descriptions. */
  multipart?: { fields: z.ZodObject; files: Record<string, string> };
  /** The schema of the 200 JSON response. */
  response: z.ZodType;
  /** The 200 response's media type when it isn't JSON, for example `text/event-stream` (the chat's
   * streamed answer, whose events `response` then describes). */
  responseContentType?: string;
  /** Other JSON answers by status, for example a 201 that differs from the 200. */
  responses?: Record<string, { description: string; schema: z.ZodType }>;
  /** The query parameters the route takes (an object of strings), if any besides a list's paging. */
  query?: z.ZodObject;
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

/** A multipart form's schema: its file parts (binary strings) and its text fields. */
function multipartSchema(multipart: NonNullable<RouteDoc['multipart']>): Record<string, unknown> {
  const fields = jsonSchema(multipart.fields) as { properties?: Record<string, unknown>; required?: string[] };
  const files = Object.entries(multipart.files);
  return {
    type: 'object',
    properties: {
      ...Object.fromEntries(
        files.map(([name, description]) => [
          name,
          { type: 'string', format: 'binary', contentMediaType: 'application/octet-stream', description },
        ]),
      ),
      ...(fields.properties ?? {}),
    },
    required: [...files.map(([name]) => name), ...(fields.required ?? [])],
    additionalProperties: false,
  };
}

function requestBody(route: RouteDoc): Record<string, unknown> | undefined {
  if (route.multipart) {
    return {
      required: true,
      content: {
        'multipart/form-data': {
          schema: multipartSchema(route.multipart),
          encoding: Object.fromEntries(
            Object.keys(route.multipart.files).map((name) => [name, { contentType: 'application/octet-stream' }]),
          ),
        },
      },
    };
  }
  if (route.body) {
    return { required: true, content: { 'application/json': { schema: jsonSchema(route.body) } } };
  }
  return undefined;
}

/** A query schema's fields as OpenAPI query parameters. */
function queryParameters(schema: z.ZodObject): Array<Record<string, unknown>> {
  const json = jsonSchema(schema) as { properties?: Record<string, unknown>; required?: string[] };
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, value]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: value,
  }));
}

export function openApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes.values()) {
    const path = `${API_PREFIX}${route.path}`;
    paths[path] ??= {};
    const body = requestBody(route);
    paths[path][route.method] = {
      summary: route.summary,
      ...(route.query ? { parameters: queryParameters(route.query) } : {}),
      ...(body ? { requestBody: body } : {}),
      responses: {
        '200': {
          description: 'OK',
          content: { [route.responseContentType ?? 'application/json']: { schema: jsonSchema(route.response) } },
        },
        ...Object.fromEntries(
          Object.entries(route.responses ?? {}).map(([status, r]) => [
            status,
            { description: r.description, content: { 'application/json': { schema: jsonSchema(r.schema) } } },
          ]),
        ),
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
