"use client";

import type { JSX } from "react";
import { SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { NavItem } from "~/config/navigation";
import { Button } from "~/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "~/components/ui/command";
import { Kbd } from "~/components/ui/kbd";

function subscribeToNothing(): () => void {
  return () => undefined;
}

/** Whether to show ⌘ or Ctrl; the server renders Ctrl until the browser says. */
function useIsApple(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => false,
  );
}

/** The command palette over the dashboard's pages, opened with ⌘K or Ctrl+K. */
export function SearchDialog({
  items,
}: {
  items: readonly NavItem[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const apple = useIsApple();
  const groups = [...new Set(items.map((item) => item.group))];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-keyshortcuts={apple ? "Meta+K" : "Control+K"}
        className="h-8 gap-2 px-2.5 font-normal text-muted-foreground max-sm:size-8 max-sm:px-0 sm:w-56 sm:justify-start"
      >
        <SearchIcon aria-hidden="true" />
        <span className="max-sm:sr-only">Search pages</span>
        <Kbd className="ml-auto max-sm:hidden">{apple ? "⌘K" : "Ctrl K"}</Kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search pages"
        description="Go to a page of the dashboard"
      >
        <Command>
          <CommandInput placeholder="Search pages…" />
          <CommandList>
            <CommandEmpty>No page matches.</CommandEmpty>
            {groups.map((group, index) => (
              <div key={group}>
                {index > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={group}>
                  {items
                    .filter((item) => item.group === group)
                    .map((item) => (
                      <CommandItem
                        key={item.href}
                        value={`${group} ${item.title}`}
                        onSelect={() => {
                          setOpen(false);
                          router.push(item.href);
                        }}
                      >
                        <item.icon aria-hidden="true" />
                        {item.title}
                      </CommandItem>
                    ))}
                </CommandGroup>
              </div>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
