"use client";

import { useEffect, useState } from "react";
import {
  RiCheckboxCircleLine,
  RiInformationLine,
  RiErrorWarningLine,
  RiCloseCircleLine,
  RiLoaderLine,
} from "@remixicon/react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { cn } from "@/lib/utils";

/**
 * Nie używamy `useTheme()` z next-themes — w projekcie nie ma `<ThemeProvider>`.
 * Bez tego przy pełnym reloadzie (hydratacja) można dostać niespójny subtree.
 *
 * SSR + pierwsza klatka: `null`. Po montażu: motyw ze `class` na `<html>`.
 */
export function Toaster(props: ToasterProps) {
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const read = () =>
      setTheme(
        document.documentElement.classList.contains("dark") ? "dark" : "light"
      );
    queueMicrotask(() => {
      read();
      setMounted(true);
    });
    const mo = new MutationObserver(() => {
      queueMicrotask(read);
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => mo.disconnect();
  }, []);

  if (!mounted) {
    return null;
  }

  return (
    <Sonner
      {...props}
      theme={theme}
      className="toaster group"
      icons={{
        success: <RiCheckboxCircleLine className="size-4" />,
        info: <RiInformationLine className="size-4" />,
        warning: <RiErrorWarningLine className="size-4" />,
        error: <RiCloseCircleLine className="size-4" />,
        loading: <RiLoaderLine className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        ...props.toastOptions,
        classNames: {
          ...props.toastOptions?.classNames,
          toast: cn("cn-toast", props.toastOptions?.classNames?.toast),
          title: props.toastOptions?.classNames?.title,
          description: props.toastOptions?.classNames?.description,
        },
      }}
    />
  );
}
