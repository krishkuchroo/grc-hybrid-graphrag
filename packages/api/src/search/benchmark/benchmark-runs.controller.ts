// The benchmark-runs routes (S8-002; D47, D50 `admin` cell, D51, D73), under /api/v1, for the org's
// Admins only (people and Admin-role API keys; every other role gets 403 at the guard):
//   POST /benchmark/runs              start a run (S8-001's start body)                201
//   POST /benchmark/runs/:id/results  add 1 to 25 result items; repeats are ignored   200, 409 when ended
//   POST /benchmark/runs/:id/finish   finish it, or fail it with a code               200, 409 when ended
//   GET  /benchmark/runs              the runs, paged, newest first (status, part)
//   GET  /benchmark/runs/:id          one run with its summary
//   GET  /benchmark/runs/:id/results  its results, paged, in question order then mode (part, mode,
//                                     kind, outcome)
// Writing needs the `admin` cell's `edit`, reading its `view`. Another org's run or a missing one is
// 404. The service checks the cell again, and every read and write runs in the caller's own org
// context (./benchmark-runs.service.ts). The org, role and clearance always come from
// `request.principal`, never from the request.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import {
  addBenchmarkResultsBodySchema,
  benchmarkResultsAddedSchema,
  benchmarkResultsPageSchema,
  benchmarkRunDetailSchema,
  benchmarkRunsPageSchema,
  finishBenchmarkRunBodySchema,
  startBenchmarkRunBodySchema,
  type BenchmarkResultsAdded,
  type BenchmarkResultsPage,
  type BenchmarkRunDetail,
  type BenchmarkRunsPage,
} from '@grc/shared';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { ApiError } from '../../common/errors.js';
import { documentRoute } from '../../common/openapi.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import type { Caller } from '../../records/records.service.js';
import {
  BenchmarkRunsService,
  benchmarkResultListQuerySchema,
  benchmarkRunListQuerySchema,
} from './benchmark-runs.service.js';

function callerOf(request: AuthedRequest): Caller {
  const p = request.principal;
  if (!p) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
  return {
    orgId: p.orgId,
    userId: p.userId,
    role: p.role,
    clearance: p.clearance,
    ...(p.apiKeyId !== undefined ? { apiKeyId: p.apiKeyId } : {}),
  };
}

export class BenchmarkRunsController {
  constructor(private readonly runs: BenchmarkRunsService) {}

  start(request: AuthedRequest, body: unknown): Promise<BenchmarkRunDetail> {
    return this.runs.start(callerOf(request), body);
  }

  addResults(request: AuthedRequest, id: string, body: unknown): Promise<BenchmarkResultsAdded> {
    return this.runs.addResults(callerOf(request), id, body);
  }

  finish(request: AuthedRequest, id: string, body: unknown): Promise<BenchmarkRunDetail> {
    return this.runs.finish(callerOf(request), id, body);
  }

  list(request: AuthedRequest, query: unknown): Promise<BenchmarkRunsPage> {
    return this.runs.list(callerOf(request), query ?? {});
  }

  get(request: AuthedRequest, id: string): Promise<BenchmarkRunDetail> {
    return this.runs.get(callerOf(request), id);
  }

