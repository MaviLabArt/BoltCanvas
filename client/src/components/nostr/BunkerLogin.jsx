import React, { useState } from "react";
import { useNostr } from "../../providers/NostrProvider.jsx";

export default function BunkerLogin({ onBack, onClose }) {
  const { bunkerLogin } = useNostr();
  const [bunker, setBunker] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await bunkerLogin(bunker.trim());
      onClose?.();
    } catch (err) {
      setError(err?.message || "Bunker login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm font-semibold text-white/80">
        Bunker or Nostr Connect URI
        <input
          value={bunker}
          onChange={(e) => setBunker(e.target.value)}
          className="mt-2 w-full px-3 py-2 rounded-lg bg-slate-800 border border-white/10 focus:border-indigo-400 outline-none"
          placeholder="bunker://..."
          required
        />
      </label>
      {error && <div className="text-sm text-rose-300">{error}</div>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="flex-1 px-4 py-3 rounded-xl bg-indigo-500 hover:bg-indigo-600 disabled:opacity-60 text-sm font-semibold"
        >
          {busy ? "Connecting..." : "Connect"}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-semibold ring-1 ring-white/10"
        >
          Back
        </button>
      </div>
      <p className="text-xs text-white/50">
        You will be asked to approve this client from your signer app.
      </p>
    </form>
  );
}
