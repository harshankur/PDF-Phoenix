// Turns the annotations the viewer collected from a PDF into a Markdown
// summary for the "Export Annotations to Markdown" command. Kept free of
// VS Code APIs so it can be unit-tested directly.

export interface ExportedAnnotation {
  // The PDF annotation subtype, e.g. "Highlight", "Text", "FreeText", "Ink".
  type: string;
  // For highlights and other text markup: the page text they cover.
  text?: string;
  // The annotation's own note or text box contents.
  contents?: string;
  author?: string;
  // "#RRGGBB" when the annotation has a color.
  color?: string;
  // The PDF date string ("D:YYYYMMDDHHmmSS...") it was last modified.
  modified?: string;

  // Geometry and styling, in PDF page coordinates, for the XFDF export.
  // The Markdown export doesn't use these.
  id?: string;
  rect?: number[];
  quadPoints?: number[];
  inkLists?: number[][];
  vertices?: number[];
  // Line annotations: [x1, y1, x2, y2].
  line?: number[];
  interiorColor?: string;
  opacity?: number;
  borderWidth?: number;
  created?: string;
  // A note's icon name ("Comment", "Note", ...).
  icon?: string;
  // Text box font size and "#RRGGBB" color.
  fontSize?: number;
  fontColor?: string;
  flags?: number;
}

export interface ExportedPage {
  pageNumber: number;
  // The page's printed label when the PDF defines one (e.g. "iv").
  label?: string;
  annotations: ExportedAnnotation[];
}

const TYPE_NAMES: Record<string, string> = {
  Highlight: "Highlight",
  Underline: "Underline",
  StrikeOut: "Strikethrough",
  Squiggly: "Squiggly underline",
  Text: "Note",
  FreeText: "Text box",
  Ink: "Drawing",
  Stamp: "Stamp",
  Square: "Rectangle",
  Circle: "Ellipse",
  Line: "Line",
  Polygon: "Polygon",
  PolyLine: "Polyline",
  Caret: "Insertion mark",
  FileAttachment: "Attached file",
};

// Escape characters Markdown would otherwise treat as formatting, so text
// from the PDF comes out exactly as written.
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>#|~]/g, (c) => `\\${c}`);
}

// "D:20261018093000+02'00'" -> "2026-10-18". Anything else -> undefined.
export function pdfDateToIso(value: string | undefined): string | undefined {
  const match = value ? /^(?:D:)?(\d{4})(\d{2})?(\d{2})?/.exec(value) : null;
  if (!match) {
    return undefined;
  }
  return [match[1], match[2] ?? "01", match[3] ?? "01"].join("-");
}

function quote(text: string, indent: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `${indent}> ${escapeMarkdown(line)}`);
}

export function countAnnotations(pages: ExportedPage[]): number {
  return pages.reduce((sum, page) => sum + page.annotations.length, 0);
}

export function annotationsToMarkdown(fileName: string, pages: ExportedPage[], exportedOn: Date): string {
  const withAnnotations = pages.filter((page) => page.annotations.length > 0);
  const total = countAnnotations(withAnnotations);
  const day = exportedOn.toISOString().slice(0, 10);
  const lines: string[] = [
    `# Annotations: ${escapeMarkdown(fileName)}`,
    "",
    `_Exported from PDF Phoenix on ${day}: ${total} annotation${total === 1 ? "" : "s"} on ` +
      `${withAnnotations.length} page${withAnnotations.length === 1 ? "" : "s"}._`,
  ];

  for (const page of withAnnotations) {
    const label = page.label && page.label !== String(page.pageNumber) ? ` (${escapeMarkdown(page.label)})` : "";
    lines.push("", `## Page ${page.pageNumber}${label}`, "");
    for (const annotation of page.annotations) {
      const details = [annotation.color, annotation.author ? `by ${escapeMarkdown(annotation.author)}` : undefined, pdfDateToIso(annotation.modified)]
        .filter(Boolean)
        .join(", ");
      const name = TYPE_NAMES[annotation.type] ?? escapeMarkdown(annotation.type);
      lines.push(`- **${name}**${details ? ` (${details})` : ""}`);
      if (annotation.text) {
        lines.push(...quote(annotation.text, "  "));
      }
      if (annotation.contents) {
        const contentLines = annotation.contents
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        // A highlight's note sits under the quoted passage; a note or text
        // box is its contents.
        if (annotation.text) {
          lines.push("", ...contentLines.map((line) => `  ${escapeMarkdown(line)}`));
        } else {
          lines.push(...contentLines.map((line) => `  ${escapeMarkdown(line)}`));
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
