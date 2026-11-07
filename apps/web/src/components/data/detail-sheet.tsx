"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX, KeyboardEvent, ReactNode } from "react";
import { cn } from "cn";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from "~/components/ui/sheet";
import { IconButton } from "./actions";

export interface SheetStepper {
  /** The open item's place in the visible, sorted list; -1 when it isn't in it. */
  readonly index: number;
  readonly total: number;
  onStep: (delta: -1 | 1) => void;
  /** e.g. "Previous bill" and "Next bill". */
  readonly previousLabel: string;
  readonly nextLabel: string;
}

const NOT_FOR_STEPPING =
  "input, select, textarea, summary, [role=listbox], [contenteditable=true]";

/**
 * The right side sheet for a row's details (560px). It steps through the
 * list with its arrows or ArrowUp/ArrowDown, closes on Escape or the scrim,
 * and returns focus to whatever opened it. Pair it with `useDeepLinkParam`
 * so the open item is in the URL.
 */
export function DetailSheet({
  open,
  onClose,
  eyebrow,
  title,
  headerExtra,
  headerActions,
  stepper,
  stepKey,
  footer,
  flush = false,
  dismissible = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Under the title, e.g. the amount and the status badge. */
  headerExtra?: ReactNode;
  /** Buttons before the stepper and close button. */
  headerActions?: ReactNode;
  stepper?: SheetStepper;
  /** The open item's id: a new one fades the body in after a step. */
  stepKey?: string;
  /** Sticky at the bottom; see `SheetActions`, `SheetPosition` and `ReadOnlyNote`. */
  footer?: ReactNode;
  /** No body padding, for an edge-to-edge list. */
  flush?: boolean;
  /** False while something is in flight that closing would lose, e.g. a payment. */
  dismissible?: boolean;
  children: ReactNode;
}): JSX.Element {
  const opener = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const [firstKey, setFirstKey] = useState(stepKey);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setFirstKey(stepKey);
  }
  const stepped = open && stepKey !== firstKey;

  function step(delta: -1 | 1) {
    if (!stepper) return;
    const next = stepper.index + delta;
    if (stepper.index < 0 || next < 0 || next >= stepper.total) return;
    stepper.onStep(delta);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!stepper || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) {
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest(NOT_FOR_STEPPING)
    ) {
      return;
    }
    event.preventDefault();
    step(event.key === "ArrowDown" ? 1 : -1);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        ref={content}
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          opener.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          content.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener.current?.isConnected) {
            opener.current.focus({ preventScroll: true });
          }
        }}
        onEscapeKeyDown={(event) => {
          if (!dismissible) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (!dismissible) event.preventDefault();
        }}
        overlayClassName="bg-scrim duration-200 supports-backdrop-filter:backdrop-blur-none"
        className="gap-0 bg-surface p-0 text-sm text-gray-900 shadow-[var(--shadow-sheet)] outline-none data-[side=right]:w-[min(560px,100%)] data-[side=right]:border-l-0 data-[side=right]:sm:max-w-none data-closed:duration-100 data-open:duration-[320ms] data-open:ease-out-expo data-[side=right]:data-open:slide-in-from-right-6"
      >
        <div className="flex items-start gap-2 border-b border-gray-200 pt-5 pr-4 pb-[18px] pl-6 max-[600px]:pl-4">
          <div className="min-w-0 flex-1">
            {eyebrow ? (
              <p className="text-xs leading-4 text-gray-500">{eyebrow}</p>
            ) : null}
            <SheetTitle className="mt-0.5 text-lg leading-[26px] font-(--w-title) [overflow-wrap:anywhere] text-gray-900">
              {title}
            </SheetTitle>
            {headerExtra}
          </div>
          <div className="flex gap-0.5">
            {headerActions}
            {stepper ? (
              <>
                <IconButton
                  label={stepper.previousLabel}
                  disabled={stepper.index <= 0}
                  onClick={() => step(-1)}
                >
                  <ChevronUpIcon aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={stepper.nextLabel}
                  disabled={
                    stepper.index < 0 || stepper.index >= stepper.total - 1
                  }
                  onClick={() => step(1)}
                >
                  <ChevronDownIcon aria-hidden="true" />
                </IconButton>
              </>
            ) : null}
            <SheetClose asChild>
              <IconButton label="Close" disabled={!dismissible}>
                <XIcon aria-hidden="true" />
              </IconButton>
            </SheetClose>
          </div>
        </div>
        <div
          key={stepKey}
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-y-auto",
            flush ? "gap-0 p-0" : "gap-4 px-6 py-5 max-[600px]:px-4",
            stepped && "motion-safe:animate-fade",
          )}
        >
          {children}
        </div>
        {footer ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 px-6 py-3.5 text-xs text-gray-600 max-[600px]:px-4">
            {footer}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** "3 of 12", pushed to the end of the footer. */
export function SheetPosition({
  index,
  total,
}: {
  index: number;
  total: number;
}): JSX.Element | null {
  if (index < 0) return null;
  return (
    <span className="ml-auto text-xs text-gray-500 tabular-nums">
      {index + 1} of {total}
    </span>
  );
}

/** The footer's button groups: `primary` on the left, `secondary` (ghost buttons) pushed right. */
export function SheetActions({
  kind,
  children,
}: {
  kind: "primary" | "secondary";
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-wrap",
        kind === "primary" ? "gap-2" : "ml-auto gap-0.5 max-[600px]:ml-0",
      )}
    >
      {children}
    </div>
  );
}

