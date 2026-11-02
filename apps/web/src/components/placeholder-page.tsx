import type { JSX } from "react";

/** A dashboard section whose screens come in a later build task (Phase 3B). */
export function PlaceholderPage({
  title,
  task,
}: {
  title: string;
  task: `T${number}`;
}): JSX.Element {
  return (
    <section className="max-w-3xl">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-6 rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
        Coming in {task}.
      </p>
    </section>
  );
}
