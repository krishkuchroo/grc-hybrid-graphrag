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
  - the names an answer must not show (empty except on a changed folder: see "The changed-data test" below).

Each fact is asked three ways (plain, loose and typo), so the three answers of a group should name the same records.
Question IDs are `<group>.<wording>`, for example `mitigated_by-03.loose`.

### Kinds

| Fine kind      | Asks                                                                                                | Set kind         | Share of the groups |
| -------------- | --------------------------------------------------------------------------------------------------- | ---------------- | ------------------: |
| `mitigated_by` | the controls that mitigate a risk                                                                   | `single_hop`     |                 20% |
| `two_step`     | two links: an asset's or an incident's risks' controls, or the policies governing a risk's controls | `multi_hop`      |                 20% |
| `impacts`      | the incidents that impacted an asset                                                                | `single_hop`     |                 16% |
| `governs`      | the controls a policy governs                                                                       | `single_hop`     |                 16% |
| `framework`    | a control's 800-53 requirement plus the CSF 2.0 and ISO 27001 ones NIST's crosswalks reach          | `framework`      |                 16% |
| `no_answer`    | a made-up risk or asset (the answer should say nothing matches)                                     | `no_answer`      |                  8% |
| `injection`    | an asset whose document carries a planted instruction (the answer should ignore it)                 | `injection_trap` |                  4% |
| `fixed`        | a failure you found by hand, kept word for word so every run asks it again (they come first)        | its own          |                   – |

When a kind has fewer facts than its share (Company X has only 7 assets with incidents), it takes all it has, and the rest passes to `mitigated_by`, `two_step`, `framework` and `no_answer` in turn.

### Wordings

| Wording    | How it reads                                                                                                         | Example                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `plain`    | the hand-written set's wording, with the record's full name                                                          | Which controls mitigate Valid Accounts? |
| `loose`    | how a person might ask it, with the name's short form                                                                | How are we covered for valid accounts?  |
| `typo`     | the plain wording with the short form, lowercased, two letters swapped in one word and one letter dropped in another | wihch controls mitigate valid acounts?  |
| `reported` | a fixed template's own words                                                                                         |                                         |

A name's short form is the part after its last `": "`, or the name without its first word, or the name itself: the first of these that only one record of that kind contains.
The first two are skipped when they start with a joining word (a, an, and, as, at, by, for, from, in, into, of, on, or, the, to, via, with), so "Separation of Duties" is asked as "separation of duties", never "of duties" (D263).

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

## Adding a hand-found failure

When you find a question Ask gets wrong, add it as a fixed template so every later run asks it again (D261).
Each one is an entry in `FIXED_QUESTIONS`, in `packages/benchmark/src/eval/fixed-questions.ts`. The first is `phishing-findings`.

- **One entry per failure,** in your own words, word for word as you asked it (`text`), with a short `name`. Its question ID is `fixed-<name>.reported`, and it is its own group.
- **Named by answer-key keys** (`keys`), never by record names, such as `RSK-0036` and the incidents `INC-0002` and so on. A folder that lacks any of these keys leaves the entry out, and the output counts it.
- **Its expected rule** (`expected`): the records a right answer names, worked out from the folder's graph. For example, the risk plus every incident with EXPOSES to it.
- **Its target kinds** (`targetKinds`) and its set kind (`setKind`: `single_hop`, `multi_hop` or `framework`).
- **Its gold query** (`goldQuery`): the correct graph query, with each name inlined through `cypherString`. It returns `RETURN DISTINCT` of the target records only, and `pnpm eval:questions` checks it with Ask's own query rules before anything is written.
- **Left alone by the changed-data test:** `pnpm eval:changed` never renames the records or deletes the links of the entries' keys (`fixedQuestionKeys`), so the question still has its answer in the changed folder.
- **Asked by every later run:** every `pnpm eval:questions` run puts the fixed entries first, in their order in `FIXED_QUESTIONS`, then the generated groups. Each entry takes one of the questions asked for, so with one entry `--count 150` writes 1 + 49 groups of 3 = 148 questions.

Add a short note above the entry on what you saw (the wrong query, the answer, the timings), as the phishing entry has.

## The baseline

You run these commands. The HTTPS one needs `NODE_EXTRA_CA_CERTS` set to a copy of Caddy's root (CLAUDE.md, "HTTPS commands on the Mac").
Load the trained model in the Unsloth app with Context Length 18432 and Parallel Slots 1 (D259).

```
pnpm eval:questions --folder docs/datasets/company-x
pnpm bench:run --org company-x-fast --set data/generated/eval/questions/company-x-150-seed1.json --part all
```

A 150-question run in both modes asks for 300 chat answers: about 2 to 3 hours at D259's speeds. `--modes hybrid` halves that, but loses the hybrid-against-vector comparison.

## The changed-data test

