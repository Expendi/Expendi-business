"use client";

import type { JSX } from "react";
import { CustomEase } from "gsap/CustomEase";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { SectionTheme } from "~/types/content";
import { ArrowIcon, QontoLogo } from "~/components/icons";
import { ButtonLink } from "~/components/ui/button";
import { NAV_MENUS } from "~/content/navigation";
import { EASE, gsap, useGSAP } from "~/lib/gsap";
import { useSectionTheme } from "~/lib/section-theme";
import { cn } from "~/lib/utils";
import { motionDuration, SIGN_IN_HREF, SIGN_UP_HREF } from "./header/constants";
import { DesktopNav } from "./header/desktop-nav";
import { Hamburger } from "./header/hamburger";
import { LanguageSwitch } from "./header/language-switch";
import { MobileDrawer } from "./header/mobile-drawer";

const DESKTOP_QUERY = "(min-width: 1024px)";
const DRAWER_ID = "nav-menu";
const SCRIM_DARK = "rgba(5, 5, 5, 0.7)";
const SCRIM_LIGHT = "rgba(255, 255, 255, 0.7)";
const SURFACE = "rgba(255, 255, 255, 1)";
const LOGO_EXIT_X = -137;
const BACK_ENTER_X = 39.5;
const BORDER_EASE = CustomEase.create("qontoBorder", "0.54,0,0.2,1");

