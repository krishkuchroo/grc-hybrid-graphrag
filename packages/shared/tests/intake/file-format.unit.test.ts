// S3-001 criterion 2 (D53, D45.7 fail safe; S3 shared notes "Upload safety"): `detectFileFormat`
// checks the type by content, and the file name's extension must agree with it.
//   - PDF: the head starts with `%PDF-`.
//   - DOCX: a zip (`PK\x03\x04`) whose entry names hold `[Content_Types].xml` and `word/document.xml`.
//   - CSV, TXT: the whole file is UTF-8 with no NUL byte (`isUtf8Text`).
//   - JSON: as CSV and TXT, and the first non-space character is `{` or `[`.
//   - Any other zip, or any zip named `.zip`, is `zip`. A missing or unknown extension is
//     `unknown_type`. An empty head is `empty`. Extensions compare case-insensitively.
// The function is pure: the caller passes the head, the zip's entry names and the UTF-8 answer.
import { describe, expect, it } from 'vitest';
import { loadIntake, type DetectInput } from './load.js';

const enc = new TextEncoder();
const bytes = (text: string) => enc.encode(text);

const PDF_HEAD = bytes('%PDF-1.7\n%âãÏÓ\n1 0 obj\n');
const ZIP_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const DOCX_ENTRIES = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml'];
const XLSX_ENTRIES = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'];
const PLAIN_ZIP_ENTRIES = ['notes.txt', 'data/assets.csv'];
const EXE_HEAD = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const CSV_HEAD = bytes('sys_id,name,sys_class_name\nabc123,web01,cmdb_ci_server\n');
const TXT_HEAD = bytes('Access control policy\n\nAll staff must use MFA.\n');
const JSON_OBJECT_HEAD = bytes('{"rows":[{"id":"a1"}]}');
const JSON_ARRAY_HEAD = bytes('[{"id":"a1","name":"web01"}]');
const JSON_SPACED_HEAD = bytes('  \n\t [ {"id": "a1"} ]');

type Case = [string, DetectInput, { ok: true; format: string } | { ok: false; reason: string }];

const ok = (format: string) => ({ ok: true as const, format });
const no = (reason: string) => ({ ok: false as const, reason });

