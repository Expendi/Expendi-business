import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** @typedef {{text: string, x: number, y: number, height: number, color?: string, font?: string}} Heading */
/** @typedef {{top: number, height: number, headings: Heading[]}} Section */
/** @typedef {{geometry: Section[], errors: string[], brokenImages: string[], documentSize: {width: number, height: number}}} Snapshot */

const directory = new URL("../docs/design-references/qa/", import.meta.url);
const rawDirectory = new URL("../docs/research/raw/", import.meta.url);
const names = [
  "hero",
  "trust",
  "bento",
  "ai",
  "invoicing",
  "integrations",
  "company",
  "company-media",
  "testimonials",
  "protection",
  "cta",
  "footer",
];
// Document heights recorded in PAGE_TOPOLOGY.md before the live AI redesign.
const heights = new Map([
  [1440, 9336],
  [768, 12104],
  [390, 11046],
]);

/** @param {string} text @returns {{x: number, y: number, width: number, height: number} | null} */
function box(text) {
  const match = /\[(-?[\d.]+),(-?[\d.]+) ([\d.]+)x([\d.]+)\]/.exec(text);
  if (!match) return null;
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
  };
}

/** @param {number} width @returns {Promise<Snapshot>} */
async function originalReference(width) {
  const geometry = await Promise.all(
    names.map(async (name) => {
      const raw = await readFile(
        new URL(`${name}-${width}.txt`, rawDirectory),
        "utf8",
      );
      const lines = raw.split("\n");
      const section = box(lines[0] ?? "");
      /** @type {Heading[]} */
      const headings = [];
      for (const line of lines) {
        if (!/^\s*h[123][.#\s]/.test(line)) continue;
        const position = box(line);
        const text = /\] "([^"]+)"/.exec(line)?.[1];
        if (!position?.height || !text) continue;
        const font = /font=([\d.]+px)\/([\d.]+px) w(\d+)/.exec(line);
        headings.push({
          text,
          ...position,
          font: font ? `${font[3]} ${font[1]} / ${font[2]}` : undefined,
        });
      }
      return { top: section?.y ?? 0, height: section?.height ?? 0, headings };
    }),
  );
  const height = heights.get(width);
  assert.ok(height);
  return {
    geometry,
    errors: [],
    brokenImages: [],
    documentSize: { width, height },
  };
}

for (const width of [1440, 768, 390]) {
  const reference =
    process.env.QA_REFERENCE === "live"
      ? /** @type {Snapshot} */ (
          JSON.parse(
            await readFile(
              new URL(`reference-${width}.json`, directory),
              "utf8",
            ),
          )
        )
      : await originalReference(width);
  const clone = /** @type {Snapshot} */ (
    JSON.parse(
      await readFile(new URL(`clone-${width}.json`, directory), "utf8"),
    )
  );
  assert.deepEqual(clone.errors, [], `${width}: browser runtime errors`);
  assert.deepEqual(clone.brokenImages, [], `${width}: broken images`);
  assert.equal(
    clone.documentSize.width,
    width,
    `${width}: horizontal overflow`,
  );
  assert.ok(
    Math.abs(reference.documentSize.height - clone.documentSize.height) <= 1,
    `${width}: document height differs`,
  );
  assert.equal(clone.geometry.length, reference.geometry.length);
  let headingCount = 0;
  for (const [index, expected] of reference.geometry.entries()) {
    /** @type {Section | undefined} */
    const actual = clone.geometry[index];
    assert.ok(actual);
    assert.ok(
      Math.abs(expected.top - actual.top) <= 1,
      `${width}: ${names[index]} top differs`,
    );
    // The source's small-screen footer content overflows a fixed-height wrapper.
    if (index !== names.length - 1)
      assert.ok(
        Math.abs(expected.height - actual.height) <= 1,
        `${width}: ${names[index]} height differs`,
      );
    /** @type {Heading[]} */
    const remaining = [...actual.headings];
    for (const heading of expected.headings) {
      const matchIndex = remaining.findIndex((h) =>
        h.text.replace(/\s/g, "").startsWith(heading.text.replace(/\s/g, "")),
      );
      /** @type {Heading | undefined} */
      const match = remaining[matchIndex];
      assert.ok(match, `${width}: missing heading ${heading.text}`);
      remaining.splice(matchIndex, 1);
      for (const property of /** @type {const} */ (["x", "y", "height"]))
        assert.ok(
          Math.abs(match[property] - heading[property]) <= 1,
          `${width}: ${heading.text} ${property} differs`,
        );
      if (heading.color)
        assert.equal(
          match.color,
          heading.color,
          `${width}: ${heading.text} color differs`,
        );
      if (heading.font)
        assert.equal(
          match.font?.replace(/\s+qontoSans.*$/i, ""),
          heading.font.replace(/\s+qontoSans.*$/i, ""),
          `${width}: ${heading.text} typography differs`,
        );
      headingCount++;
    }
  }
  console.log(
    `PASS ${width}px: original section geometry, ${headingCount} measured headings, document bounds, images and runtime errors`,
  );
}