/** Why there are no actions, e.g. "View only. Only admins add and pay bills." */
export function ReadOnlyNote({
  icon: Icon = InfoIcon,
  wide = false,
  children,
}: {
  icon?: LucideIcon;
  /** Its own line under the buttons, in small print. */
  wide?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <p
      className={cn(
        "flex items-center gap-2 text-gray-500",
        wide ? "basis-full text-xs" : "text-sm",
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {children}
    </p>
  );
}

const LABEL_WIDTHS = {
  sm: "[--detail-label:8rem]",
  md: "[--detail-label:9rem]",
  lg: "[--detail-label:10rem]",
} as const;

/**
 * Label and value rows, 9rem labels (`labelWidth` sm: 8rem, e.g. a narrow
 * pane; lg: 10rem); one column on a phone.
 */
export function DetailList({
  labelWidth = "md",
  children,
}: {
  labelWidth?: keyof typeof LABEL_WIDTHS;
  children: ReactNode;
}): JSX.Element {
  return (
    <dl className={cn("flex flex-col", LABEL_WIDTHS[labelWidth])}>
      {children}
    </dl>
  );
}

export function DetailItem({
  label,
  children,
  sub,
}: {
  label: ReactNode;
  children: ReactNode;
  /** Small muted line under the value. */
  sub?: ReactNode;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[var(--detail-label,9rem)_minmax(0,1fr)] gap-3 border-t border-hairline py-[9px] first:border-t-0 first:pt-0 max-[600px]:grid-cols-[minmax(0,1fr)] max-[600px]:gap-0.5">
      <dt className="text-gray-500">{label}</dt>
      <dd className="[overflow-wrap:anywhere] tabular-nums">
        {children}
        {sub ? (
          <span className="block text-xs leading-4 text-gray-500">{sub}</span>
        ) : null}
      </dd>
    </div>
  );
}

export function SectionLabel({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <p className="text-xs leading-4 font-(--w-ui) text-gray-500">{children}</p>
  );
}

export type CalloutTone = "warn" | "error" | "neutral" | "success";

const CALLOUT_TONES: Record<CalloutTone, string> = {
  warn: "bg-warn-50 text-warn-700",
  error: "bg-error-50 text-error-700",
  neutral: "bg-gray-100 text-gray-700",
  success: "bg-success-50 text-success-700",
};

const CALLOUT_ICONS: Record<CalloutTone, LucideIcon> = {
  warn: TriangleAlertIcon,
  error: CircleAlertIcon,
  neutral: InfoIcon,
  success: CircleCheckIcon,
};

/** A tinted note inside a sheet or form: why something can't happen, or what went wrong. */
export function Callout({
  tone,
  icon,
  title,
  children,
  action,
}: {
  tone: CalloutTone;
  icon?: LucideIcon;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  const Icon = icon ?? CALLOUT_ICONS[tone];
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-control px-3.5 py-3 text-sm leading-5",
        CALLOUT_TONES[tone],
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        {title ? <p className="font-(--w-ui)">{title}</p> : null}
        {children}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}
