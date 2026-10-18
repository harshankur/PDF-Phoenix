import * as zlib from "node:zlib";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Minimal ZIP extractor for the one artifact we ever process: Mozilla's
// prebuilt pdf.js dist zip (a standard, non-ZIP64 archive using store/deflate).
// Kept dependency-free on purpose so the extension host build stays a plain
// `tsc` with zero runtime dependencies to bundle.
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
// Sizes/offsets of 0xFFFFFFFF mean the real value is in a ZIP64 record.
const ZIP64_MARKER = 0xffffffff;
const STORED = 0;
const DEFLATED = 8;

export async function unzipToDir(zip: Buffer, destDir: string): Promise<void> {
  const eocd = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocd + 10);
  let ptr = zip.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(ptr) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error("unzip: malformed central directory header");
    }
    const method = zip.readUInt16LE(ptr + 10);
    const compressedSize = zip.readUInt32LE(ptr + 20);
    const uncompressedSize = zip.readUInt32LE(ptr + 24);
    const nameLen = zip.readUInt16LE(ptr + 28);
    const extraLen = zip.readUInt16LE(ptr + 30);
    const commentLen = zip.readUInt16LE(ptr + 32);
    const localHeaderOffset = zip.readUInt32LE(ptr + 42);
    const name = zip.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER || localHeaderOffset === ZIP64_MARKER) {
      throw new Error(`unzip: ZIP64 entries are not supported: ${name}`);
    }

    // ZIP entry names are always relative. An absolute or drive-letter name
    // means a malformed or hostile archive, so refuse it rather than guess.
    if (name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) {
      throw new Error(`unzip: absolute entry path not allowed: ${name}`);
    }
    const outPath = path.join(destDir, name);
    if (!isInside(destDir, outPath)) {
      throw new Error(`unzip: entry escapes destination: ${name}`);
    }

    if (name.endsWith("/")) {
      await fs.mkdir(outPath, { recursive: true });
      continue;
    }

    // The local header's name/extra lengths can differ from the central
    // directory's, so re-read them to find where the file data actually starts.
    if (localHeaderOffset + 30 > zip.length || zip.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(`unzip: malformed local header for ${name}`);
    }
    const localNameLen = zip.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zip.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compressedSize > zip.length) {
      throw new Error(`unzip: truncated data for ${name}`);
    }
    const raw = zip.subarray(dataStart, dataStart + compressedSize);

    let content: Buffer;
    if (method === STORED) {
      content = Buffer.from(raw);
    } else if (method === DEFLATED) {
      // Cap the output at the declared size so a malformed or hostile
      // archive can't expand into gigabytes (inflateRawSync throws past it).
      content = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(uncompressedSize, 1) });
    } else {
      throw new Error(`unzip: unsupported compression method ${method} for ${name}`);
    }
    if (content.length !== uncompressedSize) {
      throw new Error(`unzip: size mismatch for ${name}`);
    }

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, content);
  }
}

function findEndOfCentralDirectory(zip: Buffer): number {
  // The EOCD record is at the end, before an optional comment (<= 65535 bytes).
  const earliest = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= earliest; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  throw new Error("unzip: end-of-central-directory record not found");
}

function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
