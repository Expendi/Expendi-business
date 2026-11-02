"use client";

import type { JSX, ReactNode } from "react";

import { CenteredCard } from "./centered-card";
import { textButton } from "./styles";

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

/** A signed-in dead end: a heading, an optional line and a way out. */
export function SessionNotice({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions: NoticeAction[];
}): JSX.Element {
  return (
    <CenteredCard>
      <h1 className="text-lg font-semibold">{title}</h1>
      {children}
      <div className="mt-6 flex flex-wrap gap-4">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            className={textButton}
          >
            {action.label}
          </button>
        ))}
      </div>
    </CenteredCard>
  );
}
