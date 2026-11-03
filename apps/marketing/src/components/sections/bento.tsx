"use client";

import type { JSX, ReactNode } from "react";
import { useRef, useState } from "react";

import type { AssetId } from "~/lib/assets";
import { ButtonLink } from "~/components/ui/button";
import { Lottie } from "~/components/ui/lottie";
import { QontoImage } from "~/components/ui/qonto-image";
import { lottieUrl } from "~/lib/asset-url";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "~/lib/gsap";
import { cn } from "~/lib/utils";

const PHOTO_LAYER = "pointer-events-none absolute inset-0 bg-cover bg-center";

const GET_PAID_PHOTO =
  "bg-[url(/qonto/asset/35054/md.avif)] md:bg-[url(/qonto/asset/35054/lg.avif)] lg:bg-[url(/qonto/asset/35054/xl.avif)]";

const CARDS_PHOTO =
  "bg-[url(/qonto/asset/33297/md.avif)] md:bg-[url(/qonto/asset/33297/lg.avif)] lg:bg-[url(/qonto/asset/33298/xl.avif)]";

interface CardCopyProps {
  title: string;
  body: string;
  bodyClassName?: string;
  className?: string;
}

function CardCopy({
  title,
  body,
  bodyClassName,
  className,
}: CardCopyProps): JSX.Element {
  return (
    <div className={cn("flex max-w-510 flex-col gap-16", className)}>
      <h3 className="h3-small">{title}</h3>
      <p className={cn("body-regular", bodyClassName)}>{body}</p>
    </div>
  );
}

interface PanelCardProps {
  title: string;
  body: string;
  icon: AssetId;
  iconAlt: string;
  visual: ReactNode;
  className: string;
}

/**
 * Solid tile below lg (icon above copy via `flex-col-reverse`), radial
 * gradient with a bottom-anchored visual from lg.
 */
function PanelCard({
  title,
  body,
  icon,
  iconAlt,
  visual,
  className,
}: PanelCardProps): JSX.Element {
  return (
    <div
      className={cn(
        "relative flex flex-col-reverse justify-end gap-16 rounded-2xl bg-grey-900 p-16 lg:surface-container-gradient-dark lg:flex-col lg:gap-24 lg:rounded-3xl lg:p-24 lg:pb-0",
        className,
      )}
    >
      <CardCopy title={title} body={body} bodyClassName="lg:max-w-437" />
      {visual}
      <div className="flex h-40 flex-col items-start justify-center overflow-hidden lg:hidden">
        <div className="flex size-40 items-center justify-center rounded-sm bg-grey-700 p-8">
          <QontoImage
            asset={icon}
            alt={iconAlt}
            className="size-24 brightness-0 invert"
          />
        </div>
      </div>
    </div>
  );
}

interface PhotoCardProps {
  title: string;
  body: string;
  photoClassName: string;
  blurClassName: string;
  scrimClassName: string;
  className: string;
}

function PhotoCard({
  title,
  body,
  photoClassName,
  blurClassName,
  scrimClassName,
  className,
}: PhotoCardProps): JSX.Element {
  return (
    <div
      className={cn(
        "relative isolate flex h-471 flex-col justify-between overflow-hidden rounded-2xl p-16 lg:h-auto lg:rounded-3xl lg:p-24",
        className,
      )}
    >
      <div className={cn(PHOTO_LAYER, photoClassName)} />
      <div className={cn(PHOTO_LAYER, photoClassName, blurClassName)} />
      <div
        className={cn("pointer-events-none absolute inset-0", scrimClassName)}
      />
      <CardCopy
        title={title}
        body={body}
        bodyClassName="mb-32"
        className="z-10"
      />
    </div>
  );
}

/** Qonto's `data-wr-lottie-target=fadeIn`: hidden until the JSON is parsed. */
function PayAnimation(): JSX.Element {
  const fade = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useGSAP(
    () => {
      const element = fade.current;
      if (!ready || !element) return;
      gsap.to(element, {
        opacity: 1,
        duration: prefersReducedMotion() ? 0 : 0.5,
        ease: EASE.qonto,
      });
    },
    { scope: fade, dependencies: [ready] },
  );

  return (
    <div className="hidden flex-1 items-end justify-center overflow-hidden lg:flex">
      <div ref={fade} className="size-full opacity-0">
        <Lottie
          src={lottieUrl("38018")}
          mode="inview-once"
          preserveAspectRatio="xMidYMid slice"
          onReady={() => {
            setReady(true);
          }}
          className="size-full"
        />
      </div>
    </div>
  );
}

