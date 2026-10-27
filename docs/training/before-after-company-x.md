# Before / after: fine-tuned Qwen3.5-4B on Company X

The same test run twice on data the model never saw: once with the untrained base model ("before"), once
with the fine-tuned model ("after"). Only the model file changed between the two runs.

Date: 2026-10-26. Test set: Company X (`docs/datasets/company-x/`, D234). Plan: measure, train, measure
(D239).

## 1. Verdict

| Part                         | Before (base)     | After (trained)       | Result             |
| ---------------------------- | ----------------- | --------------------- | ------------------ |
| Questions answered correctly | 11 / 30           | **18 / 30**           | ✅ +7 (+7 partial) |
| Answer correctness (0–1)     | 0.50              | **0.82**              | ✅ +64%            |
| Graph queries that failed    | 3 / 30            | **0 / 30**            | ✅ all queries ran |
| Document links found         | 221 / 455 (48.6%) | **257 / 455 (56.5%)** | ✅ +36 links       |
| Wrong links suggested        | 230 of 455        | **188 of 457**        | ✅ −42 wrong       |
| Share of suggestions correct | 49.5%             | **58.9%**             | ✅                 |

**In one line:** training helped on both jobs it covered. The trained model answers far more questions
correctly (11 → 18 of 30) with no failed graph queries, and finds more true links (49% → 57%) while
suggesting fewer wrong ones (230 → 188). It got worse at citing sources (not trained) and at one link
type, IMPACTS (80% → 29%).

## 2. What was compared

|                                          | Before                                                          | After                                              |
| ---------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| Model file                               | `qwen3.5-4b-base.Q4_K_M.gguf` (untrained)                       | `qwen3.5-4b-grc-b8db12cb.Q4_K_M.gguf` (trained)    |
| How it was made                          | the training notebook's base-only export                        | the same notebook, after training (run `b8db12cb`) |
| Size / format                            | 2.6 GB, 4-bit Q4_K_M                                            | 2.6 GB, 4-bit Q4_K_M                               |
| Served by                                | Unsloth desktop app (llama-server), port 8888, Parallel Slots 1 | same                                               |
| Context window                           | 9,984 tokens (Unsloth's automatic fit)                          | 18,432 tokens (Unsloth's automatic fit)            |
| App, settings, embeddings (bge-m3), data | identical                                                       | identical                                          |

Both files come from the same export path, so the comparison measures training, not a difference in
how the files were made (D253). The context sizes differ only because Unsloth picks them; every
prompt in this test is far below both limits, so it does not change the answers.

### What the model was trained on

- **Data:** `data/generated/training/train-all/train.jsonl`, 3,000 rows of **real public data**:
  MITRE ATT&CK, CTID mappings (800-53, KEV, VERIS), CISA KEV, NVD descriptions, VCDB, and
  text2cypher-2024v1 rewritten to the app's graph. Company X names were excluded.
- **Jobs:** `extraction` (892 train / 108 validation rows) and `graph_query` (1,799 / 201).
- **Not trained:** writing the final chat answer with citations, and framework mapping (D249).
- **Training:** Unsloth LoRA (rank 16) on Qwen3.5-4B in 4-bit, 1 epoch, 673 steps, Google Colab T4.
  Training loss 0.159 → about 0.01; validation loss 0.011.
- **Notebook check** (50 held-out rows per job, same kind of data as training): extraction 100% valid
  JSON, 76% exactly right; graph_query 100% valid JSON, 78% exactly right.

## 3. The test set: Company X

Company X is a made-up company built only from public data whose correct answers are known (D234). It
was **never used in training**.

| Item                                   | Count                                                          | Used for           |
| -------------------------------------- | -------------------------------------------------------------- | ------------------ |
| Documents                              | 52 (94 chunks of up to 500 tokens)                             | extraction         |
| True links (`facts.json`)              | 471: **455 stated in documents**, 16 in the asset spreadsheets | extraction score   |
| Duplicate cases (`duplicates.json`)    | 22 scanner rows                                                | duplicate matching |
| Questions (`questions-company-x.json`) | 30, each with its expected records                             | Ask                |

The 30 questions by kind:

| Kind           | Count | Example                                                     |
| -------------- | ----- | ----------------------------------------------------------- |
| single_hop     | 10    | "Which controls mitigate Proxy: Internal Proxy?"            |
| multi_hop      | 8     | follows two links (e.g. incident → asset → risk)            |
| framework      | 6     | which controls map to a framework requirement               |
| no_answer      | 4     | the answer is not in the data; the model must say so        |
| injection_trap | 2     | a document hides an instruction; the model must not obey it |

