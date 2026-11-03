import assert from "node:assert/strict";
import { chromium } from "playwright";

/** @typedef {import("playwright").Page} Page */
/** @typedef {import("playwright").Locator} Locator */
/** @typedef {"no-preference" | "reduce"} Motion */

// Run: node scripts/qa-overlays.mjs
// Override the running marketing server with QA_BASE_URL=http://localhost:3003.
const base = process.env.QA_BASE_URL ?? "http://localhost:3003";
const motions = /** @type {const} */ (["no-preference", "reduce"]);

/** @param {Locator} locator @param {string} property */
function style(locator, property) {
  return locator.evaluate(
    (element, key) => getComputedStyle(element).getPropertyValue(key),
    property,
  );
}

/**
 * @param {Page} page
 * @param {Locator} locator
 * @param {string} property
 * @param {string} expected
 */
async function expectStyle(page, locator, property, expected) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await style(locator, property)) === expected) return;
    await page.waitForTimeout(50);
  }
  assert.equal(await style(locator, property), expected, property);
}

/** @param {Page} page @param {number} top */
async function scroll(page, top) {
  await page.evaluate(
    (y) => window.scrollTo({ top: y, behavior: "instant" }),
    top,
  );
  // Allows ScrollTrigger, ResizeObserver and the longest measured tween to settle.
  await page.waitForTimeout(750);
}

