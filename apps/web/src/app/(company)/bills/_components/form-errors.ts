/**
 * A form's validation issues (from the shared request schemas) as one
 * message per field: the first issue for each, under the field `fields`
 * maps the request's key to; anything else goes under `form`.
 */
export function fieldErrorsOf<F extends string>(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  fields: Readonly<Partial<Record<string, F>>>,
): Partial<Record<F | "form", string>> {
  const errors: Partial<Record<F | "form", string>> = {};
  for (const issue of issues) {
    const key = issue.path[0];
    const field = (typeof key === "string" ? fields[key] : undefined) ?? "form";
    errors[field] ??= issue.message;
  }
  return errors;
}

/** Moves focus to the first field with an error, in the order the form shows them. */
export function focusFirstError(
  order: readonly { readonly field: string; readonly id: string }[],
  errors: Readonly<Partial<Record<string, string>>>,
): void {
  const first = order.find(({ field }) => errors[field] !== undefined);
  if (first) document.getElementById(first.id)?.focus();
}
