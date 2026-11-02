"use client";

import type { FormEvent, JSX } from "react";
import { useState } from "react";

import type { Category } from "@expendi-business/shared";
import {
  CATEGORY_NAME_MAX_LENGTH,
  createCategoryRequestSchema,
} from "@expendi-business/shared";

import {
  alertClass,
  cellClass,
  headCellClass,
  inputClass,
  primaryButton,
  secondaryButton,
  tableClass,
  textButton,
} from "~/components/styles";
import { describeApiError } from "~/lib/api";
import {
  useActiveCategories,
  useArchivedCategories,
  useChangeCategory,
} from "./settings-api";

const ETIMS_LABELS = {
  expected: "Invoice expected",
  exempt: "No invoice expected",
} as const;

const etimsLabel = (category: Category) =>
  category.etimsNotRequired ? ETIMS_LABELS.exempt : ETIMS_LABELS.expected;

/**
 * The categories people pick when they record spending (spec §6.1, §6.6).
 * Admins add, rename, archive and mark them eTIMS-exempt; each change is
 * audited. Archiving keeps a category on spending that has it.
 */
export function CategorySettings({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const active = useActiveCategories(organizationId);
  const archived = useArchivedCategories(organizationId);

  return (
    <section aria-labelledby="categories-heading" className="space-y-3">
      <div>
        <h2 id="categories-heading" className="text-base font-semibold">
          Categories
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-stone-600">
          A category marked &ldquo;no invoice expected&rdquo; (e.g. air tickets,
          bank charges) records new spending in it as not needing an eTIMS
          invoice. An archived category can&apos;t be picked for new spending;
          what already has it keeps it.
        </p>
      </div>

      {canAct ? <AddCategoryForm organizationId={organizationId} /> : null}

      {active.isPending ? (
        <p className="text-sm text-stone-500">Loading categories…</p>
      ) : active.isError ? (
        <div className="text-sm text-error-700" role="alert">
          <p>{describeApiError(active.error)}</p>
          <button
            type="button"
            onClick={() => void active.refetch()}
            className={`mt-2 ${secondaryButton}`}
          >
            Try again
          </button>
        </div>
      ) : (
        <CategoryTable
          label="Categories in use"
          categories={active.data}
          empty="No categories yet. Add one so people can record spending."
          renderActions={
            canAct
              ? (category) => (
                  <ActiveCategoryActions
                    organizationId={organizationId}
                    category={category}
                  />
                )
              : null
          }
        />
      )}

      {archived.data && archived.data.length > 0 ? (
        <div className="space-y-2 pt-2">
          <h3 className="text-sm font-semibold">Archived</h3>
          <CategoryTable
            label="Archived categories"
            categories={archived.data}
            empty=""
            renderActions={
              canAct
                ? (category) => (
                    <RestoreCategory
                      organizationId={organizationId}
                      category={category}
                    />
                  )
                : null
            }
          />
        </div>
      ) : null}
      {archived.isError ? (
        <p className="text-sm text-error-700" role="alert">
          Archived categories couldn&apos;t load.{" "}
          {describeApiError(archived.error)}
        </p>
      ) : null}
    </section>
  );
}

function CategoryTable({
  label,
  categories,
  empty,
  renderActions,
}: {
  label: string;
  categories: readonly Category[];
  empty: string;
  renderActions: ((category: Category) => JSX.Element) | null;
}): JSX.Element {
  if (categories.length === 0) {
    return (
      <p className="max-w-3xl rounded-lg border border-dashed border-stone-300 bg-white p-4 text-sm text-stone-600">
        {empty}
      </p>
    );
  }
  return (
    <div className="max-w-3xl overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className={tableClass} aria-label={label}>
        <thead className="bg-stone-100 text-stone-600">
          <tr>
            <th scope="col" className={headCellClass}>
              Name
            </th>
            <th scope="col" className={headCellClass}>
              eTIMS
            </th>
            {renderActions ? (
              <th scope="col" className={headCellClass}>
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {categories.map((category) => (
            <tr
              key={category.id}
              className="border-t border-stone-200 align-top"
            >
              <td className={`${cellClass} font-medium`}>{category.name}</td>
              <td className={cellClass}>{etimsLabel(category)}</td>
              {renderActions ? (
                <td className={`${cellClass} text-right`}>
                  {renderActions(category)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddCategoryForm({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const add = useChangeCategory(organizationId);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const parsed = createCategoryRequestSchema.safeParse({
      name: values.get("name"),
      etimsNotRequired: values.get("etimsNotRequired") === "on",
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the name.");
      return;
    }
    setError(null);
    add.mutate(
      { kind: "create", fields: parsed.data },
      { onSuccess: () => form.reset() },
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Add a category"
      className="flex max-w-3xl flex-wrap items-end gap-4 rounded-lg border border-stone-200 bg-white p-4"
    >
      <label className="min-w-56 flex-1 text-sm">
        New category
        <input
          name="name"
          maxLength={CATEGORY_NAME_MAX_LENGTH}
          autoComplete="off"
          placeholder="e.g. Courier"
          className={inputClass}
        />
      </label>
      <label className="flex items-center gap-2 py-2 text-sm">
        <input
          type="checkbox"
          name="etimsNotRequired"
          className="size-4 accent-brand-700"
        />
        No eTIMS invoice expected
      </label>
      <button type="submit" disabled={add.isPending} className={primaryButton}>
        {add.isPending ? "Adding…" : "Add category"}
      </button>
      {error || add.isError ? (
        <p className={`${alertClass} mt-0 w-full`} role="alert">
          {error ?? describeApiError(add.error)}
        </p>
      ) : null}
    </form>
  );
}

function ActiveCategoryActions({
  organizationId,
  category,
}: {
  organizationId: string;
  category: Category;
}): JSX.Element {
  const change = useChangeCategory(organizationId);
  const [renaming, setRenaming] = useState(false);

  if (renaming) {
    return (
      <RenameCategory
        category={category}
        saving={change.isPending}
        error={change.isError ? describeApiError(change.error) : null}
        onSave={(name) =>
          change.mutate(
            {
              kind: "update",
              categoryId: category.id,
              changes: { name },
            },
            { onSuccess: () => setRenaming(false) },
          )
        }
        onCancel={() => {
          change.reset();
          setRenaming(false);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-x-4 gap-y-1">
        <button
          type="button"
          disabled={change.isPending}
          onClick={() => setRenaming(true)}
          className={textButton}
        >
          Rename
        </button>
        <button
          type="button"
          disabled={change.isPending}
          onClick={() =>
            change.mutate({
              kind: "update",
              categoryId: category.id,
              changes: { etimsNotRequired: !category.etimsNotRequired },
            })
          }
          className={textButton}
        >
          {category.etimsNotRequired
            ? "Expect an invoice"
            : "Mark no invoice expected"}
        </button>
        <button
          type="button"
          disabled={change.isPending}
          onClick={() =>
            change.mutate({ kind: "archive", categoryId: category.id })
          }
          className={textButton}
        >
          Archive
        </button>
      </div>
      {change.isPending ? (
        <span className="text-xs text-stone-500">Saving…</span>
      ) : null}
      {change.isError ? (
        <p className="text-sm text-error-700" role="alert">
          {describeApiError(change.error)}
        </p>
      ) : null}
    </div>
  );
}

function RenameCategory({
  category,
  saving,
  error,
  onSave,
  onCancel,
}: {
  category: Category;
  saving: boolean;
  error: string | null;
  onSave: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [invalid, setInvalid] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = createCategoryRequestSchema.shape.name.safeParse(
      new FormData(event.currentTarget).get("name"),
    );
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? "Check the name.");
      return;
    }
    setInvalid(null);
    onSave(parsed.data);
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label={`Rename ${category.name}`}
      className="flex flex-wrap items-center justify-end gap-2"
    >
      <input
        name="name"
        defaultValue={category.name}
        maxLength={CATEGORY_NAME_MAX_LENGTH}
        aria-label="New name"
        autoComplete="off"
        className={`${inputClass} mt-0 w-48`}
      />
      <button type="submit" disabled={saving} className={secondaryButton}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        disabled={saving}
        onClick={onCancel}
        className={textButton}
      >
        Cancel
      </button>
      {invalid || error ? (
        <p className="w-full text-right text-sm text-error-700" role="alert">
          {invalid ?? error}
        </p>
      ) : null}
    </form>
  );
}

function RestoreCategory({
  organizationId,
  category,
}: {
  organizationId: string;
  category: Category;
}): JSX.Element {
  const change = useChangeCategory(organizationId);
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={change.isPending}
        onClick={() =>
          change.mutate({ kind: "restore", categoryId: category.id })
        }
        className={textButton}
      >
        {change.isPending ? "Restoring…" : "Restore"}
      </button>
      {change.isError ? (
        <p className="text-sm text-error-700" role="alert">
          {describeApiError(change.error)}
        </p>
      ) : null}
    </div>
  );
}
