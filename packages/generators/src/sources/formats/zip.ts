// A minimal zip writer for the DOCX writer, with Node's own `node:zlib` (deflate and CRC-32): each
// entry deflated, local headers, the central directory and its end record. No ZIP64, no data
// descriptors, no extra fields, no comments. Every entry carries the same fixed time (the zip
// format's earliest, 1980-01-01 00:00), so the same entries always give the same bytes.
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** The entry's path inside the zip, printable ASCII. */
  name: string;
  data: Uint8Array;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION = 20; // 2.0: deflate
const DEFLATE = 8;
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const MAX_16 = 0xffff;
const MAX_32 = 0xffffffff;

function header(size: number, fill: (view: DataView) => void): Buffer {
  const bytes = Buffer.alloc(size);
  fill(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return bytes;
}

/** The entries as a zip file, in the order given. */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_16) throw new RangeError('writeZip: too many entries');
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (!/^[\x21-\x7e][\x20-\x7e]*$/.test(entry.name))
      throw new RangeError('writeZip: an entry name is not printable ASCII');
    const name = Buffer.from(entry.name, 'latin1');
    const data = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    if (entry.data.byteLength > MAX_32 || data.length > MAX_32 || offset > MAX_32) {
      throw new RangeError('writeZip: the zip would need ZIP64');
    }
    const local = header(30, (v) => {
      v.setUint32(0, LOCAL_SIGNATURE, true);
      v.setUint16(4, VERSION, true);
      v.setUint16(6, 0, true); // flags
      v.setUint16(8, DEFLATE, true);
      v.setUint16(10, DOS_TIME, true);
      v.setUint16(12, DOS_DATE, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, data.length, true);
      v.setUint32(22, entry.data.byteLength, true);
      v.setUint16(26, name.length, true);
      v.setUint16(28, 0, true); // extra field length
    });
    central.push(
      header(46, (v) => {
        v.setUint32(0, CENTRAL_SIGNATURE, true);
        v.setUint16(4, VERSION, true); // made by: MS-DOS, 2.0
        v.setUint16(6, VERSION, true);
        v.setUint16(8, 0, true); // flags
        v.setUint16(10, DEFLATE, true);
        v.setUint16(12, DOS_TIME, true);
        v.setUint16(14, DOS_DATE, true);
        v.setUint32(16, crc, true);
        v.setUint32(20, data.length, true);
        v.setUint32(24, entry.data.byteLength, true);
        v.setUint16(28, name.length, true);
        // extra field, comment, disk, internal and external attributes: all 0
        v.setUint32(42, offset, true);
      }),
      name,
    );
    parts.push(local, name, data);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  if (offset > MAX_32 || directory.length > MAX_32) throw new RangeError('writeZip: the zip would need ZIP64');
  const end = header(22, (v) => {
    v.setUint32(0, END_SIGNATURE, true);
    v.setUint16(8, entries.length, true);
    v.setUint16(10, entries.length, true);
    v.setUint32(12, directory.length, true);
    v.setUint32(16, offset, true);
  });
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}