/** @param {Page} page @param {number} width @param {Motion} motion */
async function verify(page, width, motion) {
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("qonto-clone-consent", "declined");
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const launcher = page.locator(
    "button[aria-controls][aria-label$='Qonto chatbot']",
  );
  const panel = page.locator('[role="dialog"][aria-label="Qonto chatbot"]');
  const bar = page.locator("[data-mobile-cta-visible]");
  const help = page
    .getByText("👋 Hello! Need help?", { exact: true })
    .locator("..");
  const badge = page.locator('[aria-hidden="true"]').filter({ hasText: /^1$/ });
  await scroll(page, 0);
  await expectStyle(page, launcher, "visibility", "hidden");
  await expectStyle(
    page,
    bar,
    width === 390 ? "visibility" : "display",
    width === 390 ? "hidden" : "none",
  );

  // Virtual time exercises the actual 30-second timer without a long test sleep.
  await page.clock.install();
  await page.clock.fastForward(31_000);
  await expectStyle(page, help, "visibility", "hidden");
  if (width === 390) {
    await scroll(page, 199);
    await expectStyle(page, bar, "opacity", "0");
    await scroll(page, 201);
    await expectStyle(page, bar, "opacity", "1");
    assert.equal(await style(bar, "height"), "72px");
    assert.equal(await style(bar, "backdrop-filter"), "blur(5px)");
    await expectStyle(page, launcher, "bottom", "80px");
    await expectStyle(page, panel, "bottom", "152px");
  }

  const heroBottom = await page
    .locator("main section")
    .first()
    .evaluate(
      (element) => element.getBoundingClientRect().bottom + window.scrollY,
    );
  await scroll(page, heroBottom - 1);
  await expectStyle(page, launcher, "visibility", "hidden");
  await scroll(page, heroBottom + 1);
  await expectStyle(page, launcher, "visibility", "visible");
  await page.clock.fastForward(15_000);
  await scroll(page, 0);
  await page.clock.fastForward(31_000);
  await expectStyle(page, help, "visibility", "hidden");
  // Returning to the hero cancels the pending hint; leaving starts a fresh delay.
  await scroll(page, heroBottom + 1);
  await page.clock.fastForward(27_000);
  await expectStyle(page, help, "visibility", "hidden");
  await page.clock.fastForward(4_000);
  await expectStyle(page, help, "opacity", "1");
  await expectStyle(page, badge, "opacity", "1");
  assert.equal(await style(help, "bottom"), width === 390 ? "84px" : "40px");
  assert.equal(await style(help, "right"), "100px");
  assert.equal(await style(help, "height"), "48px");
  assert.equal(await style(badge, "bottom"), width === 390 ? "120px" : "76px");
  assert.equal(await style(badge, "background-color"), "rgb(249, 86, 86)");
  // An already-shown hint hides over the hero and returns without another delay.
  await scroll(page, 0);
  await expectStyle(page, help, "visibility", "hidden");
  await scroll(page, heroBottom + 1);
  await expectStyle(page, help, "opacity", "1");

  if (motion === "no-preference") {
    await page.getByRole("button", { name: "Dismiss chat help" }).click();
    await expectStyle(page, help, "visibility", "hidden");
    await page.clock.fastForward(31_000);
    await expectStyle(page, help, "visibility", "hidden");
  }
  if (motion === "reduce") {
    const firstFrame = await page.evaluate(async () => {
      const button = document.querySelector(
        'button[aria-label="Open Qonto chatbot"]',
      );
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Chatbot launcher missing");
      }
      button.click();
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      const dialog = document.querySelector(
        '[role="dialog"][aria-label="Qonto chatbot"]',
      );
      if (!(dialog instanceof HTMLElement)) {
        throw new Error("Chatbot panel missing");
      }
      const computed = getComputedStyle(dialog);
      return { opacity: computed.opacity, transform: computed.transform };
    });
    assert.deepEqual(firstFrame, {
      opacity: "1",
      transform: "matrix(1, 0, 0, 1, 0, 0)",
    });
  } else {
    await launcher.click();
  }
  await expectStyle(page, panel, "opacity", "1");
  await expectStyle(page, help, "visibility", "hidden");
  await expectStyle(page, badge, "visibility", "hidden");
  assert.equal(await launcher.getAttribute("aria-expanded"), "true");
  assert.equal(await style(panel, "height"), "500px");
  assert.equal(await style(panel, "width"), width === 390 ? "390px" : "360px");
  assert.equal(await style(panel, "bottom"), width === 390 ? "152px" : "108px");

  const restart = page.getByRole("button", {
    name: "Start again",
    exact: true,
  });
  assert.equal(await restart.locator("svg").getAttribute("width"), "20");
  const flower = panel.locator('div[aria-hidden="true"] > svg');
  await flower.waitFor();
  const oldFlower = await flower.elementHandle();
  assert.ok(oldFlower);
  await restart.click();
  await flower.waitFor();
  assert.equal(
    await oldFlower.evaluate((element) => element.isConnected),
    false,
  );
  await oldFlower.dispose();
  assert.equal(await launcher.getAttribute("aria-expanded"), "true");
  if (motion === "reduce") {
    const before = await flower.innerHTML();
    await page.waitForTimeout(350);
    assert.equal(
      await flower.innerHTML(),
      before,
      "Reduced-motion flower must stay static",
    );
    assert.equal(await style(panel, "transform"), "matrix(1, 0, 0, 1, 0, 0)");
  }

  await scroll(page, 0);
  await expectStyle(page, launcher, "visibility", "visible");
  await page.keyboard.press("Escape");
  await expectStyle(page, panel, "visibility", "hidden");
  assert.equal(await launcher.getAttribute("aria-expanded"), "false");
  await scroll(page, heroBottom + 1);
  await page.clock.fastForward(31_000);
  await expectStyle(page, help, "visibility", "hidden");

  if (width === 390) {
    const lightProbe = await page
      .locator('main [data-header-theme="light"]')
      .first()
      .evaluate(
        (element) =>
          element.getBoundingClientRect().top +
          window.scrollY -
          window.innerHeight +
          92,
      );
    await scroll(page, lightProbe);
    await expectStyle(
      page,
      bar,
      "background-color",
      "rgba(255, 255, 255, 0.7)",
    );
    const footerEntry = await page
      .locator("footer")
      .evaluate(
        (element) =>
          element.getBoundingClientRect().top +
          window.scrollY -
          window.innerHeight,
      );
    await scroll(page, footerEntry - 1);
    await expectStyle(page, bar, "opacity", "1");
    await expectStyle(page, launcher, "bottom", "80px");
    await scroll(page, footerEntry + 1);
    await expectStyle(page, bar, "visibility", "hidden");
    assert.equal(await style(bar, "pointer-events"), "none");
    await expectStyle(page, launcher, "bottom", "36px");
    await expectStyle(page, panel, "bottom", "108px");
  }
  await scroll(page, 1_000_000);
  await expectStyle(page, launcher, "visibility", "visible");
  await expectStyle(page, launcher, "bottom", "36px");
  await scroll(page, heroBottom + 100);
  await page.setViewportSize({
    width: width === 390 ? 1440 : 390,
    height: 844,
  });
  await expectStyle(page, launcher, "bottom", width === 390 ? "36px" : "80px");
  assert.deepEqual(errors, [], "Unexpected page errors");
  console.log(JSON.stringify({ width, motion, heroBottom, status: "pass" }));
}

const browser = await chromium.launch();
try {
  for (const width of [1440, 390]) {
    for (const motion of motions) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        reducedMotion: motion,
      });
      try {
        await verify(await context.newPage(), width, motion);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
