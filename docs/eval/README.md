# Measuring Ask's answers (D261, track A)

These commands check whether Ask's answers are right using fixed rules only. No AI judges the answers (D45.8).
The questions come from a dataset folder's answer key (Company X first), so every right answer is known before the run.

Every command here that uses the model or the running app is yours to run. The generator itself only reads files and writes two.

## The question set and its checks file

`pnpm eval:questions` turns a dataset folder into two files under `data/generated/eval/questions/`. Git ignores both (D81).

- **The question set** (`<slug>-<count>-seed<seed>.json`): a hand-written-type set naming both orgs the folder loads into (`company-x` and `company-x-fast`). `pnpm bench:run` runs it as it is.
- **The checks file** (`<slug>-<count>-seed<seed>.checks.json`), beside it. For each question it gives:
  - its group (the one fact it asks about);
  - its fine kind and wording;
  - the kinds of record it asks for;
  - the correct graph query;
  - the names an answer must not show (empty for now: the changed-data test fills this list).

Each fact is asked three ways (plain, loose and typo), so the three answers of a group should name the same records.
Question IDs are `<group>.<wording>`, for example `mitigated_by-03.loose`.

### Kinds

| Fine kind      | Asks                                                                                                   | Set kind         | Share of the groups |
| -------------- | ------------------------------------------------------------------------------------------------------ | ---------------- | ------------------: |
| `mitigated_by` | the controls that mitigate a risk                                                                      | `single_hop`     |                 20% |
| `two_step`     | two links: an asset's or an incident's risks' controls, or the policies governing a risk's controls    | `multi_hop`      |                 20% |
| `impacts`      | the incidents that impacted an asset                                                                   | `single_hop`     |                 16% |
| `governs`      | the controls a policy governs                                                                          | `single_hop`     |                 16% |
| `framework`    | a control's 800-53 requirement plus the CSF 2.0 and ISO 27001 ones NIST's crosswalks reach             | `framework`      |                 16% |
| `no_answer`    | a made-up risk or asset (the answer should say nothing matches)                                        | `no_answer`      |                  8% |
| `injection`    | an asset whose document carries a planted instruction (the answer should ignore it)                    | `injection_trap` |                  4% |
| `fixed`        | a failure you found by hand, kept word for word so every run asks it again (none yet; they come first) | its own          |                   – |

When a kind has fewer facts than its share (Company X has only 7 assets with incidents), it takes all it has, and the rest passes to `mitigated_by`, `two_step`, `framework` and `no_answer` in turn.

### Wordings

| Wording    | How it reads                                                                                                         | Example                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `plain`    | the hand-written set's wording, with the record's full name                                                          | Which controls mitigate Valid Accounts? |
| `loose`    | how a person might ask it, with the name's short form                                                                | How are we covered for valid accounts?  |
| `typo`     | the plain wording with the short form, lowercased, two letters swapped in one word and one letter dropped in another | wihch controls mitigate valid acounts?  |
| `reported` | a fixed template's own words                                                                                         |                                         |

A name's short form is the part after its last `": "`, or the name without its first word, or the name itself: the first of these that only one record of that kind contains.

## `pnpm eval:questions`

```
pnpm eval:questions --folder <dataset folder> [--count 150] [--seed 1] [--out <file>]
```

- `--folder`: a dataset folder in the answer-key format, such as `docs/datasets/company-x`. It needs `plants.json` as well as the files `pnpm dataset:load` reads.
- `--count`: the questions asked for, from 30 to 200 (the question-set limit; default 150). The fixed questions come first, then groups of three. A remainder under 3 makes no group, and the output says how many were written.
- `--seed`: a whole number from 0 (default 1). The same folder, count and seed always write byte-identical files; another seed picks other facts and wordings.
- `--out`: the set's path, a `.json` file under `data/generated/` but not under `data/generated/training/` (Company X is never training data, D234). The default is `data/generated/eval/questions/<slug>-<count>-seed<seed>.json`. The checks file goes beside it. Both replace earlier files with the same names.

Before anything is written, every correct graph query is checked with Ask's own query rules. A refused query stops the command with exit 1 and names the question ID.
Bad arguments, or a folder that isn't valid, exit with 2. Nothing is written in either case.

