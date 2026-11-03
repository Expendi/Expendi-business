import type { ComponentType, SVGProps } from "react";

import type { AssetId } from "~/lib/assets";

export type SectionTheme = "dark" | "light";

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export interface NavItem {
  label: string;
  href: string;
  icon?: IconComponent;
}

export interface NavGroup {
  category: string;
  items: readonly NavItem[];
}

export interface NavHighlight {
  title: string;
  description: string;
  href: string;
  image: AssetId;
}

export interface NavMenu {
  title: string;
  /** Each column is a stack of category groups (`ul.lg:w-273`). */
  columns: readonly (readonly NavGroup[])[];
  highlight?: NavHighlight;
}

export interface Country {
  label: string;
  href: string;
  flag: IconComponent;
}

export interface FooterLink {
  label: string;
  href: string;
}

export interface FooterColumn {
  title: string;
  links: readonly FooterLink[];
}

export interface ImageLink {
  label: string;
  href: string;
  image: AssetId;
}
