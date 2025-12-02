import React, { useEffect, useMemo, useState } from "react";
import QRCode from "react-qr-code";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { createNostrConnectURI } from "nostr-tools/nip46";
import { useNostr } from "../../providers/NostrProvider.jsx";

const DEFAULT_NOSTRCONNECT_RELAYS = [
  "wss://relay.nsec.app/",
  "wss://bucket.coracle.social/",
  "wss://relay.primal.net/",
  "wss://relay.damus.io/"
];

export default function NostrConnectLogin({ onBack, onClose }) {
  const { nostrConnectionLogin } = useNostr();
  const [error, setError] = useState("");
  const [status, setStatus] = useState("waiting");
  const [clientSecretKey] = useState(() => generateSecretKey());
  const [customUri, setCustomUri] = useState("");

  const connectionString = useMemo(() => {
    return createNostrConnectURI({
      clientPubkey: getPublicKey(clientSecretKey),
      relays: DEFAULT_NOSTRCONNECT_RELAYS,
      secret: Math.random().toString(36).slice(2),
      name: window.location.host,
      url: window.location.origin
    });
  }, [clientSecretKey]);

  useEffect(() => {
    let cancelled = false;
    const uriToUse = customUri.trim() || connectionString;
    if (!uriToUse) return;
    setStatus("connecting");
    setError("");
    nostrConnectionLogin(clientSecretKey, uriToUse)
      .then(() => {
        if (cancelled) return;
        setStatus("connected");
        onClose?.();
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus("failed");
        setError(err?.message || "Approve the request in your signer.");
      });
    return () => {
      cancelled = true;
    };
  }, [clientSecretKey, connectionString, customUri, nostrConnectionLogin, onClose]);

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus((prev) => (prev === "connected" ? prev : "copied"));
      setTimeout(() => setStatus("waiting"), 1200);
    } catch {
      setError("Copy failed");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3 rounded-2xl bg-slate-900 ring-1 ring-white/10 p-4">
        <div className="p-4 rounded-2xl bg-white shadow-lg ring-1 ring-black/5">
          <QRCode value={connectionString} size={360} bgColor="#ffffff" fgColor="#000000" level="M" />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => copyToClipboard(connectionString)}
            className="text-xs px-3 py-2 rounded-lg bg-slate-800 ring-1 ring-white/10 hover:bg-slate-700"
          >
            Copy link
          </button>
          <a
            href={connectionString}
            className="text-xs px-3 py-2 rounded-lg bg-slate-800 ring-1 ring-white/10 hover:bg-slate-700"
            aria-label="Open with Nostr signer"
          >
            Open
          </a>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-white/60">
          Or paste bunker URI
          <input
            value={customUri}
            onChange={(e) => setCustomUri(e.target.value)}
            className="mt-2 w-full px-3 py-2 rounded-lg bg-slate-800 border border-white/10 focus:border-indigo-400 outline-hidden text-sm"
            placeholder="bunker://..."
          />
        </label>
      </div>

      {error && <div className="text-xs text-rose-300 text-center">{error}</div>}
      <div className="text-xs text-white/60 text-center">
        {status === "connecting"
          ? "Waiting for approval…"
          : status === "connected"
            ? "Connected"
            : status === "failed"
              ? "Failed – check your signer"
              : status === "copied"
                ? "Link copied"
                : "Ready"}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 px-4 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-semibold ring-1 ring-white/10"
        >
          Back
        </button>
      </div>
    </div>
  );
}
