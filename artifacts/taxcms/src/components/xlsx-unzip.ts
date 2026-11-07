// Unpacks an .xlsx (zip) for the spreadsheet worker without trusting anything the zip says
// about itself, and repacks it uncompressed for exceljs.
//
// exceljs (JSZip) inflates every part completely before it parses any XML, and the sizes in
// the zip directory are whatever the file's author wrote there. So the only real bound on
// memory is counting the bytes that actually come out of the inflater and stopping at the
// limit, which is what this does (with the browser's own DecompressionStream). The parts are
// then handed to exceljs as a "stored" zip, so it only copies them.

export class ZipFormatError extends Error {}
export class ZipTooLargeError extends Error {}
export class ZipEncryptedError extends Error {}

export interface ZipPart {
  /** Raw file name bytes, written back unchanged. */
  nameBytes: Uint8Array;
  name: string;
  /** Only the UTF-8 name flag is kept: the repacked part has no data descriptor or encryption. */
  utf8: boolean;
  data: Uint8Array;
}

interface DirEntry {
  nameBytes: Uint8Array;
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  localOffset: number;
}

const utf8 = new TextDecoder();

function readDirectory(bytes: Uint8Array): DirEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record sits in the last 22 bytes plus an optional comment.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipFormatError("no end of central directory");
  const count = view.getUint16(eocd + 10, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  // Zip64 markers: an xlsx that needs zip64 is far beyond what is previewed.
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipTooLargeError("zip64");
  const entries: DirEntry[] = [];
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new ZipFormatError("bad central directory");
    const nameLen = view.getUint16(p + 28, true);
    const compressedSize = view.getUint32(p + 20, true);
    const localOffset = view.getUint32(p + 42, true);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new ZipTooLargeError("zip64");
    if (p + 46 + nameLen > bytes.length) throw new ZipFormatError("bad central directory");
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    entries.push({
      nameBytes,
      name: utf8.decode(nameBytes),
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      compressedSize,
      localOffset,
    });
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return entries;
}

function compressedData(bytes: Uint8Array, e: DirEntry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lo = e.localOffset;
  if (lo + 30 > bytes.length || view.getUint32(lo, true) !== 0x04034b50) throw new ZipFormatError("bad local header");
  const start = lo + 30 + view.getUint16(lo + 26, true) + view.getUint16(lo + 28, true);
  const end = start + e.compressedSize;
  if (end > bytes.length) throw new ZipFormatError("truncated entry");
  return bytes.subarray(start, end);
}

/**
 * Input slice fed to the inflater at a time. The stream inflates a whole input chunk before
 * backpressure can act, and deflate expands at most ~1032:1, so one slice yields at most ~16 MB.
 */
const INFLATE_SLICE = 16 * 1024;

