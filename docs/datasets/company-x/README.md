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

What works today:

1. **Asset lists:** in Data intake, upload `x-cmdb-export.csv` (source `Company X CMDB`), then `x-vuln-scanner.csv` (source `Company X Vulnerability Scanner`). Match the columns as `import-mappings.json` says. Score the result against `normalisation.json` (stored values) and `duplicates.json` (did the scanner's spellings become duplicates, or get flagged as possible duplicates?).
2. **Documents:** upload each file in `sources/documents/` with the kind `documents.json` gives. This needs Ollama: bge-m3 for search and Gemma for extraction. The Analyst then works the review queue. Score the links that went live against `facts.json`.
3. **Framework mappings:** on each control's page, add the 800-53 requirement `framework-mappings.json` names.
4. **Questions:** `pnpm bench:run --org company-x --set docs/datasets/company-x/questions-company-x.json --part all` runs every question in hybrid and vector-only mode and stores the run on the Benchmark screen.

What's missing:

- **An org to load into.** `pnpm org:create` makes the org, but its Admin can't sign in until self-service sign-up (D233) or S7 is built. Loading into a demo org instead mixes the demo records into every answer.
- **A loader.** Steps 1–3 are about 90 uploads and clicks by hand. `pnpm gen:data`'s full-pipeline mode already pushes asset lists and uploads documents through the API with a short-lived key. Pointing it at this folder would load Company X in one command.
- **Scoring for ingestion.** `bench:run --part extraction` accepts only generated question sets on `gen-…` orgs. Scoring extraction, duplicates and normalisation against this folder's keys needs its own small checker.

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
