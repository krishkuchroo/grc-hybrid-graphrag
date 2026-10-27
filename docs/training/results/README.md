# Training results

Everything each training of Qwen3.5-4B produced and how it scored, in one place. How to train is in
`docs/training/README.md`.

## The models

| Model            | Run tag    | Trained on                                                                                                         | Notebook check (held-out rows)        | Company X test                                  | Status              |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------- | ------------------- |
| Base (untrained) | —          | —                                                                                                                  | —                                     | questions 11 / 0 / 19; links found 48.6%        | before-test only    |
| Round 1          | `b8db12cb` | 3,000 rows of real public data, Colab T4, 673 steps (D255)                                                         | `validation/validation-b8db12cb.json` | questions 18 / 7 / 5; links found 56.5%         | replaced            |
| Round 2          | `3a062cbd` | 4,423 rows: round 1's plus IMPACTS, dense, GOVERNED_BY, framework and chat-answer rows; Colab L4, 991 steps (D258) | `validation/validation-3a062cbd.json` | questions **20 / 8 / 2**; links found **76.7%** | **the app's model** |

Questions are pass / partial / fail of 30. The full comparison is in `before-after-company-x.md`.

## What is where

| Path                                            | What                                                                                  | In git                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------- |
| `before-after-company-x.md`                     | the Company X test for all three models: verdict, every measure, what changed and why | yes                                      |
| `validation/validation-<tag>.json`              | the notebook's check of each training on its own held-out rows                        | yes                                      |
| `raw/`                                          | the full benchmark and scoring reports (question and answer texts)                    | no (git-ignored, like `data/benchmark/`) |
| `~/models/grc/qwen3.5-4b-*.gguf`                | the model files, 2.6 GB each                                                          | no (model files are never committed)     |
| Drive `grc-training/` (krishkuchroo1@gmail.com) | training files, checkpoints, adapters and `progress-<tag>.txt`                        | no                                       |

## Raw reports in `raw/`

| File                                                          | Model   | What                                                                        |
| ------------------------------------------------------------- | ------- | --------------------------------------------------------------------------- |
| `questions-base-d8774415-….json`                              | base    | the 30 questions on `company-x-fast`                                        |
| `questions-r1-45d9a15c-….json`                                | round 1 | the same                                                                    |
| `questions-r2-25dbd5dc-….json`                                | round 2 | the same                                                                    |
| `extraction-base-dataset-company-x-20261026T165413Z.json`     | base    | extraction score, org `company-x`                                           |
| `extraction-r1-dataset-company-x-after-20261026T180110Z.json` | round 1 | extraction score, org `company-x-after`                                     |
| `extraction-r2-dataset-company-x-r2-20261027T224937Z.json`    | round 2 | extraction score, org `company-x-r2`                                        |
| `not-used-questions-base-org-company-x-693da148-….json`       | base    | an early run on `company-x`, where 20 of 30 questions could not be resolved |
| `not-used-questions-r2-small-context-c54ca767-….json`         | round 2 | run with the context at 3,328 tokens and 4 slots; rerun at 18,432           |

New benchmark runs still write to `data/benchmark/`; copy a training test's reports here with these
names.
