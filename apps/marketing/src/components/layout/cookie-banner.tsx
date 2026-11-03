"use client";

import type { JSX, ReactNode } from "react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { ChevronDownIcon, CloseIcon, QontoWordmark } from "~/components/icons";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "~/lib/gsap";
import { cn } from "~/lib/utils";

const CONSENT_STORAGE_KEY = "qonto-clone-consent";
const COOKIE_POLICY_HREF = "https://qonto.com/en/cookies";
const PRIVACY_POLICY_HREF = "https://legal.qonto.com/en#template-6uiwuhdde";

const ENTER_DELAY = 0.5;
const ENTER_DURATION = 0.3;
const EXIT_DURATION = 0.2;
const DIALOG_OFFSET_Y = 20;

const NOTICE_BODY =
  'Like many websites, we use cookies. They allow us to follow your interactions on our site and this data helps us to personalize your experience while you\'re here. For example, we might use your data to display personalized ads. By clicking "Accept", you are giving us your consent to use cookies in this way. You can change your cookie settings at any time and can read our full cookie policy ';

const PURPOSES = [
  { id: "functional", label: "Functional, technical and security" },
  { id: "audience", label: "Audience and content measurement" },
  { id: "personalization", label: "Personalization" },
  { id: "advertising", label: "Advertising" },
  { id: "advertising-partners", label: "Advertising" },
  { id: "marketing", label: "Marketing" },
  { id: "analytics", label: "Analytics" },
] as const;

type ConsentChoice = "accepted" | "declined" | "customized";
type ConsentView = "notice" | "preferences";
type PurposeId = (typeof PURPOSES)[number]["id"];
type PurposeChoices = Partial<Record<PurposeId, boolean>>;

const consentListeners = new Set<() => void>();
/** `undefined` until first read; `null` when no choice has been stored. */
let storedConsent: string | null | undefined;

function readStoredConsent(): string | null {
  try {
    return window.localStorage.getItem(CONSENT_STORAGE_KEY);
  } catch (error) {
    console.warn(
      "Cookie consent could not be read from localStorage; showing the banner.",
      error,
    );
    return null;
  }
}

function getHasConsent(): boolean {
  if (storedConsent === undefined) storedConsent = readStoredConsent();
  return storedConsent !== null;
}

function subscribeToConsent(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== CONSENT_STORAGE_KEY) return;
    storedConsent = undefined;
    onChange();
  };
  consentListeners.add(onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    consentListeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

interface ConsentSelection {
  choice: ConsentChoice;
  purposes?: PurposeChoices;
}

function saveConsent({ choice, purposes }: ConsentSelection): void {
  storedConsent = purposes ? JSON.stringify({ choice, purposes }) : choice;
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, storedConsent);
  } catch (error) {
    console.warn(
      "Cookie consent could not be saved to localStorage; it applies to this visit only.",
      error,
    );
  }
  consentListeners.forEach((listener) => {
    listener();
  });
}

function choicesFor(allowed: boolean): PurposeChoices {
  const choices: PurposeChoices = {};
  for (const { id } of PURPOSES) choices[id] = allowed;
  return choices;
}

/**
 * Didomi-style consent popup shown until a choice is stored. The server pass
 * and hydration render nothing, so the popup only appears once the stored
 * consent can be read on the client.
 */
export function CookieBanner(): JSX.Element | null {
  const hasConsent = useSyncExternalStore(
    subscribeToConsent,
    getHasConsent,
    () => null,
  );
  if (hasConsent !== false) return null;
  return <ConsentPopup />;
}

