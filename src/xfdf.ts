// Writes a PDF's annotations as XFDF (XML Forms Data Format, ISO 19444-1),
// the annotation-exchange format Adobe Acrobat and most PDF tools import and
// export, for the "Export Annotations as XFDF" command. Reading XFDF back in
// happens in the viewer (media/init.js), next to the pdf.js editors it feeds.
// Kept free of VS Code APIs so it can be unit-tested directly.

import type { ExportedPage } from "./annotationsExport";

// XFDF element names for the PDF annotation subtypes it can describe.
const ELEMENTS: Record<string, string> = {
  Text: "text",
  FreeText: "freetext",
  Line: "line",
  Square: "square",
  Circle: "circle",
  Polygon: "polygon",
  PolyLine: "polyline",
  Highlight: "highlight",
  Underline: "underline",
  Squiggly: "squiggly",
  StrikeOut: "strikeout",
  Caret: "caret",
  Ink: "ink",
};

const STROKED = new Set(["Ink", "Line", "Square", "Circle", "Polygon", "PolyLine"]);

// PDF annotation flag bits, by their XFDF names.
const FLAG_NAMES: Array<[number, string]> = [
  [1, "invisible"],
  [2, "hidden"],
  [4, "print"],
  [8, "nozoom"],
  [16, "norotate"],
  [32, "noview"],
  [64, "readonly"],
  [128, "locked"],
  [256, "togglenoview"],
  [512, "lockedcontents"],
];

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters XML 1.0 doesn't allow at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

// Coordinates to at most 4 decimals, without trailing zeros.
function num(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

function list(values: number[] | undefined, separator = ","): string | undefined {
  return values && values.length ? values.map(num).join(separator) : undefined;
}

// "x,y;x,y;..." as XFDF writes ink gestures and polygon vertices.
function points(values: number[]): string {
  const pairs: string[] = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    pairs.push(`${num(values[i])},${num(values[i + 1])}`);
  }
  return pairs.join(";");
}

export function flagsToXfdf(flags: number | undefined): string | undefined {
  if (!flags) {
    return undefined;
  }
  const names = FLAG_NAMES.filter(([bit]) => flags & bit).map(([, name]) => name);
  return names.length ? names.join(",") : undefined;
}

export interface XfdfResult {
  xml: string;
  // Annotations written, and the subtypes XFDF can't carry without their
  // appearance (images, attachments), which were left out.
  written: number;
  skipped: Record<string, number>;
}

export function annotationsToXfdf(
  fileName: string,
  ids: { original?: string; modified?: string },
  pages: ExportedPage[]
): XfdfResult {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">',
    `  <f href="${escapeXml(fileName)}"/>`,
  ];
  if (ids.original) {
    lines.push(`  <ids original="${escapeXml(ids.original)}" modified="${escapeXml(ids.modified ?? ids.original)}"/>`);
  }
  lines.push("  <annots>");
  let written = 0;
  const skipped: Record<string, number> = {};

  for (const page of pages) {
    for (const a of page.annotations) {
      const element = ELEMENTS[a.type];
      if (!element || !a.rect) {
        skipped[a.type] = (skipped[a.type] ?? 0) + 1;
        continue;
      }
      const attrs: Array<[string, string | undefined]> = [
        ["page", String(page.pageNumber - 1)],
        ["rect", list(a.rect)],
        ["color", a.color],
        ["interior-color", a.interiorColor],
        ["opacity", a.opacity !== undefined && a.opacity !== 1 ? num(a.opacity) : undefined],
        // Line width only means something for drawn shapes and strokes.
        ["width", a.borderWidth !== undefined && STROKED.has(a.type) ? num(a.borderWidth) : undefined],
        ["flags", flagsToXfdf(a.flags)],
        ["name", a.id],
        ["title", a.author],
        ["creationdate", a.created],
        ["date", a.modified],
        ["icon", a.type === "Text" ? a.icon : undefined],
        ["coords", a.quadPoints ? list(a.quadPoints) : undefined],
        ["start", a.line ? `${num(a.line[0])},${num(a.line[1])}` : undefined],
        ["end", a.line ? `${num(a.line[2])},${num(a.line[3])}` : undefined],
      ];
      const attrText = attrs
        .filter((attr): attr is [string, string] => attr[1] !== undefined && attr[1] !== "")
        .map(([key, value]) => `${key}="${escapeXml(value)}"`)
        .join(" ");
      const children: string[] = [];
      if (a.contents) {
        children.push(`<contents>${escapeXml(a.contents)}</contents>`);
      }
      if (a.type === "FreeText") {
        const size = a.fontSize ?? 10;
        const color = a.fontColor ?? "#000000";
        const [r, g, b] = [1, 3, 5].map((i) => num(parseInt(color.slice(i, i + 2), 16) / 255));
        children.push(`<defaultappearance>/Helv ${num(size)} Tf ${r} ${g} ${b} rg</defaultappearance>`);
        children.push(`<defaultstyle>font: Helvetica ${num(size)}pt; color: ${color}</defaultstyle>`);
      }
      if (a.inkLists?.length) {
        children.push(`<inklist>${a.inkLists.map((g) => `<gesture>${points(g)}</gesture>`).join("")}</inklist>`);
      }
      if (a.vertices?.length) {
        children.push(`<vertices>${points(a.vertices)}</vertices>`);
      }
      lines.push(
        children.length
          ? `    <${element} ${attrText}>${children.join("")}</${element}>`
          : `    <${element} ${attrText}/>`
      );
      written++;
    }
  }
  lines.push("  </annots>", "</xfdf>");
  return { xml: `${lines.join("\n")}\n`, written, skipped };
}

// Readable names for annotation types, as XFDF elements or PDF subtypes.
const TYPE_LABELS: Record<string, [string, string]> = {
  text: ["note", "notes"],
  freetext: ["text box", "text boxes"],
  highlight: ["highlight", "highlights"],
  underline: ["underline", "underlines"],
  strikeout: ["strikethrough", "strikethroughs"],
  squiggly: ["squiggly underline", "squiggly underlines"],
  square: ["rectangle", "rectangles"],
  circle: ["ellipse", "ellipses"],
  line: ["line", "lines"],
  polygon: ["polygon", "polygons"],
  polyline: ["polyline", "polylines"],
  ink: ["drawing", "drawings"],
  stamp: ["stamp", "stamps"],
  caret: ["insertion mark", "insertion marks"],
  fileattachment: ["attached file", "attached files"],
  sound: ["sound", "sounds"],
  redact: ["redaction", "redactions"],
};

// "2 notes and 1 underline" from {Text: 2, underline: 1}.
export function describeTypeCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => {
      const [one, many] = TYPE_LABELS[type.toLowerCase()] ?? ["other annotation", "other annotations"];
      return `${n} ${n === 1 ? one : many}`;
    });
  if (parts.length <= 1) {
    return parts.join("");
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
