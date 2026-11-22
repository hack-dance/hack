"use client";

import { useEffect, useRef, useState } from "react";

const COPIED_FOR_MS = 1400;

/** Copies `text` to the clipboard and says so for a moment. */
export function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  return (
    <button
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {
          // Clipboard access can be refused; the command stays selectable.
        });
        setCopied(true);
        if (timer.current) {
          clearTimeout(timer.current);
        }
        timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS);
      }}
      type="button"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
