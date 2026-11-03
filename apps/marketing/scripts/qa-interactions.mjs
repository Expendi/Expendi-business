// Run against an existing dev/production server: node scripts/qa-interactions.mjs
// Optional: QA_BASE_URL=http://localhost:3003 QA_WIDTHS=1440,768,390
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseURL = process.env.QA_BASE_URL ?? "http://localhost:3003";
const widths = (process.env.QA_WIDTHS ?? "1440,768,390").split(",").map(Number);
const browser = await chromium.launch({ headless: true });
const titles = [
  "Agents, inside Qonto",
  "MCP, in your AI tools",
  "Visibility & accountability",
];

/**
 * @template T
 * @param {() => Promise<T>} read
 * @param {(value: T) => boolean} check
 * @param {string} label
 * @param {number} [timeout]
 */
async function eventually(read, check, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

/** @param {import('playwright').Page} page @param {import('playwright').Locator} locator */
async function center(page, locator) {
  await locator.evaluate((element) =>
    element.scrollIntoView({ block: "center", behavior: "instant" }),
  );
  await page.waitForTimeout(100);
}

/**
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} target
 * @param {number} dx
 * @param {{cancel?: boolean, dy?: number}} [options]
 */
async function drag(page, target, dx, { cancel = false, dy = 0 } = {}) {
  await center(page, target);
  const box = await target.boundingBox();
  assert.ok(box);
  const x =
    dx < 0
      ? Math.min(
          (page.viewportSize()?.width ?? 1440) - 70,
          box.x + box.width - 70,
        )
      : Math.max(70, box.x + 70);
  const y = Math.max(170, Math.min(600, box.y + 140));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  if (cancel) {
    await target.dispatchEvent("pointercancel", {
      pointerId: 1,
      isPrimary: true,
    });
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
}

/** @param {import('playwright').Page} page @param {import('playwright').Locator} target @param {number} dx */
async function touchSwipe(page, target, dx) {
  await center(page, target);
  const box = await target.boundingBox();
  assert.ok(box);
  const width = page.viewportSize()?.width ?? 390;
  // CDP touch moves may span >300ms; cross the long-swipe halfway threshold.
  const distance = Math.sign(dx) * Math.max(Math.abs(dx), width * 0.65);
  const x = dx < 0 ? width - 70 : 70;
  const y = Math.max(170, Math.min(600, box.y + 140));
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (distance * step) / 8, y }],
      });
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
  await page.waitForTimeout(600);
}

/** @param {import('playwright').Page} page @param {boolean} desktop @param {boolean} reduced */
async function checkAi(page, desktop, reduced) {
  const section = page.locator("#section-4");
  const buttons = section.locator("button:visible");
  assert.equal(await buttons.count(), 3);
  for (const index of [0, 1, 2, 0]) {
    const button = buttons.nth(index);
    await center(page, button);
    await button.click();
    const attribute = desktop ? "aria-current" : "aria-expanded";
    // Clicking the initial open mobile item closes it; click again to open.
    if (!desktop && (await button.getAttribute(attribute)) !== "true") {
      await page.waitForTimeout(350);
      await button.click();
    }
    await eventually(
      () => button.getAttribute(attribute),
      (v) => v === "true",
      `AI ${titles[index]}`,
    );
    if (desktop) {
      await eventually(
        () =>
          button.evaluate((e) =>
            Number(getComputedStyle(e.closest(".items-stretch") ?? e).opacity),
          ),
        (v) => v > 0.99,
        "AI step fade",
      );
    } else {
      const panelId = await button.getAttribute("aria-controls");
      await eventually(
        () =>
          page
            .locator(`[id="${panelId}"]`)
            .evaluate((e) => e.getBoundingClientRect().height),
        (v) => v > 340,
        "accordion opens",
      );
      assert.equal(
        await buttons.evaluateAll(
          (es) =>
            es.filter((e) => e.getAttribute("aria-expanded") === "true").length,
        ),
        1,
      );
      await button.click();
      await eventually(
        () =>
          page
            .locator(`[id="${panelId}"]`)
            .evaluate((e) => e.getBoundingClientRect().height),
        (v) => v < 1,
        "accordion closes",
      );
    }
  }
  if (desktop) {
    await center(page, section);
    await buttons.nth(2).click();
    if (!reduced) {
      await eventually(
        () => buttons.nth(0).getAttribute("aria-current"),
        (v) => v === "true",
        "AI wraps after third step",
      ).catch(async () => {
        // The third step's measured duration is 7.5s.
        await page.waitForTimeout(2000);
        assert.equal(await buttons.nth(0).getAttribute("aria-current"), "true");
      });
    } else {
      const bar = section.locator(".origin-top").nth(2);
      assert.equal(
        await bar.evaluate(
          (e) => new DOMMatrixReadOnly(getComputedStyle(e).transform).d,
        ),
        1,
      );
      await page.waitForTimeout(800);
      assert.equal(await buttons.nth(2).getAttribute("aria-current"), "true");
    }
  }
}

