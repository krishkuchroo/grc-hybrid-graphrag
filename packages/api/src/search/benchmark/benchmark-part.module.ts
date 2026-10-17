// Search part 4, the benchmark runs (S8; D1, D45.8, D46, D73): the routes the benchmark command stores
// a run through, piece by piece, and the Benchmark screen reads it from (`/api/v1/benchmark/runs`,
// S8-002), over the `benchmark_runs` and `benchmark_results` tables (./benchmark.schema.ts). Only the
// org's Admins start, fill, finish and read runs (the role table's `admin` cell), checked in the API
// and again by Postgres row security. Runs in the API program; the module declares its own imports.
// An empty module for now (S8-001); S8-002 fills it in. The shared model (kinds, metrics, shapes,
// `summariseBenchmark` and names) is in @grc/shared (packages/shared/src/benchmark/).
import { Module } from '@nestjs/common';

export class BenchmarkPartModule {}
Module({})(BenchmarkPartModule);
