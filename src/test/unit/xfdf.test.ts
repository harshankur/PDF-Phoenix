import * as assert from "node:assert";
import { annotationsToXfdf, describeTypeCounts, escapeXml, flagsToXfdf } from "../../xfdf";

describe("annotationsToXfdf", () => {
  it("writes each annotation type as its XFDF element with geometry and notes", () => {
    const { xml, written, skipped } = annotationsToXfdf("paper & notes.pdf", { original: "AB12", modified: "CD34" }, [
      {
        pageNumber: 1,
        annotations: [
          {
            type: "Highlight",
            rect: [132, 694, 241, 722],
            quadPoints: [132, 722, 241, 722, 132, 694, 241, 694],
            color: "#FFFF00",
            contents: "Check <this> & that",
            author: "Ana",
            modified: "D:20261001120000Z",
            id: "8R",
            flags: 4,
          },
          { type: "Text", rect: [400, 650, 420, 670], color: "#FFCC00", contents: "A note", icon: "Comment" },
        ],
      },
      {
        pageNumber: 2,
        annotations: [
          {
            type: "Ink",
            rect: [10, 10, 50, 50],
            color: "#1E90FF",
            borderWidth: 3,
            opacity: 0.5,
            inkLists: [[10.123456, 20, 30, 40], [1, 2, 3, 4]],
          },
          { type: "FreeText", rect: [300, 500, 500, 540], contents: "A text box", fontSize: 14, fontColor: "#AA0000" },
          { type: "Line", rect: [0, 0, 100, 100], line: [1, 2, 99, 98], color: "#000000" },
          { type: "Polygon", rect: [0, 0, 10, 10], vertices: [0, 0, 10, 0, 5, 10] },
          { type: "Stamp", rect: [0, 0, 10, 10] },
        ],
      },
    ]);

    assert.strictEqual(written, 6);
    assert.deepStrictEqual(skipped, { Stamp: 1 });
    const lines = xml.split("\n");
    assert.strictEqual(lines[0], '<?xml version="1.0" encoding="UTF-8"?>');
    assert.strictEqual(lines[1], '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">');
    assert.strictEqual(lines[2], '  <f href="paper &amp; notes.pdf"/>');
    assert.strictEqual(lines[3], '  <ids original="AB12" modified="CD34"/>');
    assert.strictEqual(
      lines[5],
      '    <highlight page="0" rect="132,694,241,722" color="#FFFF00" flags="print" name="8R" title="Ana" ' +
        'date="D:20261001120000Z" coords="132,722,241,722,132,694,241,694">' +
        "<contents>Check &lt;this&gt; &amp; that</contents></highlight>"
    );
    assert.strictEqual(
      lines[6],
      '    <text page="0" rect="400,650,420,670" color="#FFCC00" icon="Comment"><contents>A note</contents></text>'
    );
    assert.strictEqual(
      lines[7],
      '    <ink page="1" rect="10,10,50,50" color="#1E90FF" opacity="0.5" width="3">' +
        "<inklist><gesture>10.1235,20;30,40</gesture><gesture>1,2;3,4</gesture></inklist></ink>"
    );
    assert.strictEqual(
      lines[8],
      '    <freetext page="1" rect="300,500,500,540"><contents>A text box</contents>' +
        "<defaultappearance>/Helv 14 Tf 0.6667 0 0 rg</defaultappearance>" +
        "<defaultstyle>font: Helvetica 14pt; color: #AA0000</defaultstyle></freetext>"
    );
    assert.strictEqual(lines[9], '    <line page="1" rect="0,0,100,100" color="#000000" start="1,2" end="99,98"/>');
    assert.strictEqual(lines[10], '    <polygon page="1" rect="0,0,10,10"><vertices>0,0;10,0;5,10</vertices></polygon>');
    assert.strictEqual(lines[11], "  </annots>");
  });

  it("leaves out <ids> when the document has none", () => {
    const { xml } = annotationsToXfdf("a.pdf", {}, []);
    assert.ok(!xml.includes("<ids"));
    assert.ok(xml.includes("<annots>\n  </annots>"));
  });
});

describe("XFDF helpers", () => {
  it("escapes XML and drops characters XML can't hold", () => {
    assert.strictEqual(escapeXml(`<a href="x">&</a>\u0001`), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("names annotation flags", () => {
    assert.strictEqual(flagsToXfdf(4), "print");
    assert.strictEqual(flagsToXfdf(4 | 64 | 128), "print,readonly,locked");
    assert.strictEqual(flagsToXfdf(0), undefined);
  });

  it("describes counts of annotation types in words", () => {
    assert.strictEqual(describeTypeCounts({ text: 2 }), "2 notes");
    assert.strictEqual(describeTypeCounts({ text: 2, underline: 1 }), "2 notes and 1 underline");
    assert.strictEqual(describeTypeCounts({ Stamp: 1, square: 3, circle: 1 }), "1 stamp, 3 rectangles and 1 ellipse");
    assert.strictEqual(describeTypeCounts({}), "");
  });
});
