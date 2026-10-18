import * as assert from "node:assert";
import { closeAllEditors, fixture, openPdf, setSetting, sleep, viewer, waitFor } from "../helpers";

// pdf.js AnnotationEditorType values.
const FREETEXT = 3;
const HIGHLIGHT = 9;
const INK = 15;
const KEYS = ["highlightColor", "inkColor", "inkThickness", "textColor", "textSize"];

interface Toolbar {
  inkColor: string;
  inkThickness: string;
  textColor: string;
  textSize: string;
  highlightColor: string;
}

describe("Annotation tool defaults", () => {
  const pdf = fixture("sample.pdf");

  async function reset(): Promise<void> {
    for (const key of KEYS) {
      await setSetting("pdfPhoenix.annotations", key, undefined);
    }
  }

  beforeEach(reset);
  after(reset);
  afterEach(async () => {
    await viewer(pdf, "setEditorMode", { mode: 0 }).catch(() => undefined);
    await closeAllEditors();
  });

  // Switch to a tool and read what pdf.js's own toolbar shows for it.
  async function toolbarFor(mode: number, check: (t: Toolbar) => boolean): Promise<Toolbar> {
    await viewer(pdf, "setEditorMode", { mode });
    try {
      return await waitFor(`the toolbar for editor mode ${mode}`, async () => {
        const t = (await viewer(pdf, "editorToolbar")) as Toolbar;
        return check(t) ? t : undefined;
      }, 10_000);
    } catch (err) {
      const t = await viewer(pdf, "editorToolbar");
      const s = (await viewer(pdf, "snapshot")) as { log: string[] };
      throw new Error(`${err instanceof Error ? err.message : err}\n      toolbar: ${JSON.stringify(t)}\n      log: ${JSON.stringify(s.log)}`);
    }
  }

  it("keeps pdf.js's own defaults when nothing is set", async () => {
    await openPdf(pdf);
    const ink = await toolbarFor(INK, (t) => t.inkThickness !== null);
    assert.strictEqual(ink.inkColor, "#000000");
    assert.strictEqual(ink.inkThickness, "1");
    const text = await toolbarFor(FREETEXT, (t) => t.textSize !== null);
    assert.strictEqual(text.textColor, "#000000");
    assert.strictEqual(text.textSize, "10");
    await toolbarFor(HIGHLIGHT, (t) => t.highlightColor === "#FFFF98");
  });

  it("starts each tool with the configured color and size", async () => {
    await setSetting("pdfPhoenix.annotations", "highlightColor", "blue");
    await setSetting("pdfPhoenix.annotations", "inkColor", "#1E90FF");
    await setSetting("pdfPhoenix.annotations", "inkThickness", 7);
    await setSetting("pdfPhoenix.annotations", "textColor", "#AA0000");
    await setSetting("pdfPhoenix.annotations", "textSize", 24);
    await openPdf(pdf);

    const ink = await toolbarFor(INK, (t) => t.inkThickness === "7");
    assert.strictEqual(ink.inkColor, "#1e90ff");
    const text = await toolbarFor(FREETEXT, (t) => t.textSize === "24");
    assert.strictEqual(text.textColor, "#aa0000");
    await toolbarFor(HIGHLIGHT, (t) => t.highlightColor === "#80EBFF");
  });

  it("gives new annotations the configured color and size", async () => {
    await setSetting("pdfPhoenix.annotations", "inkColor", "#1E90FF");
    await setSetting("pdfPhoenix.annotations", "inkThickness", 7);
    await setSetting("pdfPhoenix.annotations", "textColor", "#AA0000");
    await setSetting("pdfPhoenix.annotations", "textSize", 24);
    await openPdf(pdf);

    // The properties pdf.js created each annotation with, keyed by its
    // AnnotationEditorParamsType (11 text size, 12 text color, 21 ink color,
    // 22 ink thickness).
    const created = async (mode: number): Promise<Record<number, unknown>> => {
      await viewer(pdf, "setEditorMode", { mode });
      // pdf.js switches tools asynchronously; let the page's editor layer
      // become active before adding to it.
      await sleep(500);
      const props = (await viewer(pdf, "createEditor")) as Array<[number, unknown]> | null;
      assert.ok(props, `no annotation was created in editor mode ${mode}`);
      return Object.fromEntries(props);
    };
    const text = await created(FREETEXT);
    assert.strictEqual(text[11], 24);
    assert.strictEqual(String(text[12]).toLowerCase(), "#aa0000");
    await viewer(pdf, "setEditorMode", { mode: INK });
    await sleep(500);
    const inkProps = (await viewer(pdf, "drawInk")) as Array<[number, unknown]> | null;
    assert.ok(inkProps, "drawing produced no ink annotation");
    const ink = Object.fromEntries(inkProps);
    assert.strictEqual(ink[22], 7);
    assert.strictEqual(String(ink[21]).toLowerCase(), "#1e90ff");
  });

  it("ignores invalid values", async () => {
    await setSetting("pdfPhoenix.annotations", "inkColor", "red\" onload=\"x");
    await setSetting("pdfPhoenix.annotations", "inkThickness", 500);
    await openPdf(pdf);
    const ink = await toolbarFor(INK, (t) => t.inkThickness !== null);
    assert.strictEqual(ink.inkColor, "#000000");
    assert.strictEqual(ink.inkThickness, "20", "clamped to the slider's maximum");
  });
});
