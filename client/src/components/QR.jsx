import React from "react";
import QRCode from "react-qr-code";

/**
 * QR
 * - Renders a BOLT11 invoice QR
 * - If `asLink` is true, wraps it in <a href="lightning:..."> so mobile wallets can open directly.
 *
 * Props:
 *  - value: string (required)
 *  - size: number (default 220)
 *  - asLink: boolean (default false)
 *  - href: optional override for link (defaults to `lightning:${value}`)
 *  - className: optional classes for the outer wrapper (div or a)
 *  - ariaLabel: accessible label for the link (when asLink)
 */
export default function QR({
  value,
  size = 220,
  asLink = false,
  href,
  className = "",
  ariaLabel = "Open invoice in your Lightning wallet",
}) {
  if (!value) return null;

  const inner = (
    <div className="p-4 rounded-2xl bg-white inline-block">
      <QRCode value={value} size={size} />
    </div>
  );

  if (asLink) {
    const link = href || `lightning:${value}`;
    return (
      <a
        href={link}
        aria-label={ariaLabel}
        className={className}
      >
        {inner}
      </a>
    );
  }

  return <div className={className}>{inner}</div>;
}
