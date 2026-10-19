# Company X: a test org built from public data

Company X is one organisation's GRC data, assembled from public datasets that publish their own answers.
It lets us run the product on data nobody wrote for it, then check the results against those answers:
whether ingestion found the right links, removed duplicates and normalised values, and whether chat
answers are right (hybrid against vector-only).

No single public GRC benchmark exists, so Company X is assembled from several datasets that share one
key, the MITRE ATT&CK technique ID.

```
CISA KEV vulnerability ──CTID──▶ ATT&CK technique ──CTID──▶ NIST 800-53 control ──NIST──▶ CSF 2.0 / ISO 27001
(vendor + product)                     ▲                       (moderate baseline)         (crosswalks already
                                       │ CTID                                                in the app, S2)
VERIS breach record (VCDB) ────────────┘
```

## What's in it

| Records                 | Count | From                                                                                                                                                                                                              |
| ----------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assets                  |    22 | 12 real products on CISA's KEV list (Exchange, SharePoint, FortiGate, NetScaler, Ivanti Connect Secure, vCenter, Veeam, Confluence, ManageEngine, Windows laptops, Office, Acrobat) plus 9 hosts and one database |
| Risks                   |    39 | The ATT&CK techniques that those products' exploited vulnerabilities enable, as mapped by CTID                                                                                                                    |
| Controls                |    39 | NIST SP 800-53 moderate-baseline controls that CTID maps as mitigating those techniques                                                                                                                           |
| Policies                |    10 | One per 800-53 control family in use                                                                                                                                                                              |
| Incidents               |    30 | Real breach records from the VERIS Community Database whose attack types reach Company X's risks                                                                                                                  |
| Documents               |    52 | 12 vulnerability assessment reports, 10 policies, 30 SOC tickets                                                                                                                                                  |
| Asset lists             |     2 | A CMDB export and a vulnerability-scanner export of the same estate, spelled differently                                                                                                                          |
| Questions               |    30 | 10 single-hop, 8 multi-hop, 6 framework, 4 no-answer, 2 injection traps                                                                                                                                           |
| Links in the answer key |   471 | HOSTS 7, RUNS 9, EXPOSED_TO 72, MITIGATED_BY 241, GOVERNED_BY 39, IMPACTS 35, EXPOSES 68                                                                                                                          |

`manifest.json` holds the exact counts, every input's URL, pinned version and SHA-256, and the licences.

## Real, derived and synthetic

Every record and link says where it came from in `provenance.json`, so each score can be split into
"checked against published data" and "checked against what we generated".

| Link                       | Origin    | Basis                                                                                                      |
| -------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| Asset EXPOSED_TO Risk      | public    | CTID maps the product's KEV vulnerability to the technique (exploitation or primary impact)                |
| Risk MITIGATED_BY Control  | public    | CTID maps the 800-53 control as mitigating the technique                                                   |
| Incident EXPOSES Risk      | derived   | The VCDB record's hand-coded attack types, related to the technique by CTID's VERIS mapping ("related to") |
| Control GOVERNED_BY Policy | synthetic | 800-53's own rule: each family's "-1 Policy and Procedures" control governs that family                    |
| Asset HOSTS / RUNS Asset   | synthetic | Company X's chosen server layout                                                                           |
| Incident IMPACTS Asset     | synthetic | The VCDB record's asset kind (for example "S - Mail"), placed on Company X's asset of that kind            |

Record field values (criticality, risk scores, control status, dates) are generated from documented
rules, listed per record in `provenance.json`. The text of the documents mixes real and written content:

- **Vulnerability reports:** CISA's KEV entries and CTID's notes on how each vulnerability is exploited (real), plus one sentence per exposure (written).
- **Policies:** 800-53's own control statements (real), plus purpose, scope and one sentence per governed control and per mitigation (written).
- **SOC tickets:** the VCDB summary and coded fields, word for word, with attribution (real), plus one sentence per impact and per exposed risk (written).

Every link is stated in at least one file, in one sentence that names both ends (D39's same-sentence rule).
`facts.json` lists, for every link, the file and sentence that state it.

## Files

All of these except the script are built by it and kept out of git (see "What's in git").

| File                         | What it is                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `answer-key.json`            | The truth, in `pnpm gen:data`'s answer-key format (checked with the benchmark's own `parseAnswerKey`)             |
| `questions-company-x.json`   | The question set for `pnpm bench:run` (hand-written type, checked with `questionSetSchema`)                       |
| `sources/asset-lists/`       | `x-cmdb-export.csv` and `x-vuln-scanner.csv`, to upload as asset lists                                            |
| `sources/documents/`         | The 52 documents, to upload as Audit report, Policy document or SOC ticket (`documents.json` says which)          |
| `import-mappings.json`       | Each asset list's column mapping (checked with `importMappingSchema`)                                             |
| `framework-mappings.json`    | Which 800-53 requirement each control satisfies, and the CSF and ISO requirements NIST's crosswalks reach from it |
| `facts.json`                 | Every link, its origin, and the file and sentence that state it: the extraction score's key                       |
| `duplicates.json`            | Which scanner rows are the same asset as a CMDB row, and the names KEV gives each product                         |
| `normalisation.json`         | Every messy value in the asset lists and the stored value it must become (`Network Device` → `network_device`)    |
| `plants.json`                | The two planted prompt injections and where they are                                                              |
| `provenance.json`            | Where every record and link came from                                                                             |
| `manifest.json`              | Inputs, pinned versions, SHA-256s, licences, counts                                                               |
| `scripts/build-company-x.ts` | The script that builds all of the above                                                                           |