The output gives the files written, the counts per kind and per wording, any shortfall and the groups dropped. It never prints a question, a name or a query (D164).

## The baseline

You run these commands. The HTTPS one needs `NODE_EXTRA_CA_CERTS` set to a copy of Caddy's root (CLAUDE.md, "HTTPS commands on the Mac").
Load the trained model in the Unsloth app with Context Length 18432 and Parallel Slots 1 (D259).

```
pnpm eval:questions --folder docs/datasets/company-x
pnpm bench:run --org company-x-fast --set data/generated/eval/questions/company-x-150-seed1.json --part all
```

A 150-question run in both modes asks for 300 chat answers: about 2 to 3 hours at D259's speeds. `--modes hybrid` halves that, but loses the hybrid-against-vector comparison.

## Where the results go

- The question set and its checks file: `data/generated/eval/questions/` (git-ignored).
- Each run: the Benchmark screen at https://grc.localhost, and the full report, with the questions and answers, in `data/benchmark/<run ID>.json` (git-ignored).

## Reading the scores

When the checks file sits beside the set, `pnpm bench:run` scores the run against it after the run ends, while its key is still live. The scores print under "Evaluation (checks file)", after the run's usual output, as counts and scores only. The full detail goes into the report file's `evaluation` block (`data/benchmark/<run ID>.json`, report version 2).

If the checks file is broken, or its question IDs aren't the set's in the same order, the run is refused before anything is made (exit 2, naming the field). Without a checks file the run works as before. With `--part extraction` the checks file is ignored, and one line says so.

- **Breakdown by fine kind and by wording.** The run's usual scores, worked out again for the questions of one fine kind, then for those of one wording. On screen, per mode, the answers part:
  - the answers (`n`) and pass/partial/fail/skipped;
  - the mean answer correctness and made-up record numbers;
  - the no-answer rule and planted instruction followed, where those questions are in the slice;
  - the 95th-percentile first words and full answer.

  The report holds both parts (search and answers). A stale answer (below) counts as a fail here.

- **Consistency.** The three wordings of one fact should name the same records. For each answer, the evaluation lists the org's records of the question's target kinds that it names, by number or by name. A group is measured in a mode when at least 2 of its answers were scored. An answer isn't scored when it was skipped, or failed with no answer. A group is consistent when every answer names exactly the same records, whether or not they are the right ones. The score is consistent groups ÷ measured groups, overall and per fine kind.
- **Execution accuracy** (hybrid only, apart from the answer score). Each hybrid answer's own graph query is compared with the question's correct graph query. Both are checked with Ask's query rules and run read-only, with Ask's limits, as the read-only query account of the run key's role and clearance. They never run as the admin or writer account. A result set is the records of the question's target kinds that the query returned, plus any returned name or number that matches exactly one such record. Outcomes:
  - `match`: the two result sets are equal;
  - `mismatch`: they differ;
  - `no_query`: the answer has no graph query;
  - `refused`: Ask's rules refuse the query, so it is never sent;
  - `failed`: it ran but timed out or failed.

  The score is match ÷ (match + mismatch + no_query + refused + failed), overall, per fine kind and per wording. Precision and recall compare the model's result set with the correct one.

- **Left out of the execution score:**
  - `gold_mismatch`: the correct query's own result isn't the question's expected records. The org's graph and the answer key disagree, so the model can't be judged on that question.
  - `gold_failed`: the correct query couldn't run.

  Both are counted on screen and listed by question ID in the report. Skipped answers are left out too.

- **Without `NEO4J_QUERY_SECRET`** there is no query account to run as. Execution accuracy then shows "not measured (NEO4J_QUERY_SECRET not set)", and the rest is still scored.
- **Stale answers** (shown only when some question has forbidden names, as in the changed-data test). An answer is stale when it shows a forbidden name: an old name of a renamed record, or an end of a deleted link. A control's old name right after its code, as in "AC-4 Information Flow Enforcement", is the catalog's own requirement title and doesn't count. The score per mode is stale answers ÷ scored answers of those questions, also split by why (`renamed`, `deleted_link`).

These scores stay in the command's output and the report file. The run stored on the API, its items and the Benchmark screen don't include them.
