export type FieldErrors = Readonly<Partial<Record<string, string>>>;

/** Each field's first message from a schema's issues, by the field's name. */
export function errorsByField(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  rename: Readonly<Partial<Record<string, string>>> = {},
): FieldErrors {
  const errors: Partial<Record<string, string>> = {};
  for (const issue of issues) {
    const key = issue.path[0];
    const name = typeof key === "string" ? key : "form";
    errors[rename[name] ?? name] ??= issue.message;
  }
  return errors;
}

/** Moves focus to the first field with an error, in the order given. */
export function focusFirstError(
  errors: FieldErrors,
  ids: Readonly<Partial<Record<string, string>>>,
): void {
  for (const [field, id] of Object.entries(ids)) {
    if (errors[field] && id) {
      document.getElementById(id)?.focus();
      return;
    }
  }
}