/** @param {import('playwright').Page} page @param {boolean} desktop @param {boolean} reduced */
async function checkInvoicing(page, desktop, reduced) {
  const section = page.locator("#section-5");
  if (desktop) {
    const links = section.locator("a[aria-label]:visible");
    assert.equal(await links.count(), 3);
    for (const link of await links.all()) {
      await center(page, link);
      const animation = link
        .locator("..")
        .locator('div[aria-hidden="true"] > svg')
        .first();
      const before = (await animation.count())
        ? await animation.innerHTML()
        : null;
      await link.hover();
      await eventually(
        () =>
          link.evaluate(
            (e) =>
              new DOMMatrixReadOnly(
                getComputedStyle(e.parentElement ?? e).transform,
              ).f,
          ),
        (v) => Math.abs(v + 10) < 0.1,
        "invoicing hover lift",
      );
      await page.waitForTimeout(400);
      if (before !== null) {
        const after = await animation.innerHTML();
        if (reduced)
          assert.equal(
            after,
            before,
            "reduced-motion card Lottie stays static",
          );
        else assert.notEqual(after, before, "hover plays card Lottie");
      }
      await page.mouse.move(0, 100);
      await eventually(
        () =>
          link.evaluate(
            (e) =>
              new DOMMatrixReadOnly(
                getComputedStyle(e.parentElement ?? e).transform,
              ).f,
          ),
        (v) => Math.abs(v) < 0.1,
        "invoicing hover reset",
      );
    }
    return;
  }
  const prev = section.getByRole("button", { name: "Previous slide" });
  const next = section.getByRole("button", { name: "Next slide" });
  const slides = section.locator('[aria-roledescription="slide"]');
  const track = slides.first().locator("..");
  const position = () =>
    slides.evaluateAll((es) =>
      es.map((e) => Math.round(e.getBoundingClientRect().x)),
    );
  /** @param {number} index */
  const aligned = async (index) =>
    eventually(
      position,
      (v) => Math.abs((v[index] ?? NaN) - 16) <= 1,
      `invoice slide ${index}`,
    );
  assert.equal(await prev.isDisabled(), true);
  for (let i = 1; i <= 2; i++) {
    await next.click();
    await aligned(i);
  }
  assert.equal(await next.isDisabled(), true);
  for (let i = 1; i >= 0; i--) {
    await prev.click();
    await aligned(i);
  }
  await drag(page, slides.first(), -180);
  await aligned(1);
  assert.equal(
    new URL(page.url()).origin,
    new URL(baseURL).origin,
    "drag must not follow card link",
  );
  await drag(page, slides.nth(1), 180);
  await aligned(0);
  await drag(page, slides.first(), 100);
  await aligned(0);
  await drag(page, slides.first(), -120, { dy: 180 });
  await aligned(0);
  await drag(page, track, -180, { cancel: true });
  await aligned(0);
  await touchSwipe(page, slides.first(), -180);
  await aligned(1);
  await touchSwipe(page, slides.nth(1), 180);
  await aligned(0);
}

