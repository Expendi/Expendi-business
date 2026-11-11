"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { PencilIcon } from "lucide-react";
import { useState } from "react";

import { ErrorState, Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

/**
 * One settings section: a panel with a title, a line of help, actions on
 * the right, then label/value rows or a list. Every change opens in the
 * side sheet.
 */
export function SettingsPanel({
  id,
  title,
  sub,
  actions,
  busy = false,
  children,
}: {
  id: string;
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  busy?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <Card
      id={id}
      aria-labelledby={`${id}-title`}
      aria-busy={busy || undefined}
      className="@container/panel scroll-mt-6 gap-0 overflow-clip py-0 shadow-xs max-[900px]:scroll-mt-32 @max-[760px]/settings:scroll-mt-18"
    >
      <CardHeader className="gap-y-1 px-5 pt-5 pb-4 @max-[520px]/panel:px-4">
        <CardTitle>
          <h2
            id={`${id}-title`}
            tabIndex={-1}
            className="w-fit rounded-[4px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {title}
          </h2>
        </CardTitle>
        {sub ? (
          <CardDescription className="max-w-[70ch]">{sub}</CardDescription>
        ) : null}
        {actions ? (
          <CardAction className="flex flex-wrap gap-2">{actions}</CardAction>
        ) : null}
      </CardHeader>
      {children}
    </Card>
  );
}

/** Label and value rows, 180px labels; one column in a narrow panel. */
export function KeyValues({ children }: { children: ReactNode }): JSX.Element {
  return (
    <dl className="m-0 divide-y divide-border border-t border-border">
      {children}
    </dl>
  );
}

export function KeyValue({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-x-4 gap-y-0.5 px-5 py-3.5 @max-[520px]/panel:grid-cols-[minmax(0,1fr)] @max-[520px]/panel:px-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 [overflow-wrap:anywhere] tabular-nums">
        {children}
      </dd>
    </div>
  );
}

/** Small print on a gray strip at the bottom of a panel. */
export function PanelFoot({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}): JSX.Element {
  return (
    <p className="m-0 flex items-start gap-2 border-t border-border bg-muted/40 px-5 py-3 text-muted-foreground @max-[520px]/panel:px-4">
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export function RowButton({
  icon: Icon = PencilIcon,
  label,
  children,
  ...props
}: {
  icon?: LucideIcon;
  /** e.g. "Edit Fuel & transport". */
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  "aria-haspopup"?: "dialog";
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="md"
      aria-label={label}
      className="h-8 flex-none px-2.5"
      {...props}
    >
      <Icon aria-hidden="true" />
      {children}
    </Button>
  );
}

/** A small outlined label after a row's name, e.g. "No invoice expected". */
export function Tag({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex h-[22px] flex-none items-center rounded-full border border-border px-2 text-xs whitespace-nowrap text-muted-foreground">
      {children}
    </span>
  );
}

/** Nothing in a list yet: a dashed box with one next step. */
export function PanelEmpty({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="mx-5 mt-4 mb-5 flex flex-col items-center gap-3 rounded-control border border-dashed border-input px-4 py-6 text-center text-muted-foreground">
      <p className="m-0">{children}</p>
      {action}
    </div>
  );
}

const SKELETON_WIDTHS = [
  ["24%", "46%"],
  ["18%", "38%"],
  ["28%", "54%"],
  ["20%", "42%"],
] as const;

export function PanelSkeleton({ lines }: { lines: number }): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="divide-y divide-border border-t border-border"
    >
      {Array.from({ length: lines }, (_, line) => {
        const [label, value] = SKELETON_WIDTHS[
          line % SKELETON_WIDTHS.length
        ] ?? ["24%", "46%"];
        return (
          <div key={line} className="flex flex-col gap-2 px-5 py-4">
            <Skel width={label} height={12} />
            <Skel width={value} height={14} />
          </div>
        );
      })}
    </div>
  );
}

export function PanelError({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="border-t border-border [&>div]:py-8">
      <ErrorState title={title} onRetry={onRetry}>
        {message}
      </ErrorState>
    </div>
  );
}

/**
 * A sheet form's subject and fields, reset each time the sheet opens, and
 * kept while it closes so the title doesn't change under the animation.
 */
export function useSheetForm<S extends { readonly id: string }, F>(
  open: boolean,
  subject: S | null,
  initial: (subject: S | null) => F,
): {
  readonly subject: S | null;
  readonly form: F;
  readonly setForm: (update: (form: F) => F) => void;
} {
  const openKey = open ? (subject?.id ?? "new") : null;
  const [state, setState] = useState(() => ({
    key: openKey,
    subject,
    form: initial(subject),
  }));
  if (openKey !== state.key) {
    setState(
      openKey === null
        ? { ...state, key: null }
        : { key: openKey, subject, form: initial(subject) },
    );
  }
  return {
    subject: state.subject,
    form: state.form,
    setForm: (update) =>
      setState((now) => ({ ...now, form: update(now.form) })),
  };
}

/** Spaces as people mean them: trimmed, single. */
export const tidy = (text: string): string => text.trim().replace(/\s+/g, " ");

export const sameName = (a: string, b: string): boolean =>
  tidy(a).toLowerCase() === tidy(b).toLowerCase();
