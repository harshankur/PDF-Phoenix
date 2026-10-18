import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { unzipToDir } from "../../unzip";

interface Entry {
  name: string;
  content?: Buffer | string;
  deflate?: boolean;
  // Lie about the uncompressed size in the central directory.
  declaredSize?: number;
}

// A minimal ZIP writer, the mirror image of the extractor. CRCs are left as
// zero because the extractor doesn't check them (whole-archive integrity is
// checked against the release's published digest before extraction).
function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.content ?? "");
    const data = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = entry.deflate ? 8 : 0;
    const size = entry.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

describe("unzipToDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfphoenix-unzip-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("extracts stored and deflated files and directories", async () => {
    const big = "pdf.js ".repeat(5_000);
    await unzipToDir(
      makeZip([
        { name: "web/" },
        { name: "web/viewer.html", content: "<html></html>" },
        { name: "build/pdf.mjs", content: big, deflate: true },
        { name: "..notes.txt", content: "a name that merely starts with two dots" },
      ]),
      dir
    );
    assert.strictEqual(fs.readFileSync(path.join(dir, "web", "viewer.html"), "utf8"), "<html></html>");
    assert.strictEqual(fs.readFileSync(path.join(dir, "build", "pdf.mjs"), "utf8"), big);
    assert.ok(fs.existsSync(path.join(dir, "..notes.txt")));
  });

  it("refuses entries that would land outside the destination", async () => {
    for (const name of ["../escape.txt", "web/../../escape.txt", "/etc/escape.txt", "C:/escape.txt"]) {
      const target = path.join(dir, "inner");
      fs.mkdirSync(target, { recursive: true });
      await assert.rejects(
        unzipToDir(makeZip([{ name, content: "x" }]), target),
        /escapes destination|absolute entry path/,
        name
      );
    }
    assert.strictEqual(fs.existsSync(path.join(dir, "escape.txt")), false);
  });

  it("refuses a deflated entry that expands past its declared size", async () => {
    const zip = makeZip([{ name: "bomb.bin", content: Buffer.alloc(1_000_000), deflate: true, declaredSize: 1_000 }]);
    await assert.rejects(unzipToDir(zip, dir));
    assert.strictEqual(fs.existsSync(path.join(dir, "bomb.bin")), false);
  });

  it("refuses an entry whose size doesn't match the directory", async () => {
    await assert.rejects(
      unzipToDir(makeZip([{ name: "short.txt", content: "abc", declaredSize: 10 }]), dir),
      /size mismatch/
    );
  });

  it("refuses a truncated archive", async () => {
    const zip = makeZip([{ name: "a.txt", content: "hello world" }]);
    // Point the entry's data past the end by corrupting its local header offset.
    const corrupt = Buffer.from(zip);
    const centralStart = corrupt.readUInt32LE(corrupt.length - 22 + 16);
    corrupt.writeUInt32LE(corrupt.length - 10, centralStart + 42);
    await assert.rejects(unzipToDir(corrupt, dir), /malformed local header|truncated/);
  });

  it("refuses data that isn't a zip", async () => {
    await assert.rejects(unzipToDir(Buffer.from("not a zip at all, just some text"), dir), /end-of-central-directory/);
  });
});
