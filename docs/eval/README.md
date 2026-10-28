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
