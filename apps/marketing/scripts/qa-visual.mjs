import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const output = new URL("../docs/design-references/qa/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const targets = /** @type {[string, string][]} */ ([
  ["reference", "https://qonto.com/en"],
  ["clone", process.env.QA_BASE_URL ?? "http://localhost:3003"],
]).filter(([name]) => !process.env.QA_TARGET || process.env.QA_TARGET === name);
try {
  for (const [name, url] of targets) {
    for (const { width, height } of [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport: { width, height } });
      /** @type {string[]} */
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const decline = page
        .getByText("Continue without agreeing", { exact: false })
        .first();
      await page.waitForTimeout(3000);
      if (await decline.isVisible()) await decline.click();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1200);
      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = "auto";
        for (const element of document.querySelectorAll("*")) {
          if (getComputedStyle(element).position === "fixed")
            element.setAttribute("data-qa-fixed", "");
        }
      });
      const sectionStyle =
        "[data-qa-fixed], nextjs-portal { visibility: hidden !important; }";
      const sections = page.locator("main section, footer");
      const count = await sections.count();
      for (let i = 0; i < count; i++) {
        const section = sections.nth(i);
        if (!(await section.isVisible())) continue;
        await section.scrollIntoViewIfNeeded();
        await page.waitForTimeout(650);
        await page.evaluate(() => {
          for (const element of document.querySelectorAll("*")) {
            if (getComputedStyle(element).position === "fixed")
              element.setAttribute("data-qa-fixed", "");
          }
        });
        if (process.env.QA_MEASURE_ONLY === "1") continue;
        const path = new URL(`${name}-${width}-section-${i + 1}.png`, output)
          .pathname;
        if (await section.evaluate((el) => el.tagName === "FOOTER")) {
          const clip = await section.evaluate((el) => {
            const top = el.getBoundingClientRect().top + scrollY;
            return {
              x: 0,
              y: top,
              width: innerWidth,
              height: document.documentElement.scrollHeight - top,
            };
          });
          await page.screenshot({
            path,
            clip,
            fullPage: true,
            style: sectionStyle,
          });
        } else {
          await section.screenshot({ path, style: sectionStyle });
        }
      }
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" }),
      );
      await page.waitForTimeout(650);
      if (process.env.QA_MEASURE_ONLY !== "1")
        await page.screenshot({
          path: new URL(`${name}-${width}-full.png`, output).pathname,
          fullPage: true,
          style: "nextjs-portal { visibility: hidden !important; }",
        });
      const geometry = await sections.evaluateAll((elements) =>
        elements.map((el) => {
          const rect = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            id: el.id,
            top: rect.top + scrollY,
            height: rect.height,
            width: rect.width,
            background: cs.backgroundColor,
            heading: el.querySelector("h1,h2")?.textContent?.trim(),
            text: el.textContent?.replace(/\s+/g, " ").trim(),
            headings: [...el.querySelectorAll("h1,h2,h3")]
              .filter((h) => h.getBoundingClientRect().height)
              .map((h) => {
                const r = h.getBoundingClientRect();
                const s = getComputedStyle(h);
                return {
                  text: h.textContent?.trim(),
                  x: r.x,
                  y: r.y + scrollY,
                  width: r.width,
                  height: r.height,
                  font: `${s.fontWeight} ${s.fontSize} / ${s.lineHeight}`,
                  color: s.color,
                };
              }),
          };
        }),
      );
      const images = await page.evaluate(() =>
        [...document.images]
          .filter((e) => e.currentSrc && e.complete && !e.naturalWidth)
          .map((e) => e.currentSrc),
      );
      const documentSize = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      }));
      await writeFile(
        new URL(`${name}-${width}.json`, output),
        JSON.stringify(
          { geometry, documentSize, errors, brokenImages: images },
          null,
          2,
        ),
      );
      console.log(
        name,
        width,
        geometry.map(({ id, top, height }) => ({ id, top, height })),
        { errors, brokenImages: images },
      );
      await page.close();
    }
  }
} finally {
  await browser.close();
}