## Rebuilding

From the repository root:

```
node --experimental-transform-types --disable-warning=ExperimentalWarning \
  docs/datasets/company-x/scripts/build-company-x.ts
```

- The first run downloads about 6 MB into `data/generated/public-sources/`, which git ignores (D81). Later runs reuse it (`--offline` to forbid downloads, `--refresh` to download again).
- The CTID mappings, the moderate baseline and VCDB are pinned to one commit each. CISA's feed isn't versioned, so its `catalogVersion` and SHA-256 are recorded instead.
- The same inputs and `--seed` always write byte-identical files (D45.8).
- Options: `--seed N` (default 1), `--org-name "Company X"`, `--org-slug company-x`.
- The script checks its own output with the app's validators and runs Prettier on the folder, so `pnpm lint` stays clean.

## Running it against the app

Two commands load the folder and score what the app made of it. They work for any folder in this format:
the org's slug and name come from `manifest.json`, and the whole folder is checked before anything is made
(each problem names the file and the field, the command exits with 2, and nothing is made).

### Loading: `pnpm dataset:load`

```
pnpm dataset:load --folder docs/datasets/company-x --mode full|fast --step base|documents \
  [--org <existing org slug>] [--base-url https://grc.localhost]
```

- **Two orgs (D235):**
  - `--mode full` loads org `company-x` (named as in `manifest.json`) through the real intake. This measures ingestion.
  - `--mode fast` loads org `company-x-fast` ("Company X (fast load)") straight from the answer key: a perfect graph, for measuring chat answers.
  - Each org's Admin is `admin@<slug>.example`.
- **`--step base`** (first):
  - full: makes the org; then, with a 1-hour Admin key at Restricted that is revoked however the run ends, pushes the two asset lists with the column mappings in `import-mappings.json` (the CMDB first, so its assets are the older ones a merge keeps), creates every risk, control, policy and incident of the answer key through the record API (no links between them: finding those is the documents' job), and adds the framework mappings.
  - fast: makes the org, writes every record and link of the answer key, adds the framework mappings, and checks the org's audit chain.
  - Duplicate checks start only once bge-m3 has embedded the record names, so they need Ollama running.
- **`--step documents`** (later, on its own): uploads the 52 documents with the kinds `documents.json` gives. In full mode the worker reads, embeds and extracts them, and the Analyst works the review queue; in fast mode they are only read and embedded. It is refused, with nothing sent, until the org exists and the models answer: bge-m3 on Ollama, and in full mode also the text model on the provider `AI_TEXT_PROVIDER` picks (Ollama's model list, or `GET <AI_TEXT_BASE_URL>/models` with the key).
- **`--org <slug>`** loads into an org that already exists instead, in either mode and either step, and never makes one. It is refused when no org has that slug, or when the org has no Admin who holds Restricted. A record whose exact name its kind already has is skipped.
- **Re-runs add nothing:** the mappings come back unchanged, the asset-list batches and the uploads as repeats, the records skipped by name, the framework mappings as already there.

### Scoring: `pnpm dataset:score`

```
pnpm dataset:score --org company-x|company-x-fast --folder docs/datasets/company-x [--base-url https://grc.localhost]
```

It reads the org through the API with a 1-hour Admin key (revoked at the end; nothing in the org changes) and scores:

- **Links** against `facts.json`: each fact found (a live link, of any origin), waiting (a pending finding) or missed, per link type and per origin (public, derived, synthetic), and the extra live links no fact has.
- **Duplicates** against `duplicates.json`: each scanner row merged into the right asset, flagged as a possible duplicate (by the finding's status), merged into the wrong one, missed, or not imported.
- **Normalisation** against `normalisation.json`: each stored value matches, differs, or wasn't imported.

On `company-x-fast` no asset lists went in, so duplicates and normalisation show "not applicable". The output holds counts and ratios only; the full report, with names and sentences, goes to `data/benchmark/dataset-<slug>-<UTC time>.json` (kept out of the repository, D81).

### Questions

`pnpm bench:run --org company-x --set docs/datasets/company-x/questions-company-x.json --part all` (or `--org company-x-fast`) runs every question in hybrid and vector-only mode and stores the run on the Benchmark screen. The question set names both orgs.

What's missing:

- **An org to load into.** `pnpm org:create` makes the org, but its Admin can't sign in until self-service sign-up (D233) or S7 is built. Loading into a demo org instead mixes the demo records into every answer.

## Licences and attribution

- **CISA Known Exploited Vulnerabilities catalog:** a work of the US Government (CISA).
- **Center for Threat-Informed Defense Mappings Explorer:** Apache-2.0. ATT&CK® technique names © The MITRE Corporation, used under MITRE's ATT&CK terms of use.
- **NIST SP 800-53 Rev. 5, SP 800-53B, CSF 2.0 and NIST's crosswalks:** works of the US Government (NIST), public domain in the United States.
- **ISO/IEC 27001:2022:** IDs and titles only, as in `packages/api/src/frameworks/catalogs/SOURCES.md`.
- **VERIS Community Database:** CC BY-SA 4.0. The SOC tickets quote VCDB summaries and name each record's incident ID. Material adapted from VCDB must be shared under the same licence.

## What's in git

Only this README and `scripts/build-company-x.ts`. The plan never pushes generated test data (D81),
so git ignores every built file; run the build (above) to make them. A rebuild uses the downloads
cached in `data/generated/public-sources/`. On a machine without them, CISA's feed is downloaded
fresh and may have changed since; `manifest.json`'s SHA-256s show whether it did.
