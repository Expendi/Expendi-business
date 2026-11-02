import type { JSX } from "react";

export function MissingConfig({
  invalidKeys,
}: {
  invalidKeys: string[];
}): JSX.Element {
  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <h1 className="text-xl font-semibold">The dashboard isn&apos;t set up</h1>
      <p className="mt-3 text-sm text-stone-600">
        Set these variables (see <code>apps/web/.env.example</code>), then
        rebuild:
      </p>
      <ul className="mt-3 list-disc pl-5 font-mono text-sm">
        {invalidKeys.map((key) => (
          <li key={key}>{key}</li>
        ))}
      </ul>
    </main>
  );
}