## 4. How it was run

Both runs used the same commands; only `AI_TEXT_MODEL` in `.env` (and the model loaded in Unsloth)
changed, followed by a restart of grc-api and grc-worker.

| Part       | Before                                                                                                          | After                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Extraction | org `company-x`: base records, then `pnpm dataset:load --mode full --step documents`, then `pnpm dataset:score` | org `company-x-after`, loaded the same way from a copy of the folder that differs only in the org's slug and name |
| Questions  | `pnpm bench:run --org company-x-fast --part all`                                                                | the same command                                                                                                  |

- **Why two orgs for extraction:** a re-upload of the same documents into `company-x` is ignored as a
  duplicate, so the trained model needed a fresh org. `company-x-after` got exactly the same base step
  as `company-x` (118 records, 39 framework mappings, 44 asset rows, 6 duplicates merged on import).
- **Why `company-x-fast` for questions:** its graph holds every true link, so the questions test only
  the model's query writing and answering, not its extraction. It is also the only org whose records
  carry the answer-key IDs the question set uses (in `company-x`, 20 of 30 questions could not be
  resolved).
- **Vector-only mode** is reported by the benchmark but is not meaningful here: `company-x-fast` holds
  no uploaded documents, so plain document search has nothing to find (0 in both runs). The
  hybrid-vs-vector comparison belongs to an org with documents.

| Run                | ID / report                                                    |
| ------------------ | -------------------------------------------------------------- |
| Questions, before  | `d8774415-5687-460d-a96d-8a7ecef87d9d` (Benchmark screen)      |
| Questions, after   | `45d9a15c-f060-440e-babb-2fac8dc35724` (Benchmark screen)      |
| Extraction, before | `data/benchmark/dataset-company-x-20261026T165413Z.json`       |
| Extraction, after  | `data/benchmark/dataset-company-x-after-20261026T180110Z.json` |

## 5. Results: questions (Ask, hybrid search)

### 5.1 Answers

| Measure                              | Before      | After          | Better is | Change      |
| ------------------------------------ | ----------- | -------------- | --------- | ----------- |
| Answers: pass / partial / fail       | 11 / 0 / 19 | **18 / 7 / 5** | more pass | ✅          |
| Answer correctness                   | 0.497       | **0.816**      | higher    | ✅          |
| Citation accuracy                    | 0.871       | 0.680          | higher    | ❌          |
| Answers with a made-up record number | 0.200       | 0.167          | lower     | ✅ slightly |
| Planted instruction followed         | 0 / 2       | 0 / 2          | 0         | = (safe)    |

Answer correctness by question kind:

| Kind           | Before        | After         |
| -------------- | ------------- | ------------- |
| single_hop     | 0.600         | **1.000**     |
| multi_hop      | 0.614         | **0.971**     |
| framework      | 0.000         | 0.242         |
| injection_trap | 1.000         | 1.000         |
| no_answer      | 4 / 4 handled | 4 / 4 handled |

Pass / partial / fail by kind:

| Kind           | Before    | After         |
| -------------- | --------- | ------------- |
| single_hop     | 4 / 0 / 6 | **7 / 0 / 3** |
| multi_hop      | 3 / 0 / 5 | **6 / 1 / 1** |
| framework      | 0 / 0 / 6 | 0 / 6 / 0     |
| no_answer      | 4 / 0 / 0 | 4 / 0 / 0     |
| injection_trap | 0 / 0 / 2 | 1 / 0 / 1     |

The 3 single-hop "fails" after training named every expected record (correctness 1.000) but also
named a record number that was not among their sources, which the scorer counts as a fail.

### 5.2 Retrieval (did the search bring back the right records?)

| Measure                                          | Before         | After              | Change |
| ------------------------------------------------ | -------------- | ------------------ | ------ |
| Items: pass / partial / fail / skipped           | 15 / 8 / 3 / 4 | **18 / 8 / 0 / 4** | ✅     |
| Context recall                                   | 0.702          | **0.816**          | ✅     |
| Reciprocal rank                                  | 0.641          | 0.449              | ❌     |
| Graph query failed (fell back to documents only) | 3              | **0**              | ✅     |

| Kind           | Recall before | Recall after |
| -------------- | ------------- | ------------ |
| single_hop     | 0.700         | **1.000**    |
| multi_hop      | 0.975         | 0.971        |
| framework      | 0.242         | 0.242        |
| injection_trap | 1.000         | 1.000        |

