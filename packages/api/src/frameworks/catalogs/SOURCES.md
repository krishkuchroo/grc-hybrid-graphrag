# Framework catalog sources

Written by `packages/infra/scripts/build-framework-catalogs.ts` (S2-002, D20, D212). Rebuild it rather than editing it by hand.

These six files are the whole framework content the app has. The app never downloads anything (D63): the loader copies them into every org’s graph. Each file keeps its `source` beside its data.

## Licences

- NIST SP 800-53 Rev. 5: A work of the US Government (NIST): public domain in the United States. Control IDs, titles and statements are kept as NIST publishes them.
- NIST Cybersecurity Framework 2.0: A work of the US Government (NIST): public domain in the United States. Subcategory IDs and outcomes are kept as NIST publishes them; the short titles are ours, cut from the outcome.
- ISO/IEC 27001 2022: Copyright ISO/IEC. Only the Annex A control IDs and titles are used; every description is written by us. No text of the standard is copied.
- SOC 2 Trust Services Criteria 2017 (revised points of focus 2022): Copyright AICPA, all rights reserved. Only the criterion IDs are used; every title and description is written by us. No AICPA text is copied.
- NIST's mappings: A NIST-authored mapping (a work of the US Government: public domain in the United States). No third-party OLIR submission is used.
- No SCF content is used (D20).

## How to rebuild

1. Download each NIST file listed in `packages/infra/scripts/framework-sources.json` into a folder outside the repo, under its `file` name, for example `curl -fsSL -o <dir>/<file> <url>`. Never commit the originals.
2. Update `downloadedOn` (and `release`, if NIST published a new one) in `framework-sources.json`.
3. Run `pnpm --filter infra exec tsx scripts/build-framework-catalogs.ts --sources <dir>`. It checks every source, writes the four NIST files and this page, and checks all six files with `readCatalogFiles`. The same downloads give byte-identical files.
4. The ISO 27001 and SOC 2 files are written by hand: edit them directly, then rebuild to refresh this page.

## Catalogs

### nist-800-53.json

- Framework: NIST SP 800-53 Rev. 5 (`nist_800_53`)
- Requirements: 1014
- Publisher: NIST
- Author: NIST
- Document: Electronic (OSCAL) Version of NIST SP 800-53 Rev 5.2.0 Controls and SP 800-53A Rev 5.2.0 Assessment Procedures
- URL: <https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json>
- Release: 5.2.0
- Downloaded on: 2026-10-15
- SHA-256: `01f37cf90ea99d92242c936cbfbdebcc338eef1f71454e2acac36cc56e9bc062`
- Saved as: `NIST_SP-800-53_rev5_catalog.json`

### nist-csf-2.json

- Framework: NIST Cybersecurity Framework 2.0 (`nist_csf_2`)
- Requirements: 106
- Publisher: NIST
- Author: NIST
- Document: The NIST Cybersecurity Framework (CSF) 2.0 (NIST CSWP 29), JSON export of NIST's Cybersecurity and Privacy Reference Tool
- URL: <https://csrc.nist.gov/extensions/nudp/services/json/nudp/framework/version/csf_2_0_0/export/json?element=all>
- Release: 2.0
- Downloaded on: 2026-10-15
- SHA-256: `de36759d2f3f70a0f28ab9a95505259e568467923295a13d510a068939773e5a`
- Saved as: `csf-2.0-cprt-export.json`

### iso-27001.json

- Framework: ISO/IEC 27001 2022 (`iso_27001`)
- Requirements: 93
- Publisher: ISO/IEC
- Author: project
- Document: ISO/IEC 27001:2022 Information security, cybersecurity and privacy protection — Information security management systems — Requirements (Annex A control IDs and titles; descriptions written by the project)
- URL: <https://www.iso.org/standard/27001>
- Release: 2022
- Downloaded on: not downloaded (written by hand)
- SHA-256: none (written by hand)

### soc-2.json

