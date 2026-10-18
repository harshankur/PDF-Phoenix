import * as assert from "node:assert";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PATCHES,
  PRUNE_PATHS,
  VIEWER_HTML_ANCHORS,
  builtInSupersedes,
  checkDownload,
  compareVersions,
  distAssetName,
  findDistAsset,
  majorChangeWarning,
  parseVersion,
  pickUpdate,
  preparePdfjsDir,
  readMetaVersion,
  replaceAnchor,
  writeMeta,
} from "../../pdfjs";

// A viewer.html with every string PDF Phoenix rewrites, like pdf.js's own.
const VIEWER_HTML = `<html><head>
<link rel="resource" type="application/l10n" ${VIEWER_HTML_ANCHORS.locale}>
<script ${VIEWER_HTML_ANCHORS.pdfMjs} type="module"></script>
<link rel="stylesheet" ${VIEWER_HTML_ANCHORS.viewerCss}>
${VIEWER_HTML_ANCHORS.viewerMjs}
</head><body></body></html>`;

describe("parseVersion", () => {
  it("parses plain and v-prefixed versions", () => {
    assert.deepStrictEqual(parseVersion("4.2.67"), [4, 2, 67]);
    assert.deepStrictEqual(parseVersion("v5.10.0"), [5, 10, 0]);
    assert.deepStrictEqual(parseVersion(" v6.1.200 "), [6, 1, 200]);
  });

  it("ignores a suffix after the patch number", () => {
    assert.deepStrictEqual(parseVersion("5.0.0-beta.1"), [5, 0, 0]);
  });

  it("rejects anything that isn't major.minor.patch", () => {
    assert.strictEqual(parseVersion("latest"), null);
    assert.strictEqual(parseVersion("5.1"), null);
    assert.strictEqual(parseVersion(""), null);
  });
});

describe("compareVersions", () => {
  it("orders numerically, not as text", () => {
    assert.ok(compareVersions("5.10.0", "5.9.0") > 0);
    assert.ok(compareVersions("5.1.200", "5.1.91") > 0);
    assert.ok(compareVersions("4.9.9", "5.0.0") < 0);
    assert.strictEqual(compareVersions("v6.1.200", "6.1.200"), 0);
  });

  it("treats unparseable versions as equal rather than throwing", () => {
    assert.strictEqual(compareVersions("nope", "6.1.200"), 0);
  });
});

describe("builtInSupersedes", () => {
  it("prefers a built-in pdf.js that is the same or newer than the download", () => {
    assert.strictEqual(builtInSupersedes("6.3.289", "6.4.299", false), true);
    assert.strictEqual(builtInSupersedes("6.4.299", "6.4.299", false), true);
    assert.strictEqual(builtInSupersedes("5.9.0", "6.0.0", false), true);
  });

  it("keeps a newer download, or any download when told to keep it", () => {
    assert.strictEqual(builtInSupersedes("6.10.0", "6.4.299", false), false);
    assert.strictEqual(builtInSupersedes("6.3.289", "6.4.299", true), false);
  });

  it("keeps the download when either version is unknown", () => {
    assert.strictEqual(builtInSupersedes(null, "6.4.299", false), false);
    assert.strictEqual(builtInSupersedes("6.3.289", null, false), false);
    assert.strictEqual(builtInSupersedes("nightly", "6.4.299", false), false);
  });
});

describe("pickUpdate", () => {
  const releases = [
    { version: "7.0.0", prerelease: false },
    { version: "6.3.0", prerelease: true },
    { version: "6.2.1", prerelease: false },
    { version: "6.10.0", prerelease: false },
    { version: "6.1.200", prerelease: false },
    { version: "5.9.9", prerelease: false },
  ];

  it("offers the newest stable release in the same major line", () => {
    assert.strictEqual(pickUpdate(releases, "6.1.200"), "6.10.0");
  });

  it("never offers a new major version or a prerelease", () => {
    assert.strictEqual(pickUpdate([{ version: "7.0.0", prerelease: false }], "6.1.200"), null);
    assert.strictEqual(pickUpdate([{ version: "6.3.0", prerelease: true }], "6.1.200"), null);
  });

  it("offers nothing when already current or newer", () => {
    assert.strictEqual(pickUpdate(releases, "6.10.0"), null);
    assert.strictEqual(pickUpdate(releases, "6.11.0"), null);
  });

  it("offers nothing when the active version is unknown", () => {
    assert.strictEqual(pickUpdate(releases, "unknown"), null);
  });
});

