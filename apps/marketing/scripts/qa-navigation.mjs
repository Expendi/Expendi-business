import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

/** @typedef {import("playwright").Page} Page */
/** @typedef {import("playwright").Locator} Locator */
/** @typedef {"no-preference" | "reduce"} Motion */

// pnpm exec node scripts/qa-navigation.mjs
// QA_BASE_URL=http://localhost:3003 QA_OUTPUT=.cache/qa-navigation node scripts/qa-navigation.mjs
const base = process.env.QA_BASE_URL ?? "http://localhost:3003";
const output = process.env.QA_OUTPUT ?? "docs/design-references/qa-navigation";
const titles = [
  "Business account",
  "Company creation",
  "Financial tools",
  "Credit",
  "Pricing",
  "About us",
];
const purposes = [
  "functional",
  "audience",
  "personalization",
  "advertising",
  "advertising-partners",
  "marketing",
  "analytics",
];
const motions = /** @type {const} */ (["no-preference", "reduce"]);
/** @type {{ name: string, status: "pass" | "fail", evidence?: unknown, error?: string }[]} */
const results = [];
/** @type {{ width: number, reducedMotion: Motion, message: string }[]} */
const errors = [];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });

/** @param {string} name @param {() => Promise<unknown>} run */
async function check(name, run) {
  try {
    const evidence = await run();
    results.push({ name, status: "pass", evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, status: "fail", error: message });
    console.error(`FAIL ${name}: ${message}`);
  }
}

/** @param {number} width @param {Motion} reducedMotion @param {boolean} consent */
async function createPage(
  width,
  reducedMotion = "no-preference",
  consent = true,
) {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    reducedMotion,
    hasTouch: width < 1024,
  });
  if (consent)
    await context.addInitScript(() =>
      localStorage.setItem("qonto-clone-consent", "declined"),
    );
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) =>
    errors.push({ width, reducedMotion, message: error.message }),
  );
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#navigation").waitFor();
  await page.waitForTimeout(900);
  return { context, page };
}

/** @param {Locator} locator @param {keyof CSSStyleDeclaration} property */
async function style(locator, property) {
  return locator.evaluate((el, key) => getComputedStyle(el)[key], property);
}

/** @param {Locator} button @param {boolean} value */
async function expanded(button, value) {
  assert.equal(await button.getAttribute("aria-expanded"), String(value));
}

/** @param {Page} page @param {Locator} button */
async function panelFor(page, button) {
  const id = await button.getAttribute("aria-controls");
  return page.locator(`[id=${JSON.stringify(id)}]`);
}

/** @param {Page} page @param {number} top */
async function scrollTo(page, top) {
  await page.evaluate(
    (y) => window.scrollTo({ top: y, behavior: "instant" }),
    top,
  );
  await page.waitForTimeout(650);
}

/** @param {Page} page @param {Locator} button */
async function countries(page, button) {
  await button.hover();
  await expanded(button, true);
  const panel = await panelFor(page, button);
  await panel.getByText("Select your country", { exact: true }).waitFor();
  const links = await panel.locator("a").evaluateAll((els) =>
    els.map((el) => ({
      text: el.textContent.trim(),
      href: el.getAttribute("href"),
    })),
  );
  for (const country of [
    "France",
    "Deutschland",
    "Italia",
    "España",
    "België",
    "Nederland",
    "Portugal",
    "Österreich",
  ]) {
    assert.ok(
      links.find(
        (link) =>
          link.text === country &&
          /^https:\/\/qonto.com\//.test(link.href ?? ""),
      ),
      country,
    );
  }
  await panel.getByRole("link", { name: "France", exact: true }).hover();
  await expanded(button, true);
  await page.keyboard.press("Escape");
  await expanded(button, false);
  await button.focus();
  await page.keyboard.press("Enter");
  await expanded(button, true);
  await page.mouse.click(5, 500);
  await expanded(button, false);
  return links;
}