function FinancingPhone(): JSX.Element {
  return (
    <div className="mt-auto hidden items-end justify-center overflow-hidden lg:flex">
      <div className="flex h-full items-end">
        <QontoImage
          asset="33887"
          alt="WEB ENDE UI  Hero TopicHighlight Bento Headline Cards Financing Simulation DarkMode WbRvmp"
          sizes="440px"
          className="max-h-440 max-w-440 object-cover lg:max-h-full lg:max-w-full"
        />
      </div>
    </div>
  );
}

export function Bento(): JSX.Element {
  return (
    <section
      id="section-3"
      data-header-theme="dark"
      className="darkmode w-full bg-primary-black text-primary-white"
    >
      <div className="container-qonto py-48 lg:py-80">
        <div className="grid auto-rows-min grid-cols-1 gap-y-24 md:gap-y-32 lg:grid-cols-[1fr_auto] lg:gap-x-56 lg:gap-y-56">
          <h2 className="lg:self-center">
            Business account, <span className="text-grey-500">AI-powered.</span>
          </h2>

          <div className="col-span-full grid grid-cols-6 gap-8 md:grid-cols-12 md:gap-16 lg:grid-cols-24 lg:grid-rows-[repeat(4,192px)] lg:gap-24">
            <div className="col-span-6 flex max-h-288 min-h-128 items-center justify-between gap-24 rounded-2xl border border-grey-600 p-16 md:col-span-12 lg:col-span-8 lg:col-start-1 lg:row-start-1 lg:flex-col lg:items-start lg:rounded-3xl lg:p-24">
              <CardCopy
                title="Account remuneration"
                body="Earn up to 5%* on your Qonto account balance."
              />
            </div>

            <PanelCard
              title="Pay"
              body="SEPA & global transfers, virtual cards, & Apple Pay/Google Pay."
              icon="26498"
              iconAlt="WEB Iconography BlackTransfer"
              visual={<PayAnimation />}
              className="col-span-3 max-lg:order-4 md:col-span-6 lg:col-span-8 lg:col-start-9 lg:row-span-2 lg:row-start-1"
            />

            <PhotoCard
              title="Get paid"
              body="Invoices with embedded payment links, Tap to Pay & POS terminals."
              photoClassName={GET_PAID_PHOTO}
              blurClassName="photo-blur-top-to-bottom"
              scrimClassName="scrim-dark-top-to-bottom"
              className="col-span-6 max-lg:order-5 md:col-span-12 lg:col-span-8 lg:col-start-17 lg:row-span-2 lg:row-start-1"
            />

            <PanelCard
              title="Credit suite"
              body="A range of working capital solutions, integrated into your business account."
              icon="33263"
              iconAlt="WEB Iconography Black Calendar WbRvmp"
              visual={<FinancingPhone />}
              className="col-span-3 max-lg:order-4 md:col-span-6 lg:col-span-8 lg:col-start-1 lg:row-span-3 lg:row-start-2"
            />

            <PhotoCard
              title="Mastercard debit and credit cards"
              body="Choose instant or deferred debit. Limits up to €200,000/month."
              photoClassName={CARDS_PHOTO}
              blurClassName="photo-blur-top-to-bottom lg:photo-blur-left-to-right"
              scrimClassName="scrim-dark-top-to-bottom lg:scrim-dark-left-to-right"
              className="col-span-6 max-lg:order-2 md:col-span-12 lg:col-span-16 lg:col-start-9 lg:row-span-2 lg:row-start-3"
            />
          </div>

          <div className="flex flex-wrap gap-16 lg:col-start-2 lg:row-start-1 lg:mb-6 lg:self-end">
            <ButtonLink
              href="https://qonto.com/en/open-an-account"
              variant="secondary"
            >
              Discover our business account
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}
