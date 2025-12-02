import React, { useState } from "react";
import { useNostr } from "../../providers/NostrProvider.jsx";

export default function PrivateKeyLogin({ onBack, onClose }) {
  const { nsecLogin } = useNostr();
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const isNcrypt = key.trim().startsWith("ncryptsec");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await nsecLogin(key.trim(), password);
      onClose?.();
    } catch (err) {
      setError(err?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm font-semibold text-white/80">
        Private key (nsec or ncryptsec)
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="mt-2 w-full px-3 py-2 rounded-lg bg-slate-800 border border-white/10 focus:border-indigo-400 outline-hidden"
          placeholder="nsec1..."
          required
        />
      </label>
      {isNcrypt && (
        <label className="block text-sm font-semibold text-white/80">
          Password (for ncryptsec)
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-2 w-full px-3 py-2 rounded-lg bg-slate-800 border border-white/10 focus:border-indigo-400 outline-hidden"
            placeholder="Your password"
            required
          />
        </label>
      )}
      {error && <div className="text-sm text-rose-300">{error}</div>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="flex-1 px-4 py-3 rounded-xl bg-indigo-500 hover:bg-indigo-600 disabled:opacity-60 text-sm font-semibold"
        >
          {busy ? "Signing in..." : "Sign in"}
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
        Tip: prefer browser extensions or bunker signers. Saving a raw private key is less secure.
      </p>
    </form>
  );
}
