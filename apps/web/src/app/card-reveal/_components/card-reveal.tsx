"use client";

import type { CardEmbed } from "lithic-embed";
import type { JSX, ReactNode, RefObject } from "react";
import { CircleAlertIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { mountCardEmbed } from "./card-embed";
import { createRevealSessionStore } from "./reveal-session";

/**
 * The page the app and browser open to show a card's details. It reads its
 * session from the URL fragment and gives it to Lithic's embed, and to
 * nothing else: no analytics, no logging, no calls to Expendi's API.
 */
export function CardReveal(): JSX.Element {
  const [store] = useState(() => createRevealSessionStore(() => window));
  const session = useSyncExternalStore(
    store.subscribe,
    store.read,
    () => undefined,
  );

  return (
    <main className="flex min-h-dvh items-start justify-center bg-gray-50 px-4 py-6 sm:items-center">
      <div className="w-full max-w-[400px] rounded-panel border border-gray-200 bg-surface p-5 shadow-panel">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg leading-[26px] font-(--w-title) text-gray-900">
            Card details
          </h1>
          <span className="inline-flex h-6 items-center rounded-full bg-gray-100 px-2 text-xs font-(--w-ui) text-gray-700">
            Sandbox
          </span>
        </div>
        {session === undefined ? (
          <RevealLoading />
        ) : session === null ? (
          <RevealUnavailable />
        ) : (
          <RevealDetails key={session} session={session} />
        )}
      </div>
    </main>
  );
}

function RevealLoading(): JSX.Element {
  return (
    <div aria-busy="true" className="mt-5 flex flex-col gap-4">
      <Skel width="100%" height={44} />
      <Skel width="100%" height={44} />
    </div>
  );
}

/** A missing or expired session looks the same to whoever opened the page. */
export function RevealUnavailable(): JSX.Element {
  return (
    <div role="alert" className="mt-4 flex items-start gap-2.5">
      <CircleAlertIcon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-error-700"
      />
      <p className="text-sm text-gray-700">
        This link has expired or isn&apos;t valid. Go back to your card and show
        its details again.
      </p>
    </div>
  );
}

type Phase = "mounting" | "ready" | "failed";

function RevealDetails({ session }: { session: string }): JSX.Element {
  const pan = useRef<HTMLDivElement>(null);
  const cvv = useRef<HTMLDivElement>(null);
  const expMonth = useRef<HTMLDivElement>(null);
  const expYear = useRef<HTMLDivElement>(null);
  const embedRef = useRef<CardEmbed | null>(null);
  const [phase, setPhase] = useState<Phase>("mounting");
  const [revealed, setRevealed] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    if (!pan.current || !cvv.current || !expMonth.current || !expYear.current) {
      return;
    }
    let live = true;
    const { embed, mounted } = mountCardEmbed(session, {
      pan: pan.current,
      cvv: cvv.current,
      expMonth: expMonth.current,
      expYear: expYear.current,
    });
    embedRef.current = embed;
    mounted.then(
      () => {
        if (live) setPhase("ready");
      },
      () => {
        if (live) setPhase("failed");
      },
    );
    return () => {
      live = false;
      embedRef.current = null;
      void embed.unmount();
    };
  }, [session]);

  async function toggle() {
    const embed = embedRef.current;
    if (!embed) return;
    setToggling(true);
    try {
      if (await embed.toggleMasking()) setRevealed((shown) => !shown);
    } catch {
      setPhase("failed");
    } finally {
      setToggling(false);
    }
  }

  if (phase === "failed") return <RevealUnavailable />;

  return (
    <CardFields
      pan={pan}
      cvv={cvv}
      expMonth={expMonth}
      expYear={expYear}
      ready={phase === "ready"}
      revealed={revealed}
      toggling={toggling}
      onToggle={() => void toggle()}
    />
  );
}

/** Where Lithic's iframes mount: each slot needs a set height to fill. */
export function CardFields({
  pan,
  cvv,
  expMonth,
  expYear,
  ready,
  revealed,
  toggling,
  onToggle,
}: {
  pan: RefObject<HTMLDivElement | null>;
  cvv: RefObject<HTMLDivElement | null>;
  expMonth: RefObject<HTMLDivElement | null>;
  expYear: RefObject<HTMLDivElement | null>;
  ready: boolean;
  revealed: boolean;
  toggling: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div className="mt-4 flex flex-col gap-4">
      <div aria-busy={!ready || undefined} className="flex flex-col gap-3">
        <Field label="Card number" ready={ready}>
          <div ref={pan} className={slotClass} />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
          <Field label="Expires" ready={ready}>
            <div className="flex items-center gap-1">
              <div ref={expMonth} className={`${slotClass} w-9`} />
              <span aria-hidden="true" className="text-gray-400">
                /
              </span>
              <div ref={expYear} className={`${slotClass} w-9`} />
            </div>
          </Field>
          <Field label="CVV" ready={ready}>
            <div ref={cvv} className={slotClass} />
          </Field>
        </div>
      </div>
      <Button
        className="w-full"
        variant={revealed ? "outline" : "default"}
        disabled={!ready || toggling}
        onClick={onToggle}
      >
        {revealed ? (
          <EyeOffIcon aria-hidden="true" />
        ) : (
          <EyeIcon aria-hidden="true" />
        )}
        {ready ? (revealed ? "Hide details" : "Show details") : "Loading…"}
      </Button>
      <p className="text-xs leading-4 text-gray-500">
        Only you can see this. Don&apos;t share these details or take a
        screenshot.
      </p>
    </div>
  );
}

const slotClass = "h-6 w-full min-w-0 text-base leading-6 text-gray-900";

/** Until Lithic's frame reports it's ready, a loading bar shows in its place. */
function Field({
  label,
  ready,
  children,
}: {
  label: string;
  ready: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs leading-4 font-(--w-ui) text-gray-500">{label}</p>
      <div className="relative flex min-h-11 items-center rounded-control border border-control-border bg-surface px-3">
        <div className={ready ? "w-full min-w-0" : "w-full min-w-0 opacity-0"}>
          {children}
        </div>
        {ready ? null : (
          <Skel
            width="calc(100% - 24px)"
            height={16}
            className="absolute left-3"
          />
        )}
      </div>
    </div>
  );
}
