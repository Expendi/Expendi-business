"use client";

import type { AnimationItem } from "lottie-web";
import type { JSX } from "react";
import { CustomEase } from "gsap/CustomEase";
import { useEffect, useId, useRef, useState } from "react";

import { CloseIcon, EditIcon } from "~/components/icons";
import { Lottie } from "~/components/ui/lottie";
import { staticUrl } from "~/lib/asset-url";
import {
  EASE,
  gsap,
  prefersReducedMotion,
  ScrollTrigger,
  useGSAP,
} from "~/lib/gsap";
import { cn } from "~/lib/utils";

const AVATAR_SRC = staticUrl("chatbot/qonto_chatbot.png");
const LOADER_SRC = staticUrl("decision_tree/qonto-flower-animate.json");
const PANEL_DURATION = 0.3;
const PANEL_SHADOW = "shadow-[1px_0_10px_2px_rgba(0,0,0,0.1)]";
const PANEL_EASE = CustomEase.create("qontoChatbot", "0.73,-0.63,0.39,2.69");
const TOOLTIP_EASE = CustomEase.create("qontoChatbotHint", "0.34,1.56,0.64,1");
const TOOLTIP_DELAY = 30_000;

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
 * toggles a panel. The panel only shows the chatbot's loading flower;
 * its Lottie mounts on first open and unmounts once the panel has closed.
 */