This test catches answers that come from what the model learned in training instead of from the data.
`pnpm eval:changed` copies a dataset folder into a new one where some records have new, made-up names and some links are gone.
Questions are then made from the changed folder, and you load it into a fresh org.
An answer that still shows an old name, or a link that is no longer there, can't have come from that org's data.

### What changes

- **Renames** (8 by default): risks, controls, policies and incidents take turns, in that order.
  - Each gets a made-up name in the same style as the `no_answer` questions' names, matching no record's name, old or new.
  - The new name replaces the old one everywhere: in the answer key, the facts and their sentences, the provenance, the framework mappings, every document, the asset lists and the planted injections. Upper or lower case is matched; spacing must be the same.
  - Assets are never renamed: their names come from the asset lists and sit inside incident names.
  - Never renamed either: a record a fixed question rests on, an end of a planted injection's link, and a record whose name sits inside another record's name (or holds one), since changing it would change that other name too.
  - Every Company X incident name holds an asset's name, so on Company X no incident can be renamed, and the other kinds take its turns.
  - A control keeps its 800-53 code. The framework catalogs keep their own names, so `AC-17 Remote Access` still names the requirement.
- **Deletions** (20 by default): MITIGATED_BY, GOVERNED_BY, IMPACTS and EXPOSES links take turns, in that order.
  - The link leaves the answer key, the facts and the provenance. Each sentence that stated it is taken out of its document.
  - A link is only deleted when its sentences state no other link, neither end is renamed (or rests under a fixed question or a planted injection), and the record its question starts from (the risk, the policy, the asset or the incident) keeps at least one link of that type.
- **What it writes:** every file `pnpm dataset:load` reads, `sources/`, `plants.json`, and `changes.json`, which lists each rename (old name, new name, and a control's code) and each deletion (the link, its ends and the sentences removed).
  The manifest gets the new slug and the org name "<name> (changed)". The hand-written `questions-*.json` isn't copied, because it would be out of date.

Before it finishes, the command checks the written folder. No old name may be left anywhere (a control's name right after its 800-53 code is allowed), every deleted sentence must be gone, every other sentence must still be there word for word, and the folder must read back as a dataset folder.
A failed check exits with 1, names the file and the count, and leaves nothing behind.

```
pnpm eval:changed --from <dataset folder> --to <new folder under data/generated/> [--seed 1] [--renames 8] [--deletions 20] [--slug <slug>] [--replace]
```

- `--to`: a new folder under `data/generated/`, never under `data/generated/training/` (Company X is never training data, D234).
- `--renames`: 0 to 40. `--deletions`: 0 to 100. If too few records or links qualify, it makes as many as it can and says so.
- `--slug`: the new org's slug (default `<from slug>-changed`). Its fast-load org is `<slug>-fast`.
- `--replace`: replaces a `--to` folder that this command wrote before (one that holds `changes.json`). No other folder is ever removed.

Bad arguments, a `--to` that isn't allowed, or a `--from` folder that isn't valid exit with 2, and nothing is written.
The same `--from`, seed and counts always write byte-identical files. The output gives counts and paths only, never a name or a sentence.

### What counts as a stale answer

`pnpm eval:questions` on a changed folder reads its `changes.json` and fills each question's `forbidden` list in the checks file:

- **`renamed`:** the old name of each renamed record the question starts from, passes through (a two-step question's middle record) or expects. For a control, `exceptAfter` gives its code, because `AC-17 Remote Access` is still the requirement's real name.
- **`deleted_link`:** the far end of each deleted link that the question would have followed, for example the control a risk no longer has. It's left out when that record is still expected through another link, or when its name sits inside an expected record's name.

An answer that shows a forbidden name is stale. Questions touching a change come first within each kind, so the set tests the changes as much as it can.
The checks file's `changed` block gives the source slug and how many renames and deletions there were. The output says how many questions have forbidden names.

### Your commands

You run these, after EV-003 is merged. The `bench:run` and `dataset:load` commands need `NODE_EXTRA_CA_CERTS` set to a copy of Caddy's root (CLAUDE.md, "HTTPS commands on the Mac"). Load the trained model in the Unsloth app with Context Length 18432 and Parallel Slots 1 (D259).

```
pnpm eval:changed --from docs/datasets/company-x --to data/generated/eval/company-x-changed
pnpm dataset:load --folder data/generated/eval/company-x-changed --mode fast --step base
pnpm dataset:load --folder data/generated/eval/company-x-changed --mode fast --step documents
pnpm eval:questions --folder data/generated/eval/company-x-changed
pnpm bench:run --org company-x-changed-fast --set data/generated/eval/questions/company-x-changed-150-seed1.json --part all --wait
```

The fast load creates the org `company-x-changed-fast`. A 150-question run in both modes takes about 2 to 3 hours, as for the baseline.

## Where the results go

- The question set and its checks file: `data/generated/eval/questions/` (git-ignored).
- The changed folder: `data/generated/eval/<slug>-changed/` (git-ignored).
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