const CASES: Case[] = [
  // Each format, recognised by content and named to match.
  ['a PDF head named .pdf', { fileName: 'policy.pdf', head: PDF_HEAD, isUtf8Text: false }, ok('pdf')],
  [
    'a PDF head named .pdf that also decodes as UTF-8',
    { fileName: 'policy.pdf', head: bytes('%PDF-1.4\n'), isUtf8Text: true },
    ok('pdf'),
  ],
  [
    'a zip with the DOCX entries named .docx',
    { fileName: 'policy.docx', head: ZIP_HEAD, zipEntries: DOCX_ENTRIES, isUtf8Text: false },
    ok('docx'),
  ],
  ['UTF-8 text named .csv', { fileName: 'assets.csv', head: CSV_HEAD, isUtf8Text: true }, ok('csv')],
  ['UTF-8 text named .txt', { fileName: 'policy.txt', head: TXT_HEAD, isUtf8Text: true }, ok('txt')],
  [
    'UTF-8 starting with { named .json',
    { fileName: 'tickets.json', head: JSON_OBJECT_HEAD, isUtf8Text: true },
    ok('json'),
  ],
  [
    'UTF-8 starting with [ named .json',
    { fileName: 'assets.json', head: JSON_ARRAY_HEAD, isUtf8Text: true },
    ok('json'),
  ],
  [
    'UTF-8 JSON after leading white space',
    { fileName: 'assets.json', head: JSON_SPACED_HEAD, isUtf8Text: true },
    ok('json'),
  ],
  [
    'a name with several dots uses the last extension',
    { fileName: 'q3.report.v2.txt', head: TXT_HEAD, isUtf8Text: true },
    ok('txt'),
  ],

  // Upper-case and mixed-case extensions.
  ['an upper-case .PDF', { fileName: 'POLICY.PDF', head: PDF_HEAD, isUtf8Text: false }, ok('pdf')],
  [
    'an upper-case .DOCX',
    { fileName: 'Policy.DOCX', head: ZIP_HEAD, zipEntries: DOCX_ENTRIES, isUtf8Text: false },
    ok('docx'),
  ],
  ['an upper-case .CSV', { fileName: 'ASSETS.CSV', head: CSV_HEAD, isUtf8Text: true }, ok('csv')],
  ['a mixed-case .Json', { fileName: 'assets.Json', head: JSON_ARRAY_HEAD, isUtf8Text: true }, ok('json')],
  ['an upper-case .TXT', { fileName: 'README.TXT', head: TXT_HEAD, isUtf8Text: true }, ok('txt')],

  // Zips are refused, unless they are a DOCX named .docx.
  [
    'a zip without the DOCX entries named .docx',
    { fileName: 'policy.docx', head: ZIP_HEAD, zipEntries: PLAIN_ZIP_ENTRIES, isUtf8Text: false },
    no('zip'),
  ],
  [
    'an XLSX renamed .docx',
    { fileName: 'policy.docx', head: ZIP_HEAD, zipEntries: XLSX_ENTRIES, isUtf8Text: false },
    no('zip'),
  ],
  [
    'a zip with only [Content_Types].xml named .docx',
    { fileName: 'policy.docx', head: ZIP_HEAD, zipEntries: ['[Content_Types].xml'], isUtf8Text: false },
    no('zip'),
  ],
  [
    'a zip with only word/document.xml named .docx',
    { fileName: 'policy.docx', head: ZIP_HEAD, zipEntries: ['word/document.xml'], isUtf8Text: false },
    no('zip'),
  ],
  [
    'an empty zip named .docx',
    { fileName: 'policy.docx', head: ZIP_HEAD, zipEntries: [], isUtf8Text: false },
    no('zip'),
  ],
  [
    'a plain zip named .zip',
    { fileName: 'bundle.zip', head: ZIP_HEAD, zipEntries: PLAIN_ZIP_ENTRIES, isUtf8Text: false },
    no('zip'),
  ],
  [
    'a zip holding the DOCX entries named .zip',
    { fileName: 'bundle.zip', head: ZIP_HEAD, zipEntries: DOCX_ENTRIES, isUtf8Text: false },
    no('zip'),
  ],
  [
    'an upper-case .ZIP',
    { fileName: 'BUNDLE.ZIP', head: ZIP_HEAD, zipEntries: PLAIN_ZIP_ENTRIES, isUtf8Text: false },
    no('zip'),
  ],

  // The extension disagrees with the content.
  ['a PDF head named .txt', { fileName: 'notes.txt', head: PDF_HEAD, isUtf8Text: false }, no('extension_mismatch')],
  [
    'a PDF head named .txt that decodes as UTF-8',
    { fileName: 'notes.txt', head: bytes('%PDF-1.4\n'), isUtf8Text: true },
    no('extension_mismatch'),
  ],
  ['a PDF head named .csv', { fileName: 'assets.csv', head: PDF_HEAD, isUtf8Text: false }, no('extension_mismatch')],
  ['a PDF head named .docx', { fileName: 'policy.docx', head: PDF_HEAD, isUtf8Text: false }, no('extension_mismatch')],
  ['a binary named .csv', { fileName: 'assets.csv', head: PNG_HEAD, isUtf8Text: false }, no('extension_mismatch')],
  ['a binary named .txt', { fileName: 'notes.txt', head: EXE_HEAD, isUtf8Text: false }, no('extension_mismatch')],
  ['a binary named .json', { fileName: 'assets.json', head: PNG_HEAD, isUtf8Text: false }, no('extension_mismatch')],
  [
    'a .docx that is UTF-8 text, not a zip',
    { fileName: 'policy.docx', head: TXT_HEAD, isUtf8Text: true },
    no('extension_mismatch'),
  ],
  [
    'a .docx that is a PNG, not a zip',
    { fileName: 'policy.docx', head: PNG_HEAD, isUtf8Text: false },
    no('extension_mismatch'),
  ],
  ['UTF-8 text named .pdf', { fileName: 'policy.pdf', head: TXT_HEAD, isUtf8Text: true }, no('extension_mismatch')],

  // Unknown or missing extensions, and unknown binaries.
  ['an .exe', { fileName: 'setup.exe', head: EXE_HEAD, isUtf8Text: false }, no('unknown_type')],
  ['UTF-8 text named .exe', { fileName: 'setup.exe', head: TXT_HEAD, isUtf8Text: true }, no('unknown_type')],
  ['a file with no extension', { fileName: 'README', head: TXT_HEAD, isUtf8Text: true }, no('unknown_type')],
  ['a name ending in a dot', { fileName: 'README.', head: TXT_HEAD, isUtf8Text: true }, no('unknown_type')],
  ['an unknown binary', { fileName: 'image.png', head: PNG_HEAD, isUtf8Text: false }, no('unknown_type')],
  [
    'an unknown binary with an unknown extension',
    { fileName: 'blob.bin', head: EXE_HEAD, isUtf8Text: false },
    no('unknown_type'),
  ],
  [
    'a known extension hidden before an unknown one',
    { fileName: 'policy.pdf.exe', head: PDF_HEAD, isUtf8Text: false },
    no('unknown_type'),
  ],
  [
    'UTF-8 text named .html',
    { fileName: 'page.html', head: bytes('<html></html>'), isUtf8Text: true },
    no('unknown_type'),
  ],

  // An empty head.
  ['an empty .txt', { fileName: 'empty.txt', head: new Uint8Array(0), isUtf8Text: true }, no('empty')],
  ['an empty .pdf', { fileName: 'empty.pdf', head: new Uint8Array(0), isUtf8Text: false }, no('empty')],
  ['an empty .csv', { fileName: 'empty.csv', head: new Uint8Array(0), isUtf8Text: true }, no('empty')],
];

