// Small, hand-built PDFs for the integration tests. Generated rather than
// checked in so each one stays readable and its purpose obvious.

// Serialize numbered objects (object N is objects[N - 1]) into a PDF with a
// correct cross-reference table. Object 1 must be the catalog.
function buildPdf(objects: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n", "latin1")];
  let length = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    parts.push(chunk);
    length += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

function stream(content: string): string {
  return `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
}

// Portrait US Letter pages, each with a red box and a blue heading, so page
// recoloring is visible and the page/zoom/scroll position has room to move.
export function samplePdf(pageCount = 5): Buffer {
  // 1 catalog, 2 pages, 3 font, then (content, page) pairs.
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: number[] = [];
  for (let i = 1; i <= pageCount; i++) {
    objects.push(
      stream(
        `1 0 0 rg 72 600 200 100 re f 0 0 1 rg BT /F1 36 Tf 72 720 Td (Page ${i} colored) Tj ET ` +
          `0 g BT /F1 14 Tf 72 560 Td (Body text on page ${i}) Tj ET`
      )
    );
    const contentId = objects.length;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R ` +
        `/Resources << /Font << /F1 3 0 R >> >> >>`
    );
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  return buildPdf(objects);
}

// One text field named "result" (annotation id 4R). With withScript, the
// document's open action and the page's open action both set it to
// "script ran", so the field shows whether PDF JavaScript executed.
export function formPdf(withScript: boolean): Buffer {
  const js = `this.getField\\("result"\\).value = "script ran";`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DA (/Helv 14 Tf 0 g) ` +
      `/DR << /Font << /Helv 5 0 R >> >> >>${withScript ? " /OpenAction 7 0 R" : ""} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R ` +
      `/Resources << /Font << /F1 5 0 R >> >> /Annots [4 0 R]${withScript ? " /AA << /O 7 0 R >>" : ""} >>`,
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (result) /Rect [72 600 400 640] /P 3 0 R /F 4 " +
      "/DA (/Helv 14 Tf 0 g) /MK << /BG [0.9 0.9 0.9] >> /V () >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("BT /F1 18 Tf 72 700 Td (Form field test) Tj ET"),
    `<< /S /JavaScript /JS (${js}) >>`,
  ];
  return buildPdf(objects);
}

// A one-page PDF padded to roughly sizeBytes with an incompressible stream
// that nothing references, for exercising how much data the viewer moves on
// open and save without making pdf.js render anything heavy.
export function largePdf(sizeBytes: number): Buffer {
  const padding = Buffer.alloc(sizeBytes);
  // Deterministic pseudo-random bytes (xorshift32), so runs are comparable.
  let x = 0x9e3779b9;
  for (let i = 0; i < padding.length; i += 4) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    padding.writeUInt32LE(x >>> 0, Math.min(i, padding.length - 4));
  }
  const head = buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    stream("BT /F1 24 Tf 72 700 Td (Large file) Tj ET"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    // Object 6: the padding, spliced in below.
    "PADDING",
  ]);
  const marker = Buffer.from("PADDING", "latin1");
  const at = head.indexOf(marker);
  const before = head.subarray(0, at);
  const after = head.subarray(at + marker.length);
  const body = Buffer.concat([
    Buffer.from(`<< /Length ${padding.length} >>\nstream\n`, "latin1"),
    padding,
    Buffer.from("\nendstream", "latin1"),
  ]);
  // Splicing shifted everything after object 6 (the xref table and its
  // startxref pointer), so rebuild that tail with corrected offsets.
  const shift = body.length - marker.length;
  const tail = after.toString("latin1").replace(/startxref\n(\d+)/, (_m, n) => `startxref\n${Number(n) + shift}`);
  return Buffer.concat([before, body, Buffer.from(tail, "latin1")]);
}

// Two pages of text with annotations at known places, for the export tests.
// Positions come from Helvetica's glyph widths: on page 1 the highlight
// covers exactly "annotated"; on page 2 one highlight spans "line of text"
// and, on the next line, "second line". Without annotations it's the same
// pages and text with nothing on them, for importing into.
export function annotatedPdf(withAnnotations = true): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R " +
      `/Resources << /Font << /F1 5 0 R >> >>${withAnnotations ? " /Annots [8 0 R 9 0 R 10 0 R]" : ""} >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R " +
      `/Resources << /Font << /F1 5 0 R >> >>${withAnnotations ? " /Annots [11 0 R 12 0 R]" : ""} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("BT /F1 24 Tf 72 700 Td (Hello annotated world) Tj ET"),
    stream("BT /F1 18 Tf 72 700 Td (First line of text) Tj ET BT /F1 18 Tf 72 670 Td (second line here) Tj ET"),
    "<< /Type /Annot /Subtype /Highlight /Rect [132 694 241 722] " +
      "/QuadPoints [132 722 241 722 132 694 241 694] /C [1 1 0] " +
      "/Contents (Important word) /T (Reviewer) /M (D:20261001120000Z) >>",
    "<< /Type /Annot /Subtype /Text /Rect [400 650 420 670] /C [1 0.8 0] /Contents (Remember to cite this.) >>",
    "<< /Type /Annot /Subtype /Link /Rect [72 600 200 620] /Border [0 0 0] " +
      "/A << /S /URI /URI (https://example.com) >> >>",
    "<< /Type /Annot /Subtype /Highlight /Rect [71 665 195 717] " +
      "/QuadPoints [111 717 195 717 111 695 195 695 71 687 164 687 71 665 164 665] /C [0.5 1 0.5] >>",
    "<< /Type /Annot /Subtype /FreeText /Rect [300 500 500 540] /Contents (A text box) /DA (/Helv 12 Tf 0 g) >>",
  ];
  return buildPdf(objects);
}
