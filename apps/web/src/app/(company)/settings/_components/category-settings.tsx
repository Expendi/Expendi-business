"use client";

import type { FormEvent, JSX } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import type { Category } from "@expendi-business/shared";
import {
  CATEGORY_NAME_MAX_LENGTH,
  createCategoryRequestSchema,
} from "@expendi-business/shared";

import {
  Callout,
  DetailSheet,
  SheetActions,
} from "~/components/data/detail-sheet";
import { KindTabs } from "~/components/data/kind-tabs";
import { RowCheckbox } from "~/components/data/table";
import { Button } from "~/components/ui/button";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { describeApiError } from "~/lib/api";
import {
  useActiveCategories,
  useArchivedCategories,
  useChangeCategory,
} from "./settings-api";
import {
  PanelEmpty,
  PanelError,
  PanelSkeleton,
  RowButton,
  sameName,
  SettingsList,
  SettingsPanel,
  SettingsRow,
  Tag,
  tidy,
  useSheetForm,
} from "./settings-panel";

export const NO_INVOICE_EXPECTED = "No invoice expected";

const CATEGORIES_SUB =
  "A category marked “no invoice expected” (e.g. air tickets, bank charges) records new spending in it as not needing an eTIMS invoice. An archived category can't be picked for new spending; what already has it keeps it.";

type CategoryTab = "active" | "archived";

const byName = (a: Category, b: Category) => a.name.localeCompare(b.name);

/**
 * The categories people pick when they record spending (spec §6.1, §6.6).
 * Admins add, rename, mark eTIMS-exempt, archive and restore them; each
 * change is audited. Archiving keeps a category on spending that has it.
 */
export function CategorySettings({
  organizationId,
  canAct,
  openId,
  onOpen,
}: {
  organizationId: string;
  canAct: boolean;
  /** The category whose form is open (`?category=`), admins only. */
  openId: string | null;
  onOpen: (categoryId: string | null) => void;
}): JSX.Element {
  const active = useActiveCategories(organizationId);
  const archived = useArchivedCategories(organizationId);
  const restore = useChangeCategory(organizationId);
  const [tab, setTab] = useState<CategoryTab>("active");
  const [adding, setAdding] = useState(false);

  const inUse = [...(active.data ?? [])].sort(byName);
  const old = [...(archived.data ?? [])].sort(byName);
  const editing = canAct
    ? inUse.find((category) => category.id === openId)
    : undefined;
  const restoringId =
    restore.isPending && restore.variables.kind === "restore"
      ? restore.variables.categoryId
      : null;

  const addButton = (variant: "outline" | "default") => (
    <Button
      variant={variant}
      size="md"
      aria-haspopup="dialog"
      onClick={() => setAdding(true)}
    >
      <PlusIcon aria-hidden="true" />
      Add category
    </Button>
  );

  const list = tab === "archived" ? old : inUse;

  return (
    <SettingsPanel
      id="categories"
      title="Categories"
      sub={CATEGORIES_SUB}
      actions={canAct && active.isSuccess ? addButton("outline") : null}
      busy={active.isPending}
    >
      {active.isPending ? (
        <PanelSkeleton lines={5} />
      ) : active.isError ? (
        <PanelError
          title="Categories didn't load"
          message={describeApiError(active.error)}
          onRetry={() => void active.refetch()}
        />
      ) : (
        <>
          <KindTabs
            label="Categories"
            tabs={[
              { value: "active", label: "In use", count: inUse.length },
              {
                value: "archived",
                label: "Archived",
                count: archived.isSuccess ? old.length : undefined,
              },
            ]}
            value={tab}
            onChange={(next) => {
              restore.reset();
              setTab(next);
            }}
            controls="categories-list"
          />
          {restore.isError ? (
            <div role="alert" className="mx-5 mt-3">
              <Callout tone="error">
                <p>{describeApiError(restore.error)}</p>
              </Callout>
            </div>
          ) : null}
          {tab === "archived" && archived.isError ? (
            <PanelError
              title="Archived categories didn't load"
              message={describeApiError(archived.error)}
              onRetry={() => void archived.refetch()}
            />
          ) : list.length === 0 ? (
            <div id="categories-list" role="tabpanel">
              <PanelEmpty
                action={
                  tab === "active" && canAct ? addButton("default") : null
                }
              >
                {tab === "archived"
                  ? "No archived categories."
                  : canAct
                    ? "No categories yet. Add one so people can record spending."
                    : "No categories yet."}
              </PanelEmpty>
            </div>
          ) : (
            <div id="categories-list" role="tabpanel">
              <SettingsList
                label={
                  tab === "archived"
                    ? "Archived categories"
                    : "Categories in use"
                }
                compact
              >
                {list.map((category) => {
                  const editable = canAct && tab === "active";
                  return (
                    <SettingsRow
                      key={category.id}
                      open={editable && category.id === openId}
                      onOpen={editable ? () => onOpen(category.id) : undefined}
                    >
                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="min-w-0 truncate font-(--w-name)">
                          {category.name}
                        </span>
                        {category.etimsNotRequired ? (
                          <Tag>{NO_INVOICE_EXPECTED}</Tag>
                        ) : null}
                      </span>
                      {editable ? (
                        <RowButton
                          label={`Edit ${category.name}`}
                          aria-haspopup="dialog"
                          onClick={() => onOpen(category.id)}
                        >
                          Edit
                        </RowButton>
                      ) : canAct ? (
                        <RowButton
                          icon={ArchiveRestoreIcon}
                          label={`Restore ${category.name}`}
                          disabled={restore.isPending}
                          onClick={() =>
                            restore.mutate({
                              kind: "restore",
                              categoryId: category.id,
                            })
                          }
                        >
                          {restoringId === category.id
                            ? "Restoring…"
                            : "Restore"}
                        </RowButton>
                      ) : null}
                    </SettingsRow>
                  );
                })}
              </SettingsList>
            </div>
          )}
        </>
      )}
      {canAct ? (
        <CategorySheet
          organizationId={organizationId}
          open={adding || editing !== undefined}
          category={editing ?? null}
          existing={[...inUse, ...old]}
          onClose={() => {
            setAdding(false);
            onOpen(null);
          }}
          onAdded={() => setTab("active")}
        />
      ) : null}
    </SettingsPanel>
  );
}

