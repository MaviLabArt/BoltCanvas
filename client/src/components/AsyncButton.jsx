import React, { useState } from "react";
import { motion } from "framer-motion";

/**
 * AsyncButton
 * - Drop-in async button with a subtle grey-purple loading state.
 * - While loading: original label stays in place but fades out (keeps width),
 *   and only three dots animate left↔right in the center (no text).
 *
 * Props:
 *  - onClick: async function to run on click (loading is tied to its promise)
 *  - children: label when idle
 *  - className: extra classes to append
 *  - disabled: disable the button entirely
 *  - loading: optional controlled mode (if you already manage loading state)
 *  - busyText: kept for a11y/ARIA (no longer displayed visually in loading)
 *  - showDots: show the animated dots (default true)
 */
export default function AsyncButton({
  onClick,
  children,
  className = "",
  disabled,
  loading: controlledLoading,
  busyText = "Loading…",
  showDots = true,
  ...rest
}) {
  const [localLoading, setLocalLoading] = useState(false);
  const isControlled = controlledLoading !== undefined;
  const loading = isControlled ? controlledLoading : localLoading;

  async function handleClick(e) {
    if (disabled || loading) return;
    try {
      if (!isControlled) setLocalLoading(true);
      await onClick?.(e);
    } finally {
      if (!isControlled) setLocalLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || loading}
      aria-busy={loading}
      aria-live="polite"
      aria-label={loading ? busyText : undefined}
      className={[
        "relative inline-flex items-center justify-center gap-2 px-4 py-3 rounded-2xl ring-1 ring-white/10",
        "focus-visible:ring-2 focus-visible:ring-indigo-400 text-white",
        loading ? "btn-loading" : "bg-indigo-500/90 hover:bg-indigo-500",
        (disabled || loading) ? "cursor-not-allowed opacity-90" : "",
        className
      ].join(" ")}
      {...rest}
    >
      {/* Keep label width to prevent layout shift; fade out while loading */}
      <span className={loading ? "opacity-0" : "opacity-100 transition-opacity"}>
        {children}
      </span>

      {/* Loading overlay: ONLY dots (no text) */}
      {loading && showDots && (
        <span className="absolute inset-0 flex items-center justify-center">
          <LoadingDots />
        </span>
      )}
    </button>
  );
}

export function LoadingDots() {
  const arr = [0, 1, 2];
  return (
    <span className="inline-flex items-center ml-1" aria-hidden="true">
      {arr.map((i) => (
        <motion.span
          key={i}
          initial={{ x: -6, opacity: 0.7 }}
          animate={{ x: [-6, 6, -6], opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 0.8, repeat: Infinity, ease: "easeInOut", delay: i * 0.12 }}
          className="mx-0.5 h-1.5 w-1.5 rounded-full bg-white"
        />
      ))}
    </span>
  );
}
