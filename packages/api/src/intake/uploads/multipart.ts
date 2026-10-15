// Multipart request bodies (D53, D64), only on the upload routes (`POST /api/v1/uploads`, and
// S3-009's `POST /api/v1/evidence`).
// - `registerMultipart` adds @fastify/multipart to the API's Fastify instance, with the busboy limits
//   below (one file of at most `MAX_UPLOAD_BYTES`, a few small text fields). @fastify/multipart only
//   flags a multipart request; nothing is read until the route's handler asks for the parts, so the
//   guards (sign-in, the role table, the rate limit) answer before any of the body is read.
// - Its `onRequest` hook keeps every other route on JSON and the 1 MB cap: a multipart body sent to
//   any other route is 415, as it was before the plugin. On an upload route, a body declared bigger
//   than `UPLOAD_BODY_LIMIT_BYTES` (25 MB plus the multipart overhead) is 413 `file_too_large`
//   before anything is read. Multipart bodies don't pass through Fastify's `bodyLimit`, so the
//   busboy limits bound a body sent without a length; the door caps every request at 25 MB too.
// - `readMultipartForm` reads the parts into the text fields and the one file, mapping every
//   refusal to the one error format: 413 `file_too_large` for a file over the limit, and 400
//   `validation_failed` for anything malformed (two files, too many or repeated fields, a field
//   too long, a body that isn't multipart). The file's name and contents are never logged.
import fastifyMultipart from '@fastify/multipart';
import { MAX_UPLOAD_BYTES } from '@grc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, sendError } from '../../common/errors.js';
import { fileTooLarge } from './store-upload.js';

/** Room for the multipart boundaries, part headers and text fields around the file. */
export const UPLOAD_BODY_OVERHEAD_BYTES = 65_536;

/** The largest upload request body: the file plus the multipart overhead. */
export const UPLOAD_BODY_LIMIT_BYTES = MAX_UPLOAD_BYTES + UPLOAD_BODY_OVERHEAD_BYTES;

/** The routes that take a multipart body (full paths, as Fastify matched them). */
export const MULTIPART_ROUTES: readonly { method: 'POST'; path: string }[] = [
  { method: 'POST', path: '/api/v1/uploads' },
  { method: 'POST', path: '/api/v1/evidence' },
];

/** The busboy limits on an upload body. */
export const MULTIPART_LIMITS = Object.freeze({
  fileSize: MAX_UPLOAD_BYTES,
  files: 1,
  fields: 10,
  fieldSize: 1024,
  fieldNameSize: 100,
  parts: 12,
  headerPairs: 50,
});

export type MultipartLimits = Partial<typeof MULTIPART_LIMITS>;

/** Whether the request matched one of the multipart routes. */
export function isMultipartRoute(request: FastifyRequest): boolean {
  const path = request.routeOptions.url;
  return path !== undefined && MULTIPART_ROUTES.some((r) => r.method === request.method && r.path === path);
}

function isMultipartBody(request: FastifyRequest): boolean {
  const type = request.headers['content-type'];
  return typeof type === 'string' && /^\s*multipart\//i.test(type);
}

export async function registerMultipart(fastify: FastifyInstance): Promise<void> {
  await fastify.register(fastifyMultipart, { limits: { ...MULTIPART_LIMITS }, throwFileSizeLimit: true });
  fastify.addHook('onRequest', async (request, reply) => {
    if (!isMultipartBody(request) || request.routeOptions.url === undefined) return;
    if (!isMultipartRoute(request)) {
      sendError(request, reply, 415, 'unsupported_media_type', 'This address takes JSON, not a multipart form.');
      return reply;
    }
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > UPLOAD_BODY_LIMIT_BYTES) {
      sendError(request, reply, 413, 'file_too_large', fileTooLarge().message);
      return reply;
    }
  });
}

/** The one file of a multipart form. */
export interface MultipartFormFile {
  fieldName: string;
  fileName: string;
  body: Buffer;
}

/** A multipart form's text fields (each sent once) and its file, if one was sent. */
export interface MultipartForm {
  fields: Record<string, string>;
  file?: MultipartFormFile;
}

const invalid = (message: string): ApiError => new ApiError(400, 'validation_failed', message);

// A refusal from @fastify/multipart or busboy in the one error format; anything else is unexpected.
function refusal(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  switch (code) {
    case 'FST_REQ_FILE_TOO_LARGE':
      return fileTooLarge();
    case 'FST_FILES_LIMIT':
      return invalid('file: send one file only.');
    case 'FST_FIELDS_LIMIT':
    case 'FST_PARTS_LIMIT':
      return invalid('The form has too many fields.');
    case 'FST_PROTO_VIOLATION':
    case 'FST_INVALID_JSON_FIELD_ERROR':
      return invalid('The form has a field that is not allowed.');
    case 'FST_INVALID_MULTIPART_CONTENT_TYPE':
      return invalid('Send the upload as a multipart/form-data form with one file.');
    case 'FST_MP_PREMATURE_CLOSE':
      return invalid('The upload ended before the form was complete.');
    default:
      break;
  }
  // busboy's own parse errors are plain errors with no code ("Unexpected end of multipart data",
  // "Malformed part header", "Multipart: Boundary not found", "Part terminated early" …).
  if (err instanceof Error && code === undefined) return invalid('The multipart form is malformed.');
  return null;
}

// Whatever is left of a refused body is read and thrown away, so the connection stays usable. The
// door caps the body at 25 MB, so this read is bounded.
function drain(request: FastifyRequest): void {
  const raw = request.raw;
  raw.unpipe();
  if (!raw.readableEnded) raw.resume();
}

/** Reads a multipart request's text fields and its one file into memory. */
export async function readMultipartForm(request: FastifyRequest, limits: MultipartLimits = {}): Promise<MultipartForm> {
  if (typeof request.isMultipart !== 'function' || !request.isMultipart()) {
    throw invalid('Send the upload as a multipart/form-data form with one file.');
  }
  const form: MultipartForm = { fields: {} };
  try {
    for await (const part of request.parts({ limits: { ...MULTIPART_LIMITS, ...limits } })) {
      if (part.type === 'file') {
        if (form.file) throw invalid('file: send one file only.');
        const body = await part.toBuffer();
        form.file = { fieldName: part.fieldname, fileName: part.filename ?? '', body };
        continue;
      }
      if (part.fieldnameTruncated || part.valueTruncated) throw invalid(`${part.fieldname}: the value is too long.`);
      if (typeof part.value !== 'string') throw invalid(`${part.fieldname}: send plain text.`);
      if (Object.hasOwn(form.fields, part.fieldname)) throw invalid(`${part.fieldname}: send it once.`);
      form.fields[part.fieldname] = part.value;
    }
  } catch (err) {
    const refused = refusal(err);
    drain(request);
    if (refused) throw refused;
    throw err;
  }
  return form;
}