/** Inflates raw deflate data, giving up as soon as more than `budget.left` bytes come out. */
async function inflateBounded(data: Uint8Array, budget: { left: number }): Promise<Uint8Array> {
  const inflater = new DecompressionStream("deflate-raw");
  const writer = inflater.writable.getWriter();
  const reader = inflater.readable.getReader();
  let stop = false;
  // Fed slice by slice and only as fast as the output is read; ends once reading stops.
  const feeding = (async () => {
    for (let at = 0; at < data.length && !stop; at += INFLATE_SLICE) {
      await writer.ready;
      await writer.write(data.subarray(at, at + INFLATE_SLICE) as Uint8Array<ArrayBuffer>);
    }
    if (!stop) await writer.close();
  })();
  feeding.catch(() => {});
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.left -= value.length;
      if (budget.left < 0) throw new ZipTooLargeError("unpacked size over the limit");
      chunks.push(value);
      size += value.length;
    }
    await feeding;
  } catch (err) {
    stop = true;
    void reader.cancel().catch(() => {});
    if (err instanceof ZipTooLargeError) throw err;
    throw new ZipFormatError("corrupt deflate data");
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Whether this browser can inflate zip entries itself (Chrome 103+, Firefox 113+, Safari 16.4+). */
export function canInflate(): boolean {
  try {
    new DecompressionStream("deflate-raw");
    return true;
  } catch {
    return false;
  }
}

/**
 * Every part of the zip, inflated, with at most `maxUnpacked` bytes in total actually
 * produced. Parts for which `skip(name)` is true are not inflated at all and come back empty.
 */
export async function unpackZip(bytes: Uint8Array, maxUnpacked: number, skip: (name: string) => boolean): Promise<ZipPart[]> {
  const budget = { left: maxUnpacked };
  const parts: ZipPart[] = [];
  for (const e of readDirectory(bytes)) {
    if (e.name.endsWith("/")) continue; // directory entry
    if (e.flags & 0x1) throw new ZipEncryptedError("encrypted entry");
    const part = { nameBytes: e.nameBytes, name: e.name, utf8: (e.flags & 0x800) !== 0 };
    if (skip(e.name)) { parts.push({ ...part, data: new Uint8Array(0) }); continue; }
    const raw = compressedData(bytes, e);
    let data: Uint8Array;
    if (e.method === 0) {
      budget.left -= raw.length;
      if (budget.left < 0) throw new ZipTooLargeError("unpacked size over the limit");
      data = raw;
    } else if (e.method === 8) {
      data = await inflateBounded(raw, budget);
    } else {
      throw new ZipFormatError(`compression method ${e.method}`);
    }
    parts.push({ ...part, data });
  }
  return parts;
}

let crcTable: Uint32Array | undefined;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip of `parts` with no compression (method 0), which exceljs reads by copying. */
export function storedZip(parts: ZipPart[]): Uint8Array {
  let size = 22;
  for (const p of parts) size += 30 + p.nameBytes.length + p.data.length + 46 + p.nameBytes.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const central: { offset: number; crc: number; part: ZipPart }[] = [];
  let at = 0;
  for (const part of parts) {
    const crc = crc32(part.data);
    central.push({ offset: at, crc, part });
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, part.utf8 ? 0x800 : 0, true);
    view.setUint16(at + 8, 0, true); // stored
    view.setUint32(at + 14, crc, true);
    view.setUint32(at + 18, part.data.length, true);
    view.setUint32(at + 22, part.data.length, true);
    view.setUint16(at + 26, part.nameBytes.length, true);
    out.set(part.nameBytes, at + 30);
    out.set(part.data, at + 30 + part.nameBytes.length);
    at += 30 + part.nameBytes.length + part.data.length;
  }
  const dirStart = at;
  for (const { offset, crc, part } of central) {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, part.utf8 ? 0x800 : 0, true);
    view.setUint32(at + 16, crc, true);
    view.setUint32(at + 20, part.data.length, true);
    view.setUint32(at + 24, part.data.length, true);
    view.setUint16(at + 28, part.nameBytes.length, true);
    view.setUint32(at + 42, offset, true);
    out.set(part.nameBytes, at + 46);
    at += 46 + part.nameBytes.length;
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, central.length, true);
  view.setUint16(at + 10, central.length, true);
  view.setUint32(at + 12, at - dirStart, true);
  view.setUint32(at + 16, dirStart, true);
  return out;
}

function columnName(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

const ROW_OR_CELL = /<(row|c)(?=[\s/>])([^>]*)>/g;
const REF_ATTR = /\sr\s*=\s*(["'])(.*?)\1/;

/**
 * ECMA-376 makes <row r> and <c r> optional, and some exporters leave them out; exceljs
 * cannot read such sheets. Fills them in from running row/column counters, the way Excel
 * numbers them. Returns null when every row and cell already has one.
 */
export function addMissingCellRefs(xml: string): string | null {
  let row = 0;
  let col = 0;
  let changed = false;
  const out = xml.replace(ROW_OR_CELL, (tag, name: string, rest: string) => {
    const ref = REF_ATTR.exec(rest)?.[2];
    if (name === "row") {
      col = 0;
      const n = ref ? Number.parseInt(ref, 10) : NaN;
      if (Number.isFinite(n) && n > 0) { row = n; return tag; }
      row += 1;
      changed = true;
      return `<row r="${row}"${rest}>`;
    }
    const m = ref ? /^\$?([A-Za-z]{1,3})\$?\d+$/.exec(ref) : null;
    if (m) { col = columnNumber(m[1]); return tag; }
    if (row === 0) return tag; // a cell outside any row: leave it to exceljs
    col += 1;
    changed = true;
    return `<c r="${columnName(col)}${row}"${rest}>`;
  });
  return changed ? out : null;
}
