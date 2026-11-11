import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StatusTone } from "./status-badge";
import { StatusBadge } from "./status-badge";

const TONES: readonly StatusTone[] = [
  "waiting",
  "moving",
  "paid",
  "failed",
  "rejected",
  "quiet",
  "overdue",
];

describe("StatusBadge", () => {
  it("is a tint and its label, with no dot", () => {
    // #when
    const html = renderToStaticMarkup(
      <StatusBadge tone="overdue">Overdue</StatusBadge>,
    );

    // #then
    expect({
      onlyText: /^<span[^>]*>Overdue<\/span>$/.test(html),
      tone: html.includes('data-tone="overdue"'),
      tint: html.includes("bg-error-50") && html.includes("text-error-700"),
    }).toEqual({ onlyText: true, tone: true, tint: true });
  });

  it("tints each tone as the mocks do, with only quiet outlined", () => {
    // #when
    const classOf = (tone: StatusTone) =>
      /class="([^"]+)"/.exec(
        renderToStaticMarkup(<StatusBadge tone={tone}>x</StatusBadge>),
      )?.[1] ?? "";
    const tints = Object.fromEntries(
      TONES.map((tone) => [
        tone,
        /\bbg-[a-z]+-\d+|\bbg-surface/.exec(classOf(tone))?.[0],
      ]),
    );

    // #then
    expect({
      tints,
      outlined: TONES.filter((tone) =>
        classOf(tone).includes("border-gray-200"),
      ),
      weight: TONES.every((tone) => classOf(tone).includes("font-(--w-ui)")),
    }).toEqual({
      tints: {
        waiting: "bg-warn-50",
        moving: "bg-blue-50",
        paid: "bg-success-50",
        failed: "bg-error-50",
        rejected: "bg-gray-100",
        quiet: "bg-surface",
        overdue: "bg-error-50",
      },
      outlined: ["quiet"],
      weight: true,
    });
  });
});
