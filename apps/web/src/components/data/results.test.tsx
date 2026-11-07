import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResultsHead, shouldStack } from "./results";

describe("shouldStack", () => {
  it("keeps the chips beside the tabs while the toolbar fits", () => {
    // #then
    expect([
      shouldStack({ forced: false, scrollWidth: 480, clientWidth: 480 }),
      shouldStack({ forced: false, scrollWidth: 481, clientWidth: 480 }),
    ]).toEqual([false, false]);
  });

  it("stacks them once the toolbar overflows, or when forced", () => {
    // #then
    expect([
      shouldStack({ forced: false, scrollWidth: 482, clientWidth: 480 }),
      shouldStack({ forced: true, scrollWidth: 100, clientWidth: 480 }),
    ]).toEqual([true, true]);
  });
});

describe("ResultsHead", () => {
  const render = (stacked: boolean, clearable: boolean) =>
    renderToStaticMarkup(
      <ResultsHead
        stacked={stacked}
        tabs={<div role="tablist" aria-label="Bills" />}
        chips={<button type="button">Status</button>}
        onClearAll={clearable ? () => undefined : undefined}
      />,
    );

  it("starts on one row and leaves stacking to the measurement", () => {
    // #when
    const html = render(false, false);

    // #then
    expect({
      stacked: html.includes("data-stacked"),
      filters: html.includes('role="group" aria-label="Filters"'),
      clearAll: html.includes("Clear all"),
    }).toEqual({ stacked: false, filters: true, clearAll: false });
  });

  it("stacks when told to and offers Clear all while a filter is set", () => {
    // #when
    const html = render(true, true);

    // #then
    expect({
      stacked: html.includes('data-stacked="true"'),
      filterLabel: html.includes("Filter</span>"),
      clearAll: html.includes(">Clear all</button>"),
    }).toEqual({ stacked: true, filterLabel: true, clearAll: true });
  });
});