function ConsentPopup(): JSX.Element {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [view, setView] = useState<ConsentView>("notice");
  const [closingChoice, setClosingChoice] = useState<ConsentSelection | null>(
    null,
  );

  useEffect(() => {
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      root.style.overflow = previousOverflow;
    };
  }, []);

  useGSAP(
    () => {
      const backdrop = backdropRef.current;
      const dialog = dialogRef.current;
      if (!backdrop || !dialog || prefersReducedMotion()) return;
      gsap
        .timeline({
          delay: ENTER_DELAY,
          defaults: { duration: ENTER_DURATION, ease: EASE.cssOut },
        })
        .from(backdrop, { opacity: 0 })
        .from(dialog, { y: DIALOG_OFFSET_Y, opacity: 0 }, 0);
    },
    { scope: backdropRef },
  );

  useGSAP(
    () => {
      const backdrop = backdropRef.current;
      const dialog = dialogRef.current;
      if (!closingChoice || !backdrop || !dialog) return;
      const finish = (): void => {
        saveConsent(closingChoice);
      };
      if (prefersReducedMotion()) {
        finish();
        return;
      }
      gsap
        .timeline({
          defaults: {
            duration: EXIT_DURATION,
            ease: EASE.cssOut,
            overwrite: true,
          },
          onComplete: finish,
        })
        .to(dialog, { y: DIALOG_OFFSET_Y, opacity: 0 })
        .to(backdrop, { opacity: 0 }, 0);
    },
    { scope: backdropRef, dependencies: [closingChoice] },
  );

  const close = (choice: ConsentChoice, purposes?: PurposeChoices): void => {
    setClosingChoice((current) => current ?? { choice, purposes });
  };

  const showView = (next: ConsentView): void => {
    setView(next);
    dialogRef.current?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={backdropRef}
      className={cn(
        "fixed inset-0 z-[2147483641] flex overflow-auto bg-[rgba(29,29,27,0.5)] text-[15px] leading-24 font-normal text-black",
        closingChoice && "pointer-events-none",
      )}
    >
      <div className="m-auto w-full max-w-full rounded-[5px] border border-transparent p-px min-[480px]:w-auto">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="relative flex w-full flex-col items-center rounded-lg border border-transparent bg-primary-white p-32 text-12 leading-[19.2px] outline-none min-[480px]:w-[464px] min-[480px]:text-[15px] min-[480px]:leading-24"
        >
          {view === "notice" ? (
            <NoticeView
              titleId={titleId}
              onChoose={close}
              onFindOutMore={() => {
                showView("preferences");
              }}
            />
          ) : (
            <PreferencesView
              titleId={titleId}
              onClose={() => {
                showView("notice");
              }}
              onSave={(choices) => {
                close("customized", choices);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface NoticeViewProps {
  titleId: string;
  onChoose: (choice: ConsentChoice) => void;
  onFindOutMore: () => void;
}

function NoticeView({
  titleId,
  onChoose,
  onFindOutMore,
}: NoticeViewProps): JSX.Element {
  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => {
          onChoose("declined");
        }}
        className="absolute top-20 right-20 z-1000 cursor-pointer text-[rgb(99,99,96)] underline hover:opacity-70"
      >
        Continue without agreeing <span aria-hidden="true">→</span>
      </button>
      <QontoWordmark
        role="img"
        aria-label="Qonto"
        width={200}
        height={57}
        className="block text-[rgb(29,29,27)]"
      />
      <div className="mt-30 text-justify min-[480px]:text-left">
        <div id={titleId} className="mb-16 text-20 leading-24">
          Your data. Your choice.
        </div>
        <p className="text-14 leading-24 font-light min-[480px]:text-16">
          {NOTICE_BODY}
          <a
            href={COOKIE_POLICY_HREF}
            className="font-bold text-primary-black underline"
          >
            right here
          </a>
          .
        </p>
      </div>
      <div className="mt-25 flex flex-col gap-10 min-[480px]:mt-30 min-[480px]:flex-row min-[480px]:justify-between">
        <button
          type="button"
          onClick={onFindOutMore}
          className="min-h-40 shrink-0 cursor-pointer rounded-sm border border-[rgb(29,29,27)] px-16 py-8 text-16 leading-30 font-bold tracking-[0.16px] text-[rgb(68,68,68)] hover:opacity-70 min-[480px]:w-200"
        >
          Find out more
        </button>
        <button
          type="button"
          onClick={() => {
            onChoose("accepted");
          }}
          className="min-h-40 shrink-0 cursor-pointer rounded-sm border border-[rgba(29,29,27,0.3)] bg-[rgb(29,29,27)] px-25 py-2 text-16 leading-[22.4px] font-bold tracking-[0.16px] text-primary-white hover:opacity-70 min-[480px]:w-200"
        >
          Accept
        </button>
      </div>
    </div>
  );
}

interface PreferencesViewProps {
  titleId: string;
  onClose: () => void;
  onSave: (choices: PurposeChoices) => void;
}

/**
 * Simplified Didomi preferences screen ("Find out more"): one Agree/Disagree
 * pair per purpose plus a global pair. Save unlocks once every purpose has a
 * choice, as on Qonto.
 */
function PreferencesView({
  titleId,
  onClose,
  onSave,
}: PreferencesViewProps): JSX.Element {
  const [choices, setChoices] = useState<PurposeChoices>({});
  const values = PURPOSES.map(({ id }) => choices[id]);
  const isComplete = values.every((value) => value !== undefined);
  let allValue: boolean | undefined;
  if (values.every((value) => value === true)) allValue = true;
  else if (values.every((value) => value === false)) allValue = false;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-16">
        <div id={titleId} className="text-22 leading-30 font-bold">
          Privacy Policy
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex size-16 shrink-0 cursor-pointer items-center justify-center text-[rgb(99,99,96)] hover:opacity-70"
        >
          <CloseIcon width={12} height={12} />
        </button>
      </div>
      <div className="text-14 leading-24 font-light">
        <p>Our partners. Your settings.</p>
        <p>
          We and <PolicyLink href={COOKIE_POLICY_HREF}>our partners</PolicyLink>{" "}
          use the data collected by cookies to improve your user experience. By
          tailoring ads and content to your own preferences, for example. You
          are free to give or withhold your consent for this usage. To learn
          more about the data we collect and use, our analysis methods and our
          partners, you can read our{" "}
          <PolicyLink href={PRIVACY_POLICY_HREF}>privacy policy</PolicyLink>.
        </p>
      </div>
      <div className="mt-18 flex items-start justify-between gap-10">
        <span className="text-12 leading-20 font-semibold text-[rgb(79,93,96)] uppercase">
          You allow
        </span>
        <ChoiceButtons
          label="All purposes"
          value={allValue}
          onChange={(allowed) => {
            setChoices(choicesFor(allowed));
          }}
        />
      </div>
      <ul className="mt-20 flex flex-col gap-12">
        {PURPOSES.map(({ id, label }) => (
          <li key={id} className="flex items-center justify-between gap-10">
            <span className="min-w-0 flex-1 text-12 leading-24">
              <ChevronDownIcon
                width={12}
                height={8}
                className="mr-6 inline-block align-middle text-[rgb(99,99,96)]"
              />
              {label}
            </span>
            <ChoiceButtons
              label={label}
              value={choices[id]}
              onChange={(allowed) => {
                setChoices((current) => ({ ...current, [id]: allowed }));
              }}
            />
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={!isComplete}
        onClick={() => {
          onSave(choices);
        }}
        className="mt-41 mb-10 block h-37 cursor-pointer rounded-sm border border-[rgb(29,29,27)] px-20 text-16 leading-24 font-bold tracking-[0.16px] text-[rgb(68,68,68)] hover:opacity-70 disabled:cursor-default disabled:border-[rgb(160,160,160)] disabled:text-[rgb(148,148,148)] disabled:hover:opacity-100"
      >
        Save
      </button>
    </div>
  );
}

function PolicyLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <a href={href} className="font-bold text-primary-black underline">
      {children}
    </a>
  );
}

interface ChoiceButtonsProps {
  label: string;
  value: boolean | undefined;
  onChange: (allowed: boolean) => void;
}

function ChoiceButtons({
  label,
  value,
  onChange,
}: ChoiceButtonsProps): JSX.Element {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 gap-8">
      <ChoiceButton
        pressed={value === false}
        onClick={() => {
          onChange(false);
        }}
      >
        Disagree
      </ChoiceButton>
      <ChoiceButton
        pressed={value === true}
        onClick={() => {
          onChange(true);
        }}
      >
        Agree
      </ChoiceButton>
    </div>
  );
}

function ChoiceButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "h-32 cursor-pointer rounded-sm border border-[rgb(29,29,27)] px-20 text-12 leading-30 font-bold hover:opacity-70",
        pressed ? "bg-[rgb(29,29,27)] text-primary-white" : "text-black",
      )}
    >
      {children}
    </button>
  );
}