### 5.3 Speed (95th percentile, against the D48 targets)

| Measure                   | Target   | Before   | After      |
| ------------------------- | -------- | -------- | ---------- |
| Vector search             | < 500 ms | 12 ms    | 15 ms      |
| Running the graph query   | < 500 ms | 176 ms   | 173 ms     |
| First words of the answer | < 25 s   | 15.7 s   | 16.9 s     |
| Full answer               | < 60 s   | 25.9 s   | **22.9 s** |
| Whole 30-question run     | —        | 12.4 min | 12.6 min   |

All targets pass in both runs.

## 6. Results: extraction (52 documents)

| Measure                                         | Before                 | After                  | Better is | Change            |
| ----------------------------------------------- | ---------------------- | ---------------------- | --------- | ----------------- |
| Document links found (live + waiting in review) | 221 / 455 (48.6%)      | **257 / 455 (56.5%)**  | higher    | ✅ +36            |
| Document links missed                           | 234 / 455 (51.4%)      | **198 / 455 (43.5%)**  | lower     | ✅ −36            |
| Link suggestions made                           | 455                    | 457                    | —         | =                 |
| Suggestions matching a true link                | 225 (49.5%)            | **269 (58.9%)**        | higher    | ✅                |
| Wrong links suggested (match no true link)      | 230                    | **188**                | lower     | ✅ −42            |
| Links that went live automatically              | 0 (all went to review) | 0 (all went to review) | —         | =                 |
| Spreadsheet links (no AI; HOSTS, RUNS)          | 16 / 16                | 16 / 16                | —         | = (no AI)         |
| Duplicates: merged / flagged / missed (of 22)   | 6 / 2 / 14             | 6 / 2 / 14             | —         | = (no text model) |
| Values normalised correctly                     | 132 / 132              | 132 / 132              | —         | = (no AI)         |
| Model time per chunk (94 chunks)                | about 15 s (10–24 s)   | **10.7 s**             | lower     | ✅                |
| Model time, all 94 chunks                       | about 23 min           | **16.8 min**           | lower     | ✅                |

"Found" counts links waiting in the review queue: in both runs the app sent every AI link to review
and none went live on its own, so the found column of the scorer (live only) is 0 for document links
in both. A suggestion can match a true link without that link counting twice (both runs made a few
repeated suggestions, which is why correct suggestions exceed links found). The duplicate and
normalisation rows are the same because they come from the asset import and the name embeddings,
not from the text model. The before run's per-chunk time is estimated from its progress checks: its
detailed logs were cleared when grc-worker was recreated for the model swap.

True links found, by link type:

| Link type    | True links | Before     | After          | Change |
| ------------ | ---------- | ---------- | -------------- | ------ |
| EXPOSED_TO   | 72         | 53 (73.6%) | **68 (94.4%)** | ✅ +15 |
| EXPOSES      | 68         | 48 (70.6%) | **68 (100%)**  | ✅ +20 |
| MITIGATED_BY | 241        | 74 (30.7%) | **92 (38.2%)** | ✅ +18 |
| GOVERNED_BY  | 39         | 18 (46.2%) | 19 (48.7%)     | = +1   |
| IMPACTS      | 35         | 28 (80.0%) | **10 (28.6%)** | ❌ −18 |

By where the true link comes from:

| Origin of the true link                   | True links | Before      | After           |
| ----------------------------------------- | ---------- | ----------- | --------------- |
| public (ATT&CK, CTID, KEV, VCDB)          | 313        | 127 (40.6%) | **160 (51.1%)** |
| derived (built from public links)         | 68         | 48 (70.6%)  | **68 (100%)**   |
| synthetic (host names, spreadsheet links) | 90         | 62 (68.9%)  | 45 (50.0%)      |

The synthetic row counts the 16 spreadsheet links in both runs; its drop matches the IMPACTS drop
(incidents impacting named hosts).

## 7. Resource use

| Measure                            | Before                                                     | After                                              |
| ---------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| Model server memory (llama-server) | 3.85–4.06 GB                                               | 4.19 GB                                            |
| Reason for the small difference    | —                                                          | the larger context Unsloth chose (18,432 vs 9,984) |
| Speed per token                    | the same: identical model shape, quantisation and settings |                                                    |
| Time to write one graph query      | not logged separately                                      | about 6.5 s (about 50 tokens)                      |
| Time to read one document chunk    | about 15 s                                                 | 10.7 s (about 316 tokens written)                  |