export function ChatbotLauncher(): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [loaderMounted, setLoaderMounted] = useState(false);
  const [loaderVersion, setLoaderVersion] = useState(0);
  const [launcherVisible, setLauncherVisible] = useState(false);
  const [tooltipSeen, setTooltipSeen] = useState(false);
  const [tooltipDismissed, setTooltipDismissed] = useState(false);
  const tooltipVisible =
    launcherVisible && !open && !tooltipDismissed && tooltipSeen;

  useEffect(() => {
    if (!launcherVisible || open || tooltipDismissed || tooltipSeen) return;
    const timer = window.setTimeout(() => {
      setTooltipSeen(true);
    }, TOOLTIP_DELAY);
    return () => {
      window.clearTimeout(timer);
    };
  }, [launcherVisible, open, tooltipDismissed, tooltipSeen]);

  useGSAP(
    () => {
      const tooltip = tooltipRef.current;
      const badge = badgeRef.current;
      if (!tooltip || !badge) return;
      const duration = prefersReducedMotion() ? 0 : PANEL_DURATION;
      gsap.set(tooltip, { pointerEvents: tooltipVisible ? "auto" : "none" });
      if (tooltipVisible) {
        gsap.fromTo(
          tooltip,
          { autoAlpha: 0, y: 20, scale: 0.9 },
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration,
            ease: TOOLTIP_EASE,
            overwrite: "auto",
          },
        );
        gsap.set(badge, { autoAlpha: 1 });
      } else {
        gsap.to(tooltip, {
          autoAlpha: 0,
          scale: 0.8,
          duration: tooltipDismissed ? duration : 0,
          ease: EASE.cssOut,
          overwrite: "auto",
        });
        gsap.to(badge, {
          autoAlpha: 0,
          duration: tooltipDismissed ? duration : 0,
          ease: EASE.cssOut,
          overwrite: "auto",
        });
      }
    },
    { scope: tooltipRef, dependencies: [tooltipVisible, tooltipDismissed] },
  );

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
          ease: PANEL_EASE,
          overwrite: "auto",
        });
        return;
      }
      gsap.to(panel, {
        autoAlpha: 0,
        scale: 0.9,
        y: 10,
        duration,
        ease: PANEL_EASE,
        overwrite: "auto",
        onComplete: () => {
          setLoaderMounted(false);
        },
      });
    },
    { scope: panelRef, dependencies: [open] },
  );

  useGSAP(
    (_context, contextSafe) => {
      const launcher = launcherRef.current;
      if (!launcher || !contextSafe) return;
      const hero = document.querySelector("main section");
      let wasVisible: boolean | undefined;
      const updateVisibility = contextSafe((): void => {
        // The live launcher toggles immediately when the first section leaves.
        // Keep the close control available while its panel is open.
        const visible =
          open || (hero ? hero.getBoundingClientRect().bottom < 0 : true);
        if (visible === wasVisible) return;
        wasVisible = visible;
        gsap.set(launcher, { autoAlpha: visible ? 1 : 0 });
        setLauncherVisible(visible);
      });
      ScrollTrigger.create({
        start: 0,
        end: () => ScrollTrigger.maxScroll(window) + 1,
        onUpdate: updateVisibility,
        onRefresh: updateVisibility,
      });
      updateVisibility();
    },
    { scope: launcherRef, dependencies: [open], revertOnUpdate: true },
  );

  useGSAP(
    (_context, contextSafe) => {
      const launcher = launcherRef.current;
      const panel = panelRef.current;
      const bar = document.querySelector<HTMLElement>(
        "[data-mobile-cta-visible]",
      );
      if (!launcher || !panel || !bar || !contextSafe) return;

      let previousBottom: number | undefined;
      const updateOffset = contextSafe((): void => {
        const raised =
          window.innerWidth < 768 && bar.dataset.mobileCtaVisible === "true";
        // The measured 72px bar includes any device safe-area padding.
        const bottom = raised ? bar.offsetHeight + 8 : 36;
        if (bottom === previousBottom) return;
        const duration =
          previousBottom === undefined || prefersReducedMotion()
            ? 0
            : PANEL_DURATION;
        previousBottom = bottom;
        gsap.to(launcher, {
          bottom,
          duration,
          ease: EASE.qonto,
          overwrite: "auto",
        });
        gsap.to(panel, {
          bottom: bottom + 72,
          duration,
          ease: EASE.qonto,
          overwrite: "auto",
        });
        if (tooltipRef.current) {
          gsap.to(tooltipRef.current, {
            bottom: bottom + 4,
            duration,
            ease: EASE.qonto,
            overwrite: "auto",
          });
        }
        if (badgeRef.current) {
          gsap.to(badgeRef.current, {
            bottom: bottom + 40,
            duration,
            ease: EASE.qonto,
            overwrite: "auto",
          });
        }
      });
      const visibilityObserver = new MutationObserver(updateOffset);
      visibilityObserver.observe(bar, {
        attributes: true,
        attributeFilter: ["data-mobile-cta-visible"],
      });
      const sizeObserver = new ResizeObserver(updateOffset);
      sizeObserver.observe(bar);
      updateOffset();
      return () => {
        visibilityObserver.disconnect();
        sizeObserver.disconnect();
      };
    },
    { scope: panelRef },
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
    if (!open) {
      setLoaderMounted(true);
      if (tooltipSeen) setTooltipDismissed(true);
    }
    setOpen(!open);
  };

  const restart = (): void => {
    setLoaderVersion((version) => version + 1);
    setLoaderMounted(true);
  };

  return (
    <>
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-label="Qonto chatbot"
        className={cn(
          "invisible fixed right-0 bottom-108 z-10000 h-full max-h-500 min-h-142 w-full origin-bottom-right rounded-md bg-primary-white opacity-0 md:right-16 md:w-360",
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
            aria-label="Start again"
            onClick={restart}
            className="flex size-32 cursor-pointer items-center justify-start"
          >
            <EditIcon width={20} height={20} aria-hidden="true" />
          </button>
        </div>
        <div className="absolute inset-x-0 top-0 z-0 overflow-y-auto px-16 pt-56 pb-14 text-12 leading-24">
          <div className="flex items-center justify-center">
            {loaderMounted ? (
              <Lottie
                key={loaderVersion}
                src={LOADER_SRC}
                mode="manual"
                onReady={playLoader}
                className="mx-auto size-46"
              />
            ) : null}
          </div>
        </div>
      </div>
      <div
        ref={tooltipRef}
        id={tooltipId}
        aria-hidden={!tooltipVisible}
        inert={!tooltipVisible}
        className={cn(
          "invisible fixed right-100 bottom-40 z-10002 max-w-300 rounded-md bg-primary-white px-16 py-12 opacity-0",
          PANEL_SHADOW,
        )}
      >
        <div className="text-16 leading-24 font-medium text-grey-900">
          👋 Hello! Need help?
        </div>
        <div
          aria-hidden="true"
          className="absolute -right-8 -bottom-2 size-0 -translate-y-full border-y-8 border-l-8 border-y-transparent border-l-primary-white"
        />
        <button
          type="button"
          aria-label="Dismiss chat help"
          onClick={() => setTooltipDismissed(true)}
          className="absolute top-0 -left-24 flex size-20 cursor-pointer items-center justify-center rounded-full border border-primary-white bg-grey-600 text-primary-white"
        >
          <CloseIcon width={8} height={8} aria-hidden="true" />
        </button>
      </div>
      <div
        ref={badgeRef}
        aria-hidden="true"
        className="pointer-events-none invisible fixed right-16 bottom-76 z-10002 flex size-16 items-center justify-center rounded-full bg-[#f95656] text-12 leading-24 font-bold text-primary-white opacity-0"
      >
        1
      </div>
      <button
        ref={launcherRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={tooltipVisible ? tooltipId : undefined}
        aria-label={open ? "Close Qonto chatbot" : "Open Qonto chatbot"}
        onClick={toggle}
        className={cn(
          "invisible fixed right-16 bottom-36 z-10001 flex size-56 cursor-pointer items-center justify-center rounded-full bg-grey-900 opacity-0",
          open ? "shadow-[0_7px_6px_1px_rgba(0,0,0,0.16)]" : PANEL_SHADOW,
        )}
      >
        {open ? (
          <CloseIcon width={24} height={24} className="text-primary-white" />
        ) : (
          <ChatbotAvatar size={56} alt="Qonto chatbot" />
        )}
      </button>
    </>
  );
}
