import React, { useEffect, useMemo, useState } from "react";
import { useNostr } from "../../providers/NostrProvider.jsx";
import PrivateKeyLogin from "./PrivateKeyLogin.jsx";
import BunkerLogin from "./BunkerLogin.jsx";
import NostrConnectLogin from "./NostrConnectLogin.jsx";

const VIEW = {
  HOME: "home",
  NSEC: "nsec",
  NOSTR_CONNECT: "nostr-connect",
  NPUB: "npub"
};

export default function AccountManager({ onClose }) {
  const [view, setView] = useState(VIEW.HOME);
  const { nip07Login, pubkey, hasSigner } = useNostr();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // If already connected with a signer, stop any pending spinner and close.
  useEffect(() => {
    if (hasSigner && pubkey) {
      setBusy(false);
      setError("");
      onClose?.();
    }
  }, [pubkey, hasSigner, onClose]);

  const title = useMemo(() => {
    if (view === VIEW.NSEC) return "Login with Private Key";
    if (view === VIEW.NOSTR_CONNECT) return "Login with Bunker / Nostr Connect";
    if (view === VIEW.NPUB) return "Login with Public Key (read-only)";
    return "Add a Nostr account";
  }, [view]);

  const handleNip07Login = async () => {
    setError("");
    setBusy(true);
    try {
      await nip07Login();
      onClose?.();
    } catch (err) {
      setError(err?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="text-sm text-white/60 mt-1">
          Connect a signer to keep carts and orders tied to your Nostr identity.
        </p>
      </div>

      {view === VIEW.HOME && (
        <div className="space-y-3">
          <button
            onClick={handleNip07Login}
            disabled={busy}
            className="w-full px-4 py-3 rounded-xl bg-indigo-500 hover:bg-indigo-600 transition text-sm font-semibold disabled:opacity-60"
          >
            {busy ? "Connecting..." : "Login with Browser Extension"}
          </button>
          <button
            onClick={() => setView(VIEW.NOSTR_CONNECT)}
            className="w-full px-4 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 transition text-sm font-semibold ring-1 ring-white/10"
          >
            Login with Bunker / Nostr Connect
          </button>
          <button
            onClick={() => setView(VIEW.NSEC)}
            className="w-full px-4 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 transition text-sm font-semibold ring-1 ring-white/10"
          >
            Login with Private Key
          </button>
        </div>
      )}

      {error && <div className="text-sm text-rose-300">{error}</div>}

      {view === VIEW.NSEC && <PrivateKeyLogin onBack={() => setView(VIEW.HOME)} onClose={onClose} />}
      {view === VIEW.NOSTR_CONNECT && (
        <NostrConnectLogin onBack={() => setView(VIEW.HOME)} onClose={onClose} />
      )}
      {view === VIEW.NPUB && null}
    </div>
  );
}