describe('criterion 2: detectFileFormat checks the type by content', () => {
  it.each(CASES)('%s', async (_name, input, expected) => {
    const { detectFileFormat } = await loadIntake();
    expect(detectFileFormat(input)).toEqual(expected);
  });

  it.each([
    ['UTF-8 text not starting with { or [', bytes('id,name\na1,web01\n')],
    ['UTF-8 text starting with a quote', bytes('"just a string"')],
    ['a PDF head', PDF_HEAD],
  ])('.json refuses %s', async (_name, head) => {
    const { detectFileFormat } = await loadIntake();
    const result = detectFileFormat({ fileName: 'assets.json', head, isUtf8Text: head !== PDF_HEAD });
    expect(result.ok).toBe(false);
  });

  it('a zip named .docx whose entry names were not given is refused (fail safe)', async () => {
    const { detectFileFormat } = await loadIntake();
    const result = detectFileFormat({ fileName: 'policy.docx', head: ZIP_HEAD, isUtf8Text: false });
    expect(result.ok).toBe(false);
  });

  it('never accepts a format outside the five', async () => {
    const { detectFileFormat, FILE_FORMATS } = await loadIntake();
    for (const [, input] of CASES) {
      const result = detectFileFormat(input);
      if (result.ok) expect([...FILE_FORMATS]).toContain(result.format);
    }
  });

  it('does not change its input', async () => {
    const { detectFileFormat } = await loadIntake();
    const head = bytes('[{"id":"a1"}]');
    const copy = new Uint8Array(head);
    const zipEntries = Object.freeze([...DOCX_ENTRIES]);
    detectFileFormat({ fileName: 'assets.json', head, isUtf8Text: true });
    detectFileFormat({ fileName: 'policy.docx', head: ZIP_HEAD, zipEntries, isUtf8Text: false });
    expect(head).toEqual(copy);
    expect([...zipEntries]).toEqual(DOCX_ENTRIES);
  });
});