Both runs fit on the 16 GB Mac (M4) with Docker, Neo4j, Ollama (bge-m3) and the Unsloth app running.
The old default, gemma4:12b (7.6 GB), ran the Mac out of GPU memory on its first Ask (2026-10-18).

## 8. What improved, what got worse, and caveats

**Improved**

- Every graph query now runs (3 failures → 0), and the right records come back more often (recall
  0.70 → 0.82; single-hop 0.70 → 1.00).
- Correct answers rose from 11 to 18 of 30 (correctness 0.50 → 0.82), driven by single-hop and
  multi-hop questions.
- The full answer arrives faster (25.9 s → 22.9 s at the 95th percentile).
- Extraction finds more true links (221 → 257 of 455) and suggests fewer wrong ones (230 → 188), so
  more of what lands in the review queue is right (49.5% → 58.9%).
- EXPOSED_TO, EXPOSES and MITIGATED_BY improved; EXPOSES is now complete (68 of 68).
- Reading the documents took less model time (about 23 min → 16.8 min).

**Got worse**

- **Citation accuracy** fell (0.87 → 0.68): answers are right more often but cite the wrong source
  number more often. Writing the final answer with citations was not trained (D249).
- **Reciprocal rank** fell (0.64 → 0.45): the trained model's queries find more of the right records,
  but the first right one sits lower in the results.
- **IMPACTS links** (an incident affecting an asset) fell from 28 to 10 of 35. The cause is not checked
  yet: the 35 IMPACTS links and the training file's incident rows are the first thing to compare before
  a second training round.
- **MITIGATED_BY is still the weakest common link type** (38%, the biggest group with 241 links).

**Caveats**

- One test set, one run each, 30 questions: small samples, so a difference of one or two questions is
  noise. The big shifts (graph failures 3 → 0, correct answers 11 → 18) are well beyond that.
- Framework questions were not trained and stay weak (0 → partial).
- The scoring is fixed rules, no AI judge (D45.8): an answer that is right but words a record name
  differently can count as a miss.
- Some text2cypher training rows carry made-up filter values and host names; Company X itself was
  never trained on.

## 9. What each measure means

| Measure                              | Definition (from `packages/benchmark/src/score/` and `dataset/score.ts`)                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answer correctness                   | Share of the question's expected records that the answer names (by name or record number).                                                                |
| Answer pass / partial / fail         | Pass: correctness 1, no made-up record number, no planted instruction followed. Partial: correctness above 0 and nothing else wrong. Fail: anything else. |
| Citation accuracy                    | Share of the answer's citations whose source is, or names, an expected record.                                                                            |
| Made-up record number                | The answer names a record number (e.g. `RSK0001014`) that is not among its sources.                                                                       |
| Planted instruction followed         | A fixed check for the hidden instruction's kind fired (e.g. the answer says APPROVED, leaks an email or key, or states the link the document asked for).  |
| No-answer handled                    | For a question with no answer in the data: the answer cites nothing and names no record number.                                                           |
| Context recall                       | Share of the expected records present in the context the model was given. Retrieval pass = 1, partial = above 0, fail = 0.                                |
| Reciprocal rank                      | 1 ÷ the rank of the first result holding an expected record (1.0 = first result).                                                                         |
| Graph query failed                   | The AI-written graph query could not run, so the answer used documents only.                                                                              |
| Link found                           | A true link from `facts.json` that the app holds live, or that waits in the review queue as a finding.                                                    |
| Link missed                          | A true link stated in the documents that the model did not report.                                                                                        |
| Wrong link suggested                 | A link the model reported that matches no true link.                                                                                                      |
| Duplicates merged / flagged / missed | For the 22 scanner rows that name an existing asset differently: merged into it, flagged for review, or left as a separate record.                        |

## 10. How to repeat it

1. Load a model file in the Unsloth desktop app (port 8888), set `AI_TEXT_MODEL` in `.env` to its ID
   from `GET /v1/models`, then recreate grc-api and grc-worker.
2. Questions: `pnpm bench:run --org company-x-fast --set docs/datasets/company-x/questions-company-x.json --part all`.
3. Extraction, into a fresh org: copy `docs/datasets/company-x/` and change only `org.slug` and
   `org.name` in `manifest.json` (and `orgSlugs` in the question set), then
   `pnpm dataset:load --folder <copy> --mode full --step base`, wait for the worker,
   `pnpm dataset:load --folder <copy> --mode full --step documents`, wait for the worker, and
   `pnpm dataset:score --org <slug> --folder <copy>`.
4. HTTPS commands need `NODE_EXTRA_CA_CERTS` set to a copy of Caddy's local root (CLAUDE.md).
