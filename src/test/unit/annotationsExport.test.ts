import * as assert from "node:assert";
import { annotationsToMarkdown, escapeMarkdown, pdfDateToIso } from "../../annotationsExport";

describe("annotationsToMarkdown", () => {
  const on = new Date("2026-10-18T12:00:00Z");

  it("groups annotations by page with quoted text and notes", () => {
    const md = annotationsToMarkdown(
      "paper.pdf",
      [
        {
          pageNumber: 1,
          annotations: [
            { type: "Highlight", text: "the key finding", contents: "Check this.", color: "#FFFF98" },
            { type: "Text", contents: "A sticky note", author: "Ana", modified: "D:20261001093000+02'00'" },
          ],
        },
        { pageNumber: 2, annotations: [] },
        { pageNumber: 3, label: "iii", annotations: [{ type: "Ink" }] },
      ],
      on
    );
    assert.strictEqual(
      md,
      [
        "# Annotations: paper.pdf",
        "",
        "_Exported from PDF Phoenix on 2026-10-18: 3 annotations on 2 pages._",
        "",
        "## Page 1",
        "",
        "- **Highlight** (#FFFF98)",
        "  > the key finding",
        "",
        "  Check this.",
        "- **Note** (by Ana, 2026-10-01)",
        "  A sticky note",
        "",
        "## Page 3 (iii)",
        "",
        "- **Drawing**",
        "",
      ].join("\n")
    );
  });

  it("uses singular wording for a single annotation", () => {
    const md = annotationsToMarkdown("a.pdf", [{ pageNumber: 1, annotations: [{ type: "Stamp" }] }], on);
    assert.ok(md.includes("1 annotation on 1 page._"));
  });

  it("keeps PDF text from turning into Markdown formatting", () => {
    const md = annotationsToMarkdown(
      "a_b.pdf",
      [{ pageNumber: 1, annotations: [{ type: "FreeText", contents: "*not bold* <b>x</b> # not a heading" }] }],
      on
    );
    assert.ok(md.includes("# Annotations: a\\_b.pdf"));
    assert.ok(md.includes("  \\*not bold\\* \\<b\\>x\\</b\\> \\# not a heading"));
  });

  it("names unknown annotation types by their subtype", () => {
    const md = annotationsToMarkdown("a.pdf", [{ pageNumber: 1, annotations: [{ type: "Redact" }] }], on);
    assert.ok(md.includes("- **Redact**"));
  });
});

describe("pdfDateToIso", () => {
  it("reads PDF dates with and without the D: prefix", () => {
    assert.strictEqual(pdfDateToIso("D:20261018093000+02'00'"), "2026-10-18");
    assert.strictEqual(pdfDateToIso("20250102"), "2025-01-02");
    assert.strictEqual(pdfDateToIso("D:2024"), "2024-01-01");
  });

  it("ignores anything that isn't a PDF date", () => {
    assert.strictEqual(pdfDateToIso("yesterday"), undefined);
    assert.strictEqual(pdfDateToIso(undefined), undefined);
  });
});

describe("escapeMarkdown", () => {
  it("escapes formatting characters and leaves the rest alone", () => {
    assert.strictEqual(escapeMarkdown("a*b_c[d]e`f"), "a\\*b\\_c\\[d\\]e\\`f");
    assert.strictEqual(escapeMarkdown("plain text, 42."), "plain text, 42.");
  });
});