  results(request: AuthedRequest, id: string, query: unknown): Promise<BenchmarkResultsPage> {
    return this.runs.results(callerOf(request), id, query ?? {});
  }
}
{
  const p = BenchmarkRunsController.prototype;
  const d = (method: keyof BenchmarkRunsController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Post()(p, 'start', d('start'));
  HttpCode(201)(p, 'start', d('start'));
  Requires('admin', 'edit')(p, 'start', d('start'));
  Req()(p, 'start', 0);
  Body()(p, 'start', 1);

  Post(':id/results')(p, 'addResults', d('addResults'));
  HttpCode(200)(p, 'addResults', d('addResults'));
  Requires('admin', 'edit')(p, 'addResults', d('addResults'));
  Req()(p, 'addResults', 0);
  Param('id')(p, 'addResults', 1);
  Body()(p, 'addResults', 2);

  Post(':id/finish')(p, 'finish', d('finish'));
  HttpCode(200)(p, 'finish', d('finish'));
  Requires('admin', 'edit')(p, 'finish', d('finish'));
  Req()(p, 'finish', 0);
  Param('id')(p, 'finish', 1);
  Body()(p, 'finish', 2);

  Get()(p, 'list', d('list'));
  Requires('admin', 'view')(p, 'list', d('list'));
  Req()(p, 'list', 0);
  Query()(p, 'list', 1);

  Get(':id')(p, 'get', d('get'));
  Requires('admin', 'view')(p, 'get', d('get'));
  Req()(p, 'get', 0);
  Param('id')(p, 'get', 1);

  Get(':id/results')(p, 'results', d('results'));
  Requires('admin', 'view')(p, 'results', d('results'));
  Req()(p, 'results', 0);
  Param('id')(p, 'results', 1);
  Query()(p, 'results', 2);

  UseGuards(AccessGuard)(BenchmarkRunsController);
  Controller('benchmark/runs')(BenchmarkRunsController);
  Inject(BenchmarkRunsService)(BenchmarkRunsController, undefined, 0);
}

documentRoute({
  method: 'post',
  path: '/benchmark/runs',
  summary:
    "Start a benchmark run in the caller's org (Admins only): the parts, modes, question set and question count. The run is saved running, labelled with the caller's clearance, with its settings: the body plus the text and embedding models, the prompt versions, the search limits, the matching cut-offs and the injection checks the API runs with. Audited as benchmark.run_started. 201 with the run",
  body: startBenchmarkRunBodySchema,
  response: benchmarkRunDetailSchema,
  responses: { '201': { description: 'Created: the run is running', schema: benchmarkRunDetailSchema } },
});
documentRoute({
  method: 'post',
  path: '/benchmark/runs/{id}/results',
  summary:
    "Add 1 to 25 result items to a running run (Admins only), each in one of the run's parts and modes. Answers longer than 4,000 characters are cut. An item with the same item key and mode as one already stored is ignored; the answer says how many were stored and how many were repeats. The run's last activity moves on. 409 run_not_running for a finished or failed run; 404 for a missing one or another org's",
  body: addBenchmarkResultsBodySchema,
  response: benchmarkResultsAddedSchema,
});
documentRoute({
  method: 'post',
  path: '/benchmark/runs/{id}/finish',
  summary:
    "End a running run (Admins only): finished, or failed with its code. The API computes the summary from the run's stored results and saves it with the status and the finished time; audited as benchmark.run_finished with counts and headline numbers only. 409 run_not_running for a run that has ended; 404 for a missing one or another org's",
  body: finishBenchmarkRunBodySchema,
  response: benchmarkRunDetailSchema,
});
documentRoute({
  method: 'get',
  path: '/benchmark/runs',
  summary:
    "The org's benchmark runs (Admins only), paged, newest first, each with its status, parts, modes, data version, question and result counts and headline numbers per mode. Filters: status, part",
  response: benchmarkRunsPageSchema,
  query: benchmarkRunListQuerySchema,
});
documentRoute({
  method: 'get',
  path: '/benchmark/runs/{id}',
  summary:
    "One benchmark run with its settings and summary (Admins only). A reader whose clearance is below the run's label gets its row and summary with hidden: true instead of the settings. 404 for a missing one or another org's",
  response: benchmarkRunDetailSchema,
});
documentRoute({
  method: 'get',
  path: '/benchmark/runs/{id}/results',
  summary:
    "A benchmark run's results (Admins only), paged, in question order then mode. Filters: part, mode, kind, outcome. A reader whose clearance is below the run's label gets hidden: true and no items. 404 for a missing run or another org's",
  response: benchmarkResultsPageSchema,
  query: benchmarkResultListQuerySchema,
});