try {
  for (const reducedMotion of motions) {
    const { context, page } = await createPage(1440, reducedMotion);
    const suffix = `desktop / ${reducedMotion}`;
    for (const [index, title] of titles.entries()) {
      await check(`${suffix} / ${title}`, async () => {
        const trigger = page
          .locator("#navigation")
          .getByRole("button", { name: title, exact: true });
        await trigger.hover();
        await expanded(trigger, true);
        const panel = page.locator(`#navigation-item-${index}`);
        await panel.waitFor({ state: "visible" });
        const links = panel.locator("[data-submenu-item]");
        assert.ok((await links.count()) > 0);
        await links.first().hover();
        await page.waitForTimeout(550);
        await expanded(trigger, true);
        assert.equal(
          await style(page.locator("#navigation"), "backgroundColor"),
          "rgb(255, 255, 255)",
        );
        assert.equal(await style(links.first(), "color"), "rgb(5, 5, 5)");
        assert.equal(await style(links.nth(1), "color"), "rgb(97, 97, 97)");
        const box = await panel.boundingBox();
        assert.ok(box);
        assert.ok(box.x >= 0 && box.x + box.width <= 1440, JSON.stringify(box));
        if (reducedMotion === "no-preference")
          await page.screenshot({
            path: `${output}/desktop-menu-${index}.png`,
          });
        await page.mouse.move(10, 700);
        await expanded(trigger, false);
        await trigger.focus();
        await page.keyboard.press("Enter");
        await expanded(trigger, true);
        await page.keyboard.press("Escape");
        await expanded(trigger, false);
        return { links: await links.count(), box };
      });
    }
    await check(`${suffix} / country picker`, () =>
      countries(
        page,
        page
          .locator("#navigation")
          .getByRole("button", { name: "Change language", exact: true }),
      ),
    );
    await check(`${suffix} / sign-in hover`, async () => {
      const link = page
        .locator("#navigation")
        .getByRole("link", { name: "Sign in", exact: true });
      await link.hover();
      assert.equal(await style(link, "color"), "rgb(97, 97, 97)");
    });
    await page.mouse.move(5, 500);
    await check(`${suffix} / section themes both directions`, async () => {
      const sections = await page
        .locator("[data-header-theme]")
        .evaluateAll((els) =>
          els.map((el) => ({
            top: el.getBoundingClientRect().top + scrollY,
            theme: el.dataset.headerTheme,
            id: el.id,
          })),
        );
      const checked = [];
      for (const section of [...sections, ...sections.slice().reverse()]) {
        const y = Math.max(0, section.top - 80 + 3);
        const canReach = await page.evaluate(
          (target) =>
            target <= document.documentElement.scrollHeight - innerHeight,
          y,
        );
        if (!canReach) continue;
        await scrollTo(page, y);
        assert.equal(
          await page
            .locator("#navigation")
            .evaluate((el) => el.classList.contains("darkmode")),
          section.theme === "dark",
          `${section.id} y=${y}`,
        );
        assert.equal((await page.locator("#navigation").boundingBox())?.y, 0);
        checked.push(section);
      }
      return checked;
    });
    await check(`${suffix} / footer locale and underline`, async () => {
      const button = page
        .locator("footer")
        .getByRole("button", {
          name: "Change language, current: en",
          exact: true,
        })
        .filter({ visible: true });
      await button.scrollIntoViewIfNeeded();
      const links = await countries(page, button);
      const link = page.locator("footer .footer-link-underline").first();
      await link.hover();
      await page.waitForTimeout(250);
      assert.equal(await style(link, "backgroundSize"), "100% 1px");
      await page.mouse.move(5, 300);
      await page.waitForTimeout(250);
      assert.equal(await style(link, "backgroundSize"), "0% 1px");
      return links;
    });
    await context.close();

    for (const width of [390, 768]) {
      const { context: mobileContext, page: mobile } = await createPage(
        width,
        reducedMotion,
      );
      const hamburger = mobile.locator('button[aria-controls="nav-menu"]');
      const suffix = `${width}px / ${reducedMotion}`;
      await check(`${suffix} / drawer and all six submenus`, async () => {
        await hamburger.tap();
        await expanded(hamburger, true);
        if (reducedMotion === "reduce")
          assert.equal((await mobile.locator("#nav-menu").boundingBox())?.x, 0);
        assert.equal(
          await mobile.evaluate(() => document.body.style.overflow),
          "hidden",
        );
        for (const title of titles) {
          await mobile
            .locator("#nav-menu")
            .getByRole("button", { name: title, exact: true })
            .tap();
          const region = mobile.getByRole("region", {
            name: title,
            exact: true,
            includeHidden: true,
          });
          await region.waitFor({ state: "visible" });
          assert.ok((await region.getByRole("link").count()) > 0);
          await mobile
            .getByRole("button", { name: "Back to navigation" })
            .tap();
          await mobile.waitForTimeout(350);
          assert.equal(await region.getAttribute("inert"), "");
        }
        const language = mobile
          .locator("#nav-menu")
          .getByRole("button", { name: "Change language" });
        await language.tap();
        await expanded(language, true);
        const panel = await panelFor(mobile, language);
        assert.equal(await panel.getByRole("link").count(), 9);
        await language.tap();
        await expanded(language, false);
        await mobile.screenshot({
          path: `${output}/mobile-${width}-${reducedMotion}.png`,
        });
        await hamburger.tap();
        await expanded(hamburger, false);
        if (reducedMotion === "no-preference") {
          assert.equal(
            await style(mobile.locator("#nav-menu"), "visibility"),
            "visible",
            "closing drawer should slide before hiding",
          );
        }
        await mobile.waitForTimeout(reducedMotion === "reduce" ? 0 : 400);
        assert.equal(
          await style(mobile.locator("#nav-menu"), "visibility"),
          "hidden",
        );
        assert.equal(
          await mobile.evaluate(() => document.body.style.overflow),
          "",
        );
        await hamburger.click();
        await mobile.keyboard.press("Escape");
        await expanded(hamburger, false);
      });
      await check(`${suffix} / breakpoint clears stale drawer`, async () => {
        if ((await hamburger.getAttribute("aria-expanded")) === "true")
          await hamburger.click();
        await hamburger.click();
        await expanded(hamburger, true);
        await mobile.setViewportSize({ width: 1440, height: 900 });
        await mobile.waitForTimeout(400);
        assert.equal(
          await mobile.evaluate(() => document.body.style.overflow),
          "",
        );
        await mobile.setViewportSize({ width, height: 844 });
        await mobile.waitForTimeout(400);
        await expanded(hamburger, false);
      });
      await check(`${suffix} / mobile themes and footer locale`, async () => {
        const lightTop = await mobile
          .locator('[data-header-theme="light"]')
          .first()
          .evaluate((el) => el.getBoundingClientRect().top + scrollY);
        await scrollTo(mobile, lightTop - 64 + 3);
        assert.equal(
          await mobile
            .locator("#navigation")
            .evaluate((el) => el.classList.contains("darkmode")),
          false,
        );
        await scrollTo(mobile, 0);
        assert.equal(
          await mobile
            .locator("#navigation")
            .evaluate((el) => el.classList.contains("darkmode")),
          true,
        );
        const button = mobile
          .locator("footer")
          .getByRole("button", {
            name: "Change language, current: en",
            exact: true,
          })
          .filter({ visible: true });
        await button.scrollIntoViewIfNeeded();
        await button.tap();
        await expanded(button, true);
        const panel = await panelFor(mobile, button);
        const box = await panel.boundingBox();
        assert.ok(
          box && box.x >= 0 && box.x + box.width <= width,
          JSON.stringify(box),
        );
        assert.equal(await panel.getByRole("link").count(), 8);
        await button.tap();
        await expanded(button, false);
      });
      await mobileContext.close();
    }
  }

  const { context: narrowContext, page: narrow } = await createPage(1024);
  await check("1024px / all desktop panels fit viewport", async () => {
    for (const [index, title] of titles.entries()) {
      await narrow
        .locator("#navigation")
        .getByRole("button", { name: title, exact: true })
        .hover();
      const box = await narrow
        .locator(`#navigation-item-${index}`)
        .boundingBox();
      assert.ok(box);
      assert.ok(
        box.x >= 0 && box.x + box.width <= 1024,
        `${title}: ${JSON.stringify(box)}`,
      );
    }
    await narrow.screenshot({ path: `${output}/desktop-1024.png` });
  });
  await narrowContext.close();

  for (const choice of ["declined", "accepted", "customized"]) {
    for (const reducedMotion of motions) {
      for (const width of [1440, 390]) {
        const { context, page } = await createPage(width, reducedMotion, false);
        await check(
          `consent / ${choice} / ${width}px / ${reducedMotion}`,
          async () => {
            const dialog = page.getByRole("dialog");
            await dialog.waitFor();
            assert.equal(
              await page.evaluate(
                () => document.documentElement.style.overflow,
              ),
              "hidden",
            );
            if (choice === "customized") {
              await dialog
                .getByRole("button", { name: "Find out more" })
                .click();
              const save = dialog.getByRole("button", {
                name: "Save",
                exact: true,
              });
              assert.equal(await save.isDisabled(), true);
              await dialog
                .getByRole("group", { name: "All purposes", exact: true })
                .getByRole("button", { name: "Disagree", exact: true })
                .click();
              await dialog
                .getByRole("group", { name: "Analytics", exact: true })
                .getByRole("button", { name: "Agree", exact: true })
                .click();
              assert.equal(await save.isEnabled(), true);
              await save.click();
            } else {
              const button = dialog.getByRole("button", {
                name:
                  choice === "accepted"
                    ? "Accept"
                    : "Continue without agreeing",
                exact: choice === "accepted",
              });
              if (width >= 1024) {
                await button.hover();
                assert.equal(await style(button, "opacity"), "0.7");
              }
              await button.click();
            }
            await dialog.waitFor({ state: "detached" });
            assert.equal(
              await page.evaluate(
                () => document.documentElement.style.overflow,
              ),
              "",
            );
            const stored = await page.evaluate(() =>
              localStorage.getItem("qonto-clone-consent"),
            );
            assert.ok(stored);
            if (choice === "customized") {
              const saved = JSON.parse(stored);
              assert.equal(saved.choice, "customized");
              assert.deepEqual(
                saved.purposes,
                Object.fromEntries(
                  purposes.map((id) => [id, id === "analytics"]),
                ),
              );
            } else assert.equal(stored, choice);
            await page.reload({ waitUntil: "domcontentloaded" });
            await page.waitForTimeout(1100);
            assert.equal(await page.getByRole("dialog").count(), 0);
            return { stored };
          },
        );
        await context.close();
      }
    }
  }
  await check("no browser runtime errors", async () =>
    assert.deepEqual(errors, []),
  );
  if (process.env.QA_REFERENCE === "1") {
    for (const width of [1440, 1024]) {
      await check(`live reference / ${width}px menu geometry`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        try {
          await page.goto("https://qonto.com/en", {
            waitUntil: "domcontentloaded",
          });
          await page.waitForTimeout(2500);
          const decline = page
            .getByText("Continue without agreeing", { exact: false })
            .first();
          if (await decline.isVisible()) await decline.click();
          const geometry = [];
          for (const [index, title] of titles.entries()) {
            const trigger = page
              .locator("#navigation")
              .getByRole("button", { name: title, exact: true })
              .filter({ visible: true });
            const box = await trigger.boundingBox();
            assert.ok(box);
            // The source deliberately places a transparent hover target over its button.
            await page.mouse.move(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
            await page.waitForTimeout(600);
            const panel = page.locator(`#navigation-item-${index}`);
            await panel.waitFor({ state: "visible" });
            geometry.push({ title, box: await panel.boundingBox() });
            await page.screenshot({
              path: `${output}/reference-${width}-menu-${index}.png`,
            });
          }
          return geometry;
        } finally {
          await page.close();
        }
      });
    }
  }
} finally {
  await browser.close();
  await writeFile(
    `${output}/results.json`,
    JSON.stringify({ base, results, errors }, null, 2),
  );
}
const failed = results.filter(({ status }) => status === "fail");
console.log(
  `${results.length - failed.length}/${results.length} checks passed. Evidence: ${output}/results.json`,
);
if (failed.length) process.exitCode = 1;