function subscribeToViewport(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function isDesktopViewport(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

function isDesktopOnServer(): boolean {
  return false;
}

interface SectionThemeProbeProps {
  offset: number;
  onChange: (theme: SectionTheme) => void;
}

/**
 * Keyed by `offset` in the parent so a breakpoint change remounts it:
 * `useSectionTheme` keeps its previous ScrollTriggers alive when only the
 * offset dependency changes.
 */
function SectionThemeProbe({ offset, onChange }: SectionThemeProbeProps): null {
  const theme = useSectionTheme(offset);
  useEffect(() => {
    onChange(theme);
  }, [theme, onChange]);
  return null;
}

/**
 * Qonto's fixed header: a blurred scrim that follows the theme of the section
 * under its bottom edge, hover mega menus and a language picker from 1024px,
 * and a slide-in drawer with category sub-panels below that.
 */
export function SiteHeader(): JSX.Element {
  const isDesktop = useSyncExternalStore(
    subscribeToViewport,
    isDesktopViewport,
    isDesktopOnServer,
  );
  const [sectionTheme, setSectionTheme] = useState<SectionTheme>("dark");
  const [activeMenu, setActiveMenu] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [category, setCategory] = useState(0);

  const headerRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const borderRef = useRef<HTMLSpanElement>(null);
  const logoRef = useRef<HTMLAnchorElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);

  const menuOpen = isDesktop && activeMenu !== null;
  const drawerVisible = drawerOpen && !isDesktop;
  const categoryVisible = drawerVisible && categoryOpen;
  const solid = menuOpen || drawerVisible;
  const dark = sectionTheme === "dark" && !solid;
  const background = solid ? SURFACE : dark ? SCRIM_DARK : SCRIM_LIGHT;

  useGSAP(
    () => {
      const nav = navRef.current;
      if (!nav) return;
      gsap.to(nav, {
        backgroundColor: background,
        duration: motionDuration(0.5),
        ease: EASE.cssOut,
        overwrite: true,
      });
    },
    { scope: headerRef, dependencies: [background] },
  );

  useGSAP(
    () => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      if (!menuOpen) {
        gsap.set(overlay, { opacity: 0, overwrite: true });
        return;
      }
      gsap.fromTo(
        overlay,
        { opacity: 0 },
        {
          opacity: 0.5,
          duration: motionDuration(0.3),
          ease: EASE.cssOut,
          overwrite: true,
        },
      );
    },
    { scope: headerRef, dependencies: [menuOpen] },
  );

  useGSAP(
    () => {
      const border = borderRef.current;
      if (!border) return;
      gsap.to(border, {
        scaleX: drawerVisible ? 1 : 0,
        transformOrigin: "100% 50%",
        duration: motionDuration(0.35),
        ease: BORDER_EASE,
        overwrite: true,
      });
    },
    { scope: headerRef, dependencies: [drawerVisible] },
  );

  useGSAP(
    () => {
      const logo = logoRef.current;
      const back = backRef.current;
      const title = titleRef.current;
      if (!logo || !back || !title) return;
      const slide = { duration: motionDuration(0.3), ease: EASE.qonto };
      const fade = { duration: motionDuration(0.15), ease: "none" };
      if (categoryVisible) {
        gsap.to(logo, {
          ...slide,
          x: LOGO_EXIT_X,
          autoAlpha: 0,
          overwrite: true,
        });
        gsap.fromTo(
          back,
          { x: BACK_ENTER_X, autoAlpha: 0 },
          {
            x: 0,
            autoAlpha: 1,
            duration: motionDuration(0.15),
            delay: motionDuration(0.15),
            ease: EASE.qonto,
            overwrite: true,
          },
        );
        gsap.to(title, {
          ...fade,
          autoAlpha: 1,
          delay: motionDuration(0.15),
          overwrite: true,
        });
        return;
      }
      gsap.to(logo, { ...slide, x: 0, autoAlpha: 1, overwrite: true });
      gsap.to(back, { ...slide, autoAlpha: 0, overwrite: true });
      gsap.to(title, { ...fade, autoAlpha: 0, overwrite: true });
    },
    { scope: headerRef, dependencies: [categoryVisible] },
  );

  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const resetMenus = (): void => {
      setActiveMenu(null);
      setDrawerOpen(false);
      setCategoryOpen(false);
    };
    query.addEventListener("change", resetMenus);
    return () => {
      query.removeEventListener("change", resetMenus);
    };
  }, []);

  useEffect(() => {
    if (!drawerVisible) return;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [drawerVisible]);

  useEffect(() => {
    if (!menuOpen && !drawerVisible) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setActiveMenu(null);
      setDrawerOpen(false);
      setCategoryOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen, drawerVisible]);

  const toggleDrawer = (): void => {
    setDrawerOpen(!drawerVisible);
    setCategoryOpen(false);
  };

  const openCategory = (index: number): void => {
    setCategory(index);
    setCategoryOpen(true);
  };

  const probeOffset = isDesktop ? 80 : 64;

  return (
    <header
      ref={headerRef}
      id="nav-revamp"
      className="fixed inset-x-0 top-0 z-100000"
    >
      <SectionThemeProbe
        key={probeOffset}
        offset={probeOffset}
        onChange={setSectionTheme}
      />
      <nav
        ref={navRef}
        id="navigation"
        aria-label="Main"
        className={cn(
          "relative bg-[rgb(5_5_5/0.7)]",
          !drawerVisible && "backdrop-blur-[6px]",
          dark ? "darkmode text-primary-white" : "text-primary-black",
        )}
      >
        <div className="flex flex-wrap items-center justify-between px-20 lg:px-48">
          <div className="flex grow items-center lg:h-80 lg:flex-1">
            <div className="lg:mr-32 lg:pb-10">
              <a ref={logoRef} href="/en" aria-label="Qonto" className="block">
                <QontoLogo className="block" />
              </a>
            </div>
            <DesktopNav
              activeMenu={activeMenu}
              onActiveMenuChange={setActiveMenu}
            />
          </div>
          <div className="flex h-full items-center lg:gap-x-16">
            <div className="hidden lg:flex">
              <LanguageSwitch variant="desktop" />
            </div>
            <div className="flex items-center lg:gap-x-16">
              <a
                href={SIGN_IN_HREF}
                className="hover:text-grey-600 hidden py-4 text-16 leading-26 lg:block"
              >
                Sign in
              </a>
              <ButtonLink
                href={SIGN_UP_HREF}
                variant="primary"
                className={cn(
                  "mr-20 px-12 py-4 text-12 leading-24 lg:mr-0 lg:px-16 lg:py-12 lg:text-16",
                  drawerVisible && "max-lg:hidden",
                )}
              >
                Open an account
              </ButtonLink>
              <Hamburger
                open={drawerVisible}
                controls={DRAWER_ID}
                onToggle={toggleDrawer}
              />
            </div>
          </div>
          <button
            ref={backRef}
            type="button"
            aria-label="Back to navigation"
            inert={!categoryVisible}
            onClick={() => {
              setCategoryOpen(false);
            }}
            className="invisible absolute top-20 left-20 z-10 flex size-24 cursor-pointer lg:hidden"
          >
            <ArrowIcon width={24} height={24} />
          </button>
          <div
            ref={titleRef}
            className="text-grey-700 pointer-events-none invisible absolute inset-x-0 top-20 text-center text-16 leading-26 lg:hidden"
          >
            {NAV_MENUS[category]?.title}
          </div>
          <MobileDrawer
            id={DRAWER_ID}
            open={drawerVisible}
            category={category}
            categoryOpen={categoryVisible}
            onSelectCategory={openCategory}
          />
        </div>
        <span
          ref={borderRef}
          aria-hidden="true"
          className="bg-grey-400 absolute bottom-0 left-0 h-px w-full [transform:scaleX(0)] lg:hidden"
        />
      </nav>
      <div
        ref={overlayRef}
        aria-hidden="true"
        className="bg-primary-black pointer-events-none fixed top-80 left-0 -z-10 h-screen w-full opacity-0"
      />
    </header>
  );
}
