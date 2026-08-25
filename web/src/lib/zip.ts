//! Minimal ZIP archive (STORE method — no compression), read + write, no
//! dependency. Enough for bundling a set of small text files (CSV + manifest)
//! and reading them back. Only the STORE method is produced; on read, only
//! STORE (method 0) entries are supported — which is all this writer emits.

/** A single archive entry (text content). */
export type ZipEntry = { name: string; text: string };

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800; // filename is UTF-8 (general purpose bit 11)
const STORE = 0;
const DEFLATE = 8;

// CRC-32 (IEEE) lookup table, built once.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds a ZIP (STORE) archive from text entries and returns it as a Blob. */
export function zipStore(entries: ZipEntry[]): Blob {
  const enc = new TextEncoder();
  const files = entries.map((e) => ({ name: enc.encode(e.name), data: enc.encode(e.text) }));

  // Compute total size to allocate a single buffer.
  const localSize = (nameLen: number, dataLen: number) => 30 + nameLen + dataLen;
  const centralSize = (nameLen: number) => 46 + nameLen;
  let total = 22; // end of central directory
  for (const f of files) total += localSize(f.name.length, f.data.length) + centralSize(f.name.length);

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let off = 0;
  const offsets: number[] = [];
  const crcs: number[] = [];

  // Local headers + data.
  for (const f of files) {
    offsets.push(off);
    const crc = crc32(f.data);
    crcs.push(crc);
    view.setUint32(off, LOCAL_SIG, true);
    view.setUint16(off + 4, 20, true); // version needed
    view.setUint16(off + 6, UTF8_FLAG, true); // flags
    view.setUint16(off + 8, 0, true); // method: store
    view.setUint16(off + 10, 0, true); // mod time
    view.setUint16(off + 12, 0, true); // mod date
    view.setUint32(off + 14, crc, true);
    view.setUint32(off + 18, f.data.length, true); // compressed size
    view.setUint32(off + 22, f.data.length, true); // uncompressed size
    view.setUint16(off + 26, f.name.length, true);
    view.setUint16(off + 28, 0, true); // extra len
    off += 30;
    buf.set(f.name, off);
    off += f.name.length;
    buf.set(f.data, off);
    off += f.data.length;
  }

  // Central directory.
  const centralStart = off;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    view.setUint32(off, CENTRAL_SIG, true);
    view.setUint16(off + 4, 20, true); // version made by
    view.setUint16(off + 6, 20, true); // version needed
    view.setUint16(off + 8, UTF8_FLAG, true); // flags
    view.setUint16(off + 10, 0, true); // method
    view.setUint16(off + 12, 0, true); // mod time
    view.setUint16(off + 14, 0, true); // mod date
    view.setUint32(off + 16, crcs[i], true);
    view.setUint32(off + 20, f.data.length, true);
    view.setUint32(off + 24, f.data.length, true);
    view.setUint16(off + 28, f.name.length, true);
    view.setUint16(off + 30, 0, true); // extra len
    view.setUint16(off + 32, 0, true); // comment len
    view.setUint16(off + 34, 0, true); // disk number start
    view.setUint16(off + 36, 0, true); // internal attrs
    view.setUint32(off + 38, 0, true); // external attrs
    view.setUint32(off + 42, offsets[i], true); // local header offset
    off += 46;
    buf.set(f.name, off);
    off += f.name.length;
  }

  // End of central directory.
  view.setUint32(off, EOCD_SIG, true);
  view.setUint16(off + 4, 0, true); // disk number
  view.setUint16(off + 6, 0, true); // central dir disk
  view.setUint16(off + 8, files.length, true); // entries on this disk
  view.setUint16(off + 10, files.length, true); // total entries
  view.setUint32(off + 12, off - centralStart, true); // central dir size
  view.setUint32(off + 16, centralStart, true); // central dir offset
  view.setUint16(off + 20, 0, true); // comment len

  return new Blob([buf], { type: "application/zip" });
}

/** A located entry: where its bytes are and how they were stored. */
type RawEntry = { name: string; method: number; start: number; size: number };

/** Walks the central directory. The authority on what an archive contains — the
 * local headers repeat the same information and are allowed to lie about sizes
 * when an entry carries a trailing data descriptor. */
function listEntries(bytes: Uint8Array): RawEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();

  // Locate the End Of Central Directory record (scan backwards; no comment
  // assumed, but tolerate one up to 64 KiB).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("invalid zip: no EOCD");

  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true); // central dir offset
  const out: RawEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (view.getUint32(off, true) !== CENTRAL_SIG) throw new Error("invalid zip: bad central header");
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));

    // Data starts after the local header (whose extra field length may differ).
    const localNameLen = view.getUint16(localOff + 26, true);
    const localExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + localNameLen + localExtraLen;
    out.push({ name, method, start, size: compSize });

    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Reads a ZIP (STORE) archive into text entries. Non-STORE entries throw.
 * Used for bundles this app wrote itself, which are always STORE. */
export function unzip(bytes: Uint8Array): ZipEntry[] {
  const dec = new TextDecoder();
  return listEntries(bytes).map((e) => {
    if (e.method !== STORE) throw new Error(`unsupported zip method ${e.method} for ${e.name}`);
    return { name: e.name, text: dec.decode(bytes.subarray(e.start, e.start + e.size)) };
  });
}

/** Inflates a raw DEFLATE stream using the platform's own decompressor.
 *
 * No inflate implementation is bundled for this: `DecompressionStream` is in
 * every browser this app supports, and a compression codec is exactly the kind
 * of dependency worth not having. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads any ZIP this app is likely to be handed — STORE or DEFLATE — as raw
 * bytes, keyed by entry name.
 *
 * Bytes rather than text because an archive from elsewhere carries images
 * alongside its documents, and decoding a PNG as UTF-8 would quietly corrupt it.
 * Directory entries (trailing `/`) are dropped: the paths of the files say
 * everything about the tree. */
export async function unzipAll(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const e of listEntries(bytes)) {
    if (e.name.endsWith("/")) continue;
    const raw = bytes.subarray(e.start, e.start + e.size);
    if (e.method === STORE) {
      out.set(e.name, raw);
    } else if (e.method === DEFLATE) {
      out.set(e.name, await inflateRaw(raw));
    } else {
      throw new Error(`unsupported zip method ${e.method} for ${e.name}`);
    }
  }
  return out;
}
