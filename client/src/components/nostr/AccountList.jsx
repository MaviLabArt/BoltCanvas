import React from "react";
import { useNostr } from "../../providers/NostrProvider.jsx";
import { nip19 } from "nostr-tools";

function displayKey(pubkey, shortKey) {
  try {
    const npub = nip19.npubEncode(pubkey);
    return `${npub.slice(0, 10)}…${npub.slice(-6)}`;
  } catch {
    return shortKey(pubkey);
  }
}

export default function AccountList() {
  const { accounts, account, switchAccount, removeAccount, shortKey } = useNostr();
  if (!accounts?.length) return null;

  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold text-white/70">Saved accounts</div>
      <div className="space-y-2">
        {accounts.map((acc) => {
          const active = account?.pubkey === acc.pubkey;
          return (
            <div
              key={`${acc.pubkey}-${acc.signerType}`}
              className={`flex items-center justify-between px-3 py-2 rounded-lg ring-1 ring-white/10 ${
                active ? "bg-indigo-500/20 ring-indigo-400/40" : "bg-slate-800"
              }`}
            >
              <div>
                <div className="text-sm font-semibold">{displayKey(acc.pubkey, shortKey)}</div>
                <div className="text-xs text-white/60 uppercase tracking-wide">{acc.signerType}</div>
              </div>
              <div className="flex items-center gap-2">
                {!active && (
                  <button
                    onClick={() => switchAccount(acc).catch((err) => alert(err?.message || "Switch failed"))}
                    className="text-xs px-2 py-1 rounded-md bg-indigo-500/80 hover:bg-indigo-500"
                  >
                    Switch
                  </button>
                )}
                <button
                  onClick={() => removeAccount(acc)}
                  className="text-xs px-2 py-1 rounded-md bg-slate-700 hover:bg-slate-600"
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