/** @param {import('playwright').Page} page */
async function checkAutoplay(page) {
  const section = page.locator("#section-9");
  const slides = section.locator('[aria-roledescription="slide"]:visible');
  const current = () =>
    slides.evaluateAll((es) =>
      es.findIndex((e) => e.getAttribute("aria-hidden") === "false"),
    );
  assert.equal(
    await current(),
    0,
    "testimonial initial slide is deterministic",
  );
  await eventually(
    current,
    (v) => v === 1,
    "off-screen testimonial autoplay",
    8000,
  );
  await center(page, slides.nth(1));
  await slides.nth(1).hover();
  await page.waitForTimeout(6800);
  assert.equal(await current(), 1, "hover pauses testimonial autoplay");
  await page.mouse.move(0, 0);
  await eventually(
    current,
    (v) => v === 2,
    "leaving hover resumes autoplay",
    8000,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(6800);
  assert.equal(
    await current(),
    2,
    "changing reduced motion stops testimonial autoplay",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await section.getByRole("button", { name: "Previous slide" }).click();
  assert.equal(await current(), 1);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(6800);
  assert.equal(
    await current(),
    1,
    "interaction permanently stops testimonial autoplay",
  );
}

/** @param {import('playwright').Page} page @param {boolean} desktop */
async function checkTestimonials(page, desktop) {
  const section = page.locator("#section-9");
  const prev = section.getByRole("button", { name: "Previous slide" });
  const next = section.getByRole("button", { name: "Next slide" });
  const slides = section.locator('[aria-roledescription="slide"]:visible');
  const current = () =>
    slides.evaluateAll((es) =>
      es.findIndex((e) => e.getAttribute("aria-hidden") === "false"),
    );
  for (let i = 0; i < 3; i++) {
    if (!(await prev.isDisabled())) await prev.click();
  }
  assert.equal(await current(), 0);
  for (let i = 1; i <= 3; i++) {
    await next.click();
    await eventually(current, (v) => v === i, `testimonial ${i}`);
    await page.waitForTimeout(550);
  }
  assert.equal(await next.isDisabled(), true);
  for (let i = 2; i >= 0; i--) {
    await prev.click();
    await page.waitForTimeout(550);
    assert.equal(await current(), i);
  }
  const surface = desktop ? slides.first() : slides.first().locator("..");
  await drag(page, surface, -200);
  assert.equal(await current(), 1, "testimonial swipe next");
  await drag(page, desktop ? slides.nth(1) : surface, 200);
  assert.equal(await current(), 0, "testimonial swipe previous");
  await drag(page, surface, -180, { cancel: true });
  assert.equal(
    await current(),
    0,
    "cancelled testimonial swipe retains active slide",
  );
  if (!desktop) {
    await touchSwipe(page, surface, -180);
    assert.equal(await current(), 1, "native touch testimonial swipe");
    await touchSwipe(page, surface, 180);
    assert.equal(await current(), 0, "native touch testimonial swipe back");
  }
}

/** @param {import('playwright').Page} page @param {boolean} desktop */
async function checkMotionChange(page, desktop) {
  const section = page.locator("#section-4");
  await center(page, section);
  if (!desktop)
    await section
      .locator('button[aria-expanded="false"]:visible')
      .first()
      .click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(200);
  const snapshot = () =>
    section.evaluate((e) => ({
      bars: [...e.querySelectorAll(".origin-top")].map(
        (bar) => getComputedStyle(bar).transform,
      ),
      svg: [...e.querySelectorAll("svg")].map((svg) => svg.innerHTML),
    }));
  const before = await snapshot();
  await page.waitForTimeout(800);
  assert.deepEqual(
    await snapshot(),
    before,
    "changing reduced motion must stop AI timer and Lottie frames",
  );
}

try {
  for (const width of widths) {
    for (const reduced of [false, true]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        hasTouch: width < 1024,
        reducedMotion: reduced ? "reduce" : "no-preference",
      });
      await context.addInitScript(() =>
        localStorage.setItem("qonto-clone-consent", "declined"),
      );
      // Never let a broken drag navigate to a real card destination.
      /** @type {string[]} */
      const blockedNavigations = [];
      await context.route("**/*", async (route) => {
        if (
          route.request().isNavigationRequest() &&
          new URL(route.request().url()).origin !== new URL(baseURL).origin
        ) {
          blockedNavigations.push(route.request().url());
          await route.abort();
        } else await route.continue();
      });
      const page = await context.newPage();
      /** @type {string[]} */
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(baseURL, { waitUntil: "networkidle" });
      if (width === 1440 && !reduced) await checkAutoplay(page);
      await checkAi(page, width >= 1024, reduced);
      await checkInvoicing(page, width >= 1024, reduced);
      await checkTestimonials(page, width >= 1024);
      if (!reduced) await checkMotionChange(page, width >= 1024);
      assert.deepEqual(blockedNavigations, [], "no accidental card navigation");
      assert.deepEqual(errors, [], "no browser runtime errors");
      console.log(`PASS ${width}px / reduced-motion=${reduced}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
