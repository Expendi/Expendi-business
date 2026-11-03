import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const url = process.env.QA_BASE_URL ?? "http://localhost:3003";
try {
  for (const reducedMotion of /** @type {const} */ ([
    "no-preference",
    "reduce",
  ])) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion,
    });
    await page.addInitScript(() =>
      localStorage.setItem("qonto-clone-consent", "declined"),
    );
    await page.goto(url);
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
    });
    const video = page.locator("#hero-video");
    if (reducedMotion === "reduce") {
      assert.equal(
        await video.getAttribute("src"),
        null,
        "Reduced motion must not load the hero video",
      );
      assert.equal(
        await video.evaluate((el) => getComputedStyle(el).opacity),
        "0",
      );
    } else {
      await page.waitForFunction(() => {
        const el = document.querySelector("#hero-video");
        return (
          el instanceof HTMLVideoElement &&
          !el.paused &&
          el.readyState >= 2 &&
          getComputedStyle(el).opacity === "1"
        );
      });
    }
    const glow = page.locator(
      '#section-protection [style*="--gradient-angle"]',
    );
    await glow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    const angle = () =>
      glow.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--gradient-angle"),
      );
    const first = await angle();
    await page.waitForTimeout(250);
    if (reducedMotion === "reduce") {
      assert.equal(first, "80deg");
      assert.equal(
        await angle(),
        first,
        "Reduced-motion protection glow must stay still",
      );
    } else {
      assert.notEqual(
        await angle(),
        first,
        "Visible protection glow must rotate",
      );
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" }),
      );
      await page.waitForTimeout(250);
      const paused = await angle();
      await page.waitForTimeout(250);
      assert.equal(
        await angle(),
        paused,
        "Offscreen protection glow must pause",
      );
    }
    const integrations = page.locator("#section-6");
    await integrations.scrollIntoViewIfNeeded();
    await integrations.locator("svg").waitFor();
    await page.waitForTimeout(700);
    const frame = () =>
      integrations.locator("svg").evaluate((el) => el.outerHTML);
    const before = await frame();
    await page.waitForTimeout(250);
    if (reducedMotion === "reduce") {
      assert.equal(
        await frame(),
        before,
        "Reduced-motion integrations must be static",
      );
    } else {
      assert.notEqual(
        await frame(),
        before,
        "Visible integrations must animate",
      );
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" }),
      );
      await page.waitForTimeout(250);
      const paused = await frame();
      await page.waitForTimeout(250);
      assert.equal(await frame(), paused, "Offscreen integrations must pause");
    }
    console.log(
      `PASS ${reducedMotion}: hero video, protection glow, integrations playback and offscreen gating`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
