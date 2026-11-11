"use client";

import type { FormEvent, JSX } from "react";
import { CalendarIcon, CircleAlertIcon } from "lucide-react";
import { useId, useState } from "react";

import { reportMonthSchema } from "@expendi-business/shared";

import { Button } from "~/components/ui/button";
import { monthLabel, monthsEnding } from "../report-month";
import { MenuChip, useCloseMenu } from "./menu-chip";

/**
 * The month a page reports on: the last 12 Nairobi months, this one "so
 * far", and any earlier month typed in under "Another month".
 */
export function MonthChip({
  month,
  thisMonth,
  onChange,
  disabled = false,
}: {
  month: string;
  /** This Nairobi month, the latest that can be chosen. */
  thisMonth: string;
  onChange: (month: string) => void;
  disabled?: boolean;
}): JSX.Element {
  const options = monthsEnding(thisMonth, 12)
    .reverse()
    .map((value) => ({
      value,
      label: `${monthLabel(value)}${value === thisMonth ? " so far" : ""}`,
    }));
  return (
    <MenuChip
      icon={CalendarIcon}
      label="Month"
      disabled={disabled}
      display={
        <>
          {monthLabel(month)}
          {month === thisMonth ? (
            <span className="font-normal text-muted-foreground">so far</span>
          ) : null}
        </>
      }
      options={options}
      value={month}
      onChange={onChange}
      footer={
        <AnotherMonth
          month={month}
          thisMonth={thisMonth}
          onChoose={(value) => {
            if (value !== month) onChange(value);
          }}
        />
      }
    />
  );
}

function AnotherMonth({
  month,
  thisMonth,
  onChoose,
}: {
  month: string;
  thisMonth: string;
  onChoose: (month: string) => void;
}): JSX.Element {
  const inputId = useId();
  const errorId = useId();
  const [error, setError] = useState<string | null>(null);
  const closeMenu = useCloseMenu();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("month");
    const text = typeof value === "string" ? value.trim() : "";
    const problem = !reportMonthSchema.safeParse(text).success
      ? "Choose a month in YYYY-MM format"
      : text > thisMonth
        ? "Choose this month or an earlier one."
        : null;
    setError(problem);
    if (problem) return;
    closeMenu(true);
    onChoose(text);
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-1.5">
      <label
        htmlFor={inputId}
        className="text-xs leading-4 font-(--w-ui) text-muted-foreground"
      >
        Another month
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          name="month"
          type="month"
          max={thisMonth}
          defaultValue={month}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          className="h-9 min-w-0 flex-1 rounded-control border border-input bg-card px-3 text-sm text-foreground tabular-nums aria-invalid:border-destructive"
        />
        <Button type="submit" variant="outline" size="md">
          Show
        </Button>
      </div>
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="flex items-center gap-1.5 text-xs leading-4 text-destructive"
        >
          <CircleAlertIcon aria-hidden="true" className="size-3.5" />
          {error}
        </p>
      ) : null}
    </form>
  );
}