- Framework: SOC 2 Trust Services Criteria 2017 (revised points of focus 2022) (`soc_2`)
- Requirements: 61
- Publisher: AICPA
- Author: project
- Document: 2017 Trust Services Criteria for Security, Availability, Processing Integrity, Confidentiality, and Privacy (with revised points of focus, 2022) (criterion IDs only; titles and descriptions written by the project)
- URL: <https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022>
- Release: 2017 (revised points of focus 2022)
- Downloaded on: not downloaded (written by hand)
- SHA-256: none (written by hand)

## Mappings

Only NIST-authored mappings are imported (D212 (1)). NIST’s spreadsheets cite 800-53 controls by the zero-padded label (`AC-02(01)`) that the OSCAL catalog publishes on the same control as its plain label (`AC-2(1)`, our code), so each end is found through the catalog’s own labels; no ID is rewritten. A pair is left out, and counted here, when an end is withdrawn, isn’t in our catalogs, or names something that isn’t a requirement in them (an 800-53 family, a CSF function or category, or a clause of ISO 27001’s main body, 4 to 10, as our ISO catalog is Annex A only).

### map-csf-2-to-800-53.json

- Direction: `nist_csf_2` to `nist_800_53` (the citing framework to the cited one)
- Mappings kept: 736, from 746 relationship rows
- Pairs left out because an end isn't in our catalogs: 10
  - An end withdrawn: 1 (`RA-04`)
  - An end not in the catalog: 0 (none)
  - An end that isn't a requirement: 9 (`CP`, `IR`, `PT`, `RC.RP`, `RS.MA`)
- Repeated rows merged: 0
- Publisher: NIST
- Author: NIST
- Document: Cybersecurity Framework v2.0 to SP 800-53 Rev. 5.2.0, NIST's informative reference in the OLIR catalog (reference 186, developer: NIST)
- URL: <https://csrc.nist.gov/csrc/media/projects/olir/documents/submissions/Cybersecurity_Framework_v2-0_Concept_Crosswalk_800-53_5_2_0_draft.xlsx>
- Release: 1.0.0
- Downloaded on: 2026-10-15
- SHA-256: `5521fa73ace64d8a3014a7b1e971f0f20d32df5ff5e174632723bda09e7e908f`
- Saved as: `Cybersecurity_Framework_v2-0_Concept_Crosswalk_800-53_5_2_0_draft.xlsx`

### map-800-53-to-iso-27001.json

- Direction: `nist_800_53` to `iso_27001` (the citing framework to the cited one)
- Mappings kept: 439, from 643 relationship rows
- Pairs left out because an end isn't in our catalogs: 204
  - An end withdrawn: 0 (none)
  - An end not in the catalog: 0 (none)
  - An end that isn't a requirement: 204 (`4.1`, `4.2`, `4.3`, `4.4`, `5.1`, `5.2`, `5.3`, `6.1.1`, `6.1.2`, `6.1.3`, `6.2`, `7.1`, `7.2`, `7.3`, `7.4`, `7.5.1`, `7.5.2`, `7.5.3`, `8.1`, `8.2`, `8.3`, `9.1`, `9.2`, `9.2.1`, `9.2.2`, `9.3.1`, `9.3.2`, `9.3.3`, `10.1`, `10.2`)
- Repeated rows merged: 0
- Publisher: NIST
- Author: NIST
- Document: SP 800-53 Rev. 5 to ISO/IEC 27001:2022, NIST's mapping in the OLIR catalog (reference 155, developer: NIST)
- URL: <https://csrc.nist.gov/csrc/media/Projects/olir/documents/submissions/sp800-53r5-to-iso-27001-mapping-2022-OLIR-2023-10-12-UPDATED.xlsx>
- Release: 1.0.0
- Downloaded on: 2026-10-15
- SHA-256: `e631de234a1fac057991773f015c221226940540f5602e1b70a3768eaff5cbd9`
- Saved as: `sp800-53r5-to-iso-27001-mapping-2022-OLIR-2023-10-12-UPDATED.xlsx`

## No SOC 2 mappings

No SOC 2 cross-framework links are imported (D212 (4)). Gemma suggests them in S4 and the Analyst approves them in S5; S2 loads the SOC 2 criteria for hand mapping only.
