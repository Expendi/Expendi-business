"use client";

import type { AnimationItem } from "lottie-web";
import type { JSX } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { CloseIcon } from "~/components/icons";
import { Lottie } from "~/components/ui/lottie";
import { staticUrl } from "~/lib/asset-url";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "~/lib/gsap";
import { cn } from "~/lib/utils";

const AVATAR_SRC = staticUrl("chatbot/qonto_chatbot.png");
const LOADER_SRC = staticUrl("decision_tree/qonto-flower-animate.json");
const PANEL_DURATION = 0.3;
const PANEL_SHADOW = "shadow-[1px_0_10px_2px_rgba(0,0,0,0.1)]";

function playLoader(animation: AnimationItem): void {
  if (prefersReducedMotion()) return;
  animation.loop = true;
  animation.play();
}

function ChatbotAvatar({
  size,
  alt,
}: {
  size: 32 | 56;
  alt: string;
}): JSX.Element {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 200px static PNG shown at a fixed size; next/image has nothing to optimise
    <img
      src={AVATAR_SRC}
      alt={alt}
      width={size}
      height={size}
      className={cn(
        "block rounded-full border-2 border-primary-white",
        size === 56 ? "size-56" : "size-32",
      )}
    />
  );
}

/**
 * Qonto's chatbot entry point: a round launcher fixed bottom-right that
 * toggles a small panel. The panel only shows the chatbot's loading flower;
 * its Lottie mounts on first open and unmounts once the panel has closed.
 */
export function ChatbotLauncher(): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [loaderMounted, setLoaderMounted] = useState(false);

  useGSAP(
    () => {
      const panel = panelRef.current;
      if (!panel) return;
      const duration = prefersReducedMotion() ? 0 : PANEL_DURATION;
      if (open) {
        gsap.to(panel, {
          autoAlpha: 1,
          scale: 1,
          y: 0,
          duration,
          ease: "back.out(2)",
          overwrite: true,
        });
        return;
      }
      gsap.to(panel, {
        autoAlpha: 0,
        scale: 0.9,
        y: 10,
        duration,
        ease: "back.in(2)",
        overwrite: true,
        onComplete: () => {
          setLoaderMounted(false);
        },
      });
    },
    { scope: panelRef, dependencies: [open] },
  );

  useGSAP(
    () => {
      const launcher = launcherRef.current;
      if (!launcher) return;
      gsap.set(launcher, { autoAlpha: 0 });
      ScrollTrigger.create({
        start: () => window.innerHeight,
        end: "max",
        onToggle: (self) => {
          gsap.to(launcher, {
            autoAlpha: self.isActive ? 1 : 0,
            duration: prefersReducedMotion() ? 0 : PANEL_DURATION,
            ease: "none",
            overwrite: true,
          });
        },
      });
    },
    { scope: launcherRef },
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      launcherRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = (): void => {
    if (!open) setLoaderMounted(true);
    setOpen(!open);
  };

  const close = (): void => {
    setOpen(false);
    launcherRef.current?.focus();
  };

  return (
    <>
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-label="Qonto chatbot"
        className={cn(
          "invisible fixed right-16 bottom-108 z-10000 max-h-500 min-h-142 w-360 max-w-[calc(100vw-32px)] origin-bottom-right rounded-md bg-primary-white opacity-0",
          PANEL_SHADOW,
        )}
      >
        <div className="absolute inset-x-0 top-0 z-1 flex items-center justify-between rounded-t-md bg-grey-900 px-15 py-8 text-primary-white">
          <div className="flex items-center">
            <div className="relative">
              <ChatbotAvatar size={32} alt="" />
              <span className="absolute right-0 bottom-0 size-12 rounded-full border-2 border-primary-white bg-chatbot-online" />
            </div>
            <div className="ml-14 text-14 leading-24 font-semibold">Qonto</div>
          </div>
          <button
            type="button"
            aria-label="Close chat"
            onClick={close}
            className="flex size-32 cursor-pointer items-center justify-center"
          >
            <CloseIcon width={16} height={16} />
          </button>
        </div>
        <div className="absolute inset-x-0 top-0 z-0 overflow-y-auto px-16 pt-56 pb-14 text-12 leading-24">
          <div className="flex items-center justify-center">
            {loaderMounted ? (
              <Lottie
                src={LOADER_SRC}
                mode="manual"
                onReady={playLoader}
                className="mx-auto size-46"
              />
            ) : null}
          </div>
        </div>
      </div>
      <button
        ref={launcherRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close Qonto chatbot" : "Open Qonto chatbot"}
        onClick={toggle}
        className={cn(
          "invisible fixed right-16 bottom-80 z-10001 flex opacity-0 md:bottom-36 size-56 cursor-pointer items-center justify-center rounded-full bg-grey-900",
          open ? "shadow-[0_7px_6px_1px_rgba(0,0,0,0.16)]" : PANEL_SHADOW,
        )}
      >
        {open ? (
          <CloseIcon width={16} height={16} className="text-primary-white" />
        ) : (
          <ChatbotAvatar size={56} alt="Qonto chatbot" />
        )}
      </button>
    </>
  );
}