describe("preparePdfjsDir", () => {
  let dir: string;

  function write(rel: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }

  function writeValidLayout(viewerMjs = `if ${PATCHES[0].from} { print(); }`): void {
    write(path.join("web", "viewer.html"), VIEWER_HTML);
    write(path.join("web", "viewer.mjs"), viewerMjs);
    write(path.join("web", "viewer.css"), "body{}");
    write(path.join("build", "pdf.mjs"), "export {}");
    write(path.join("build", "pdf.worker.mjs"), "export {}");
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfphoenix-unit-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("applies the print-shortcut patch and prunes dev-only files", async () => {
    writeValidLayout();
    for (const rel of PRUNE_PATHS) {
      write(rel, "dev only");
    }
    await preparePdfjsDir(dir);
    const viewer = fs.readFileSync(path.join(dir, "web", "viewer.mjs"), "utf8");
    assert.ok(viewer.includes(PATCHES[0].to));
    assert.ok(!viewer.includes(PATCHES[0].from));
    for (const rel of PRUNE_PATHS) {
      assert.strictEqual(fs.existsSync(path.join(dir, rel)), false, `${rel} should be pruned`);
    }
  });

  it("accepts a copy that is already patched", async () => {
    writeValidLayout(`if ${PATCHES[0].to} { print(); }`);
    await preparePdfjsDir(dir);
  });

  it("rejects a copy missing a required file", async () => {
    writeValidLayout();
    fs.rmSync(path.join(dir, "build", "pdf.worker.mjs"));
    await assert.rejects(preparePdfjsDir(dir), /missing or empty/);
  });

  it("rejects a copy with an empty required file", async () => {
    writeValidLayout();
    fs.writeFileSync(path.join(dir, "web", "viewer.css"), "");
    await assert.rejects(preparePdfjsDir(dir), /missing or empty/);
  });

  it("rejects a copy where the patch target can't be found", async () => {
    writeValidLayout("// a viewer.mjs whose print handling changed shape");
    await assert.rejects(preparePdfjsDir(dir), /patch target not found/);
  });

  it("rejects a copy whose viewer.html PDF Phoenix can't hook into", async () => {
    writeValidLayout();
    fs.writeFileSync(
      path.join(dir, "web", "viewer.html"),
      VIEWER_HTML.replace(VIEWER_HTML_ANCHORS.viewerMjs, '<script src="viewer.js" defer></script>')
    );
    await assert.rejects(preparePdfjsDir(dir), /viewer\.html no longer contains/);
  });

  it("round-trips the version marker", async () => {
    assert.strictEqual(await readMetaVersion(dir), null);
    await writeMeta(dir, "6.1.200");
    assert.strictEqual(await readMetaVersion(dir), "6.1.200");
  });
});

describe("download verification", () => {
  const zip = Buffer.from("pretend this is Mozilla's zip");
  const sha256 = createHash("sha256").update(zip).digest("hex");
  const release = {
    assets: [
      { name: "pdfjs-6.1.200-legacy-dist.zip", size: 1, browser_download_url: "https://example.invalid/legacy.zip" },
      {
        name: "pdfjs-6.1.200-dist.zip",
        size: zip.length,
        digest: `sha256:${sha256}`,
        browser_download_url: "https://github.com/mozilla/pdf.js/releases/download/v6.1.200/pdfjs-6.1.200-dist.zip",
      },
    ],
  };

  it("finds the viewer zip among a release's assets", () => {
    const asset = findDistAsset(release, "6.1.200");
    assert.deepStrictEqual(asset, {
      name: "pdfjs-6.1.200-dist.zip",
      url: "https://github.com/mozilla/pdf.js/releases/download/v6.1.200/pdfjs-6.1.200-dist.zip",
      size: zip.length,
      digest: `sha256:${sha256}`,
    });
    assert.strictEqual(distAssetName("6.1.200"), "pdfjs-6.1.200-dist.zip");
  });

  it("finds nothing in a release without the viewer zip or malformed data", () => {
    assert.strictEqual(findDistAsset(release, "9.9.9"), undefined);
    assert.strictEqual(findDistAsset({}, "6.1.200"), undefined);
    assert.strictEqual(findDistAsset(null, "6.1.200"), undefined);
  });

  it("accepts a download matching the published size and digest", () => {
    assert.strictEqual(checkDownload(zip, findDistAsset(release, "6.1.200")!), "verified");
  });

  it("rejects a download with a different digest", () => {
    const tampered = Buffer.from(zip);
    tampered[0] ^= 0xff;
    assert.throws(() => checkDownload(tampered, findDistAsset(release, "6.1.200")!), /doesn't match the SHA-256/);
  });

  it("rejects a download of the wrong size before hashing", () => {
    assert.throws(() => checkDownload(Buffer.concat([zip, Buffer.from("x")]), findDistAsset(release, "6.1.200")!), /bytes but GitHub lists/);
  });

  it("reports a size-only check when GitHub has no digest", () => {
    assert.strictEqual(checkDownload(zip, { name: "old.zip", url: "u", size: zip.length }), "size-only");
  });

  it("rejects a digest in an unknown format", () => {
    assert.throws(() => checkDownload(zip, { name: "a.zip", url: "u", size: zip.length, digest: "md5:abc" }), /unrecognized digest/);
  });
});

describe("replaceAnchor", () => {
  it("replaces the first occurrence literally, without $ patterns", () => {
    assert.strictEqual(replaceAnchor("a X b X", "X", "$&$1"), "a $&$1 b X");
  });

  it("throws when the anchor is missing", () => {
    assert.throws(() => replaceAnchor("<html></html>", VIEWER_HTML_ANCHORS.viewerMjs, "x"), /needs to load it/);
  });

  it("finds every anchor in the bundled pdf.js viewer", () => {
    const bundled = path.join(__dirname, "..", "..", "..", "media", "pdfjs", "web", "viewer.html");
    if (!fs.existsSync(bundled)) {
      return; // Not fetched in this checkout.
    }
    const html = fs.readFileSync(bundled, "utf8");
    for (const anchor of Object.values(VIEWER_HTML_ANCHORS)) {
      assert.ok(html.includes(anchor), anchor);
    }
  });
});

describe("majorChangeWarning", () => {
  it("says nothing within the tested major version", () => {
    assert.strictEqual(majorChangeWarning("6.2.0", "6.1.200"), null);
    assert.strictEqual(majorChangeWarning("6.2.0", "unknown"), null);
  });

  it("calls a higher major version newer and a lower one older", () => {
    assert.match(majorChangeWarning("7.0.1", "6.1.200") ?? "", /^pdf\.js 7\.0\.1 is a newer major release \(7\.x\) than the one PDF Phoenix is tested with \(6\.x\)/);
    assert.match(majorChangeWarning("5.4.0", "6.1.200") ?? "", /^pdf\.js 5\.4\.0 is an older major release \(5\.x\)/);
  });
});