interface CategoryForm {
  readonly step: "form" | "archive";
  readonly name: string;
  readonly exempt: boolean;
  readonly nameError: string | null;
}

const initialForm = (category: Category | null): CategoryForm => ({
  step: "form",
  name: category?.name ?? "",
  exempt: category?.etimsNotRequired ?? false,
  nameError: null,
});

/** Adding, editing or archiving a category, each a short form in the side sheet. */
function CategorySheet({
  organizationId,
  open,
  category,
  existing,
  onClose,
  onAdded,
}: {
  organizationId: string;
  open: boolean;
  /** Null to add one. */
  category: Category | null;
  existing: readonly Category[];
  onClose: () => void;
  onAdded: () => void;
}): JSX.Element {
  const change = useChangeCategory(organizationId);
  const { subject, form, setForm } = useSheetForm(open, category, initialForm);
  const nameId = useId();
  const exemptId = useId();
  const unchanged =
    subject !== null &&
    tidy(form.name) === subject.name &&
    form.exempt === subject.etimsNotRequired;

  function close() {
    change.reset();
    onClose();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = createCategoryRequestSchema.shape.name.safeParse(form.name);
    const name = parsed.success ? tidy(parsed.data) : "";
    const problem = !parsed.success
      ? (parsed.error.issues[0]?.message ?? "Check the name.")
      : existing.some(
            (other) => other.id !== subject?.id && sameName(other.name, name),
          )
        ? `There's already a category called ${name}.`
        : null;
    if (problem) {
      setForm((now) => ({ ...now, nameError: problem }));
      document.getElementById(nameId)?.focus();
      return;
    }
    if (subject === null) {
      change.mutate(
        { kind: "create", fields: { name, etimsNotRequired: form.exempt } },
        {
          onSuccess: () => {
            onAdded();
            close();
          },
        },
      );
      return;
    }
    change.mutate(
      {
        kind: "update",
        categoryId: subject.id,
        changes: {
          ...(name === subject.name ? {} : { name }),
          ...(form.exempt === subject.etimsNotRequired
            ? {}
            : { etimsNotRequired: form.exempt }),
        },
      },
      { onSuccess: close },
    );
  }

  const failed = change.isError ? (
    <div role="alert">
      <Callout tone="error">
        <p>{describeApiError(change.error)}</p>
      </Callout>
    </div>
  ) : null;

  if (subject !== null && form.step === "archive") {
    return (
      <DetailSheet
        open={open}
        onClose={close}
        dismissible={!change.isPending}
        eyebrow={subject.name}
        title="Archive this category?"
        stepKey={`${subject.id}-archive`}
        footer={
          <>
            <Button
              disabled={change.isPending}
              onClick={() =>
                change.mutate(
                  { kind: "archive", categoryId: subject.id },
                  { onSuccess: close },
                )
              }
            >
              {change.isPending ? "Archiving…" : "Archive"}
            </Button>
            <Button
              variant="outline"
              disabled={change.isPending}
              onClick={() => {
                change.reset();
                setForm((now) => ({ ...now, step: "form" }));
              }}
            >
              Keep it
            </Button>
          </>
        }
      >
        {failed}
        <Callout tone="neutral" icon={ArchiveIcon}>
          <p>
            {subject.name} can&apos;t be picked for new spending. What already
            has it keeps it, and you can restore it later.
          </p>
        </Callout>
      </DetailSheet>
    );
  }

  return (
    <DetailSheet
      open={open}
      onClose={close}
      dismissible={!change.isPending}
      eyebrow={subject?.name ?? "Categories"}
      title={subject ? "Edit category" : "Add a category"}
      stepKey={subject?.id ?? "new"}
      footer={
        <>
          <Button
            type="submit"
            form="category-form"
            disabled={change.isPending || unchanged}
          >
            {change.isPending
              ? subject
                ? "Saving…"
                : "Adding…"
              : subject
                ? "Save"
                : "Add category"}
          </Button>
          <Button variant="outline" disabled={change.isPending} onClick={close}>
            Cancel
          </Button>
          {subject ? (
            <SheetActions kind="secondary">
              <Button
                variant="ghost"
                size="md"
                disabled={change.isPending}
                onClick={() => {
                  change.reset();
                  setForm((now) => ({ ...now, step: "archive" }));
                }}
              >
                <ArchiveIcon aria-hidden="true" />
                Archive
              </Button>
            </SheetActions>
          ) : null}
        </>
      }
    >
      <form
        id="category-form"
        aria-label={subject ? `Edit ${subject.name}` : "Add a category"}
        noValidate
        onSubmit={onSubmit}
        className="flex flex-col gap-[18px]"
      >
        {failed}
        <Field>
          <FieldLabel htmlFor={nameId}>
            {subject ? "Name" : "New category"}
          </FieldLabel>
          <Input
            id={nameId}
            value={form.name}
            maxLength={CATEGORY_NAME_MAX_LENGTH}
            autoComplete="off"
            placeholder="e.g. Courier"
            aria-invalid={form.nameError ? true : undefined}
            onChange={(event) => {
              const name = event.target.value;
              setForm((now) => ({ ...now, name, nameError: null }));
            }}
          />
          <FieldError>{form.nameError}</FieldError>
        </Field>
        <label
          htmlFor={exemptId}
          className="flex cursor-pointer items-start gap-2.5"
        >
          <RowCheckbox
            id={exemptId}
            className="mt-px"
            checked={form.exempt}
            onChange={(event) => {
              const exempt = event.target.checked;
              setForm((now) => ({ ...now, exempt }));
            }}
          />
          <span>
            <span className="block text-sm font-(--w-ui) text-gray-900">
              No eTIMS invoice expected
            </span>
            <span className="block text-xs leading-4 text-gray-500">
              {subject
                ? "e.g. air tickets, bank charges. Changing this applies to new spending; what's already recorded keeps its eTIMS status."
                : "e.g. air tickets, bank charges. New spending in it is recorded as not needing an eTIMS invoice."}
            </span>
          </span>
        </label>
      </form>
    </DetailSheet>
  );
}
