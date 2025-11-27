import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api.js";
import QR from "../components/QR.jsx";
import { renderMarkdown } from "../utils/markdown.js";

export default function About() {
  const [s, setS] = useState({
    aboutTitle: "About Us",
    aboutBody: "Use this space to introduce who you are, what you create, and how you work. Update it with your story and what customers can expect.",
    aboutImage: "",
    contactNote: "",
    // NEW (for zaps / identity)
    lightningAddress: "",
    nostrNpub: "",
    nostrNip05: ""
  });

  // Zap modal state
  const [zapOpen, setZapOpen] = useState(false);
  const [zapSats, setZapSats] = useState(1000);
  const [zapNote, setZapNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [zapInvoice, setZapInvoice] = useState(null);
  const [zapError, setZapError] = useState("");
  const [copied, setCopied] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    api.get("/public-settings").then(r => setS(prev => ({ ...prev, ...r.data }))).catch(()=>{});
  }, []);

  function lightningHrefFromAddress(addr) {
    const a = String(addr || "").trim();
    if (!a) return "";
    // Many wallets accept "lightning:you@domain.tld"
    return `lightning:${a}`;
  }

  async function openZap() {
    setZapOpen(true);
    setZapInvoice(null);
    setZapError("");
    setCopied(false);
  }

  async function createZapInvoice() {
    const sats = Math.max(1, Math.floor(Number(zapSats || 0)));
    if (!Number.isFinite(sats) || sats <= 0) {
      setZapError("Amount must be at least 1 sat.");
      return;
    }

    try {
      setCreating(true);
      setZapInvoice(null);
      setZapError("");
      setCopied(false);

      const { data } = await api.post("/zaps/create-invoice", {
        amount: sats,
        note: zapNote || ""
      });

      const noteForInvoice = String(zapNote || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      const satoshis = data?.satoshis ?? sats;
      setZapInvoice(data ? { ...data, note: noteForInvoice, satoshis } : null);
    } catch (err) {
      const msg = err?.response?.data?.error || "Failed to create zap invoice";
      setZapError(msg);
    } finally {
      setCreating(false);
    }
  }

  async function copyInvoice() {
    if (!zapInvoice?.paymentRequest) return;
    try {
      await navigator.clipboard.writeText(zapInvoice.paymentRequest);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setZapError("Unable to copy invoice. Please copy it manually.");
    }
  }

  const hasInvoice = !!zapInvoice?.paymentRequest;
  const invoiceAmount = hasInvoice
    ? Number(zapInvoice?.satoshis || zapSats || 0)
    : Number(zapSats || 0);
  const invoiceNote = hasInvoice ? zapInvoice?.note : "";

  return (
    <section className="pt-8">
      <div className="mb-4">
        <button
          className="px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10"
          onClick={() => nav(-1)}
        >
          ← Back
        </button>
      </div>
      <div className="max-w-3xl mx-auto rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10">
        <div className="flex items-start gap-5">
          {s.aboutImage ? (
            <img
              src={s.aboutImage}
              alt="Portrait"
              className="w-28 h-28 rounded-2xl object-cover ring-1 ring-white/10"
            />
          ) : null}
          <div>
            <h1 className="heading text-2xl sm:text-3xl font-semibold">
              {s.aboutTitle || "About Us"}
            </h1>
            {s.contactNote ? (
              <div className="mt-1 text-sm text-white/60">{s.contactNote}</div>
            ) : null}

            {/* Nostr identity (optional) */}
            {(s.nostrNpub || s.nostrNip05) && (
              <div className="mt-2 text-sm text-white/60">
                {s.nostrNip05 ? <div>NIP-05: {s.nostrNip05}</div> : null}
                {s.nostrNpub ? <div>npub: <span className="break-all">{s.nostrNpub}</span></div> : null}
              </div>
            )}
          </div>
        </div>
        {s.aboutBody && (
          <div
            className="mt-5 text-white/80 space-y-4 leading-relaxed markdown-content"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(s.aboutBody) }}
          />
        )}

        {/* --- Lightning Zaps --- */}
        {s.lightningAddress ? (
          <div className="mt-6 rounded-2xl p-4 bg-slate-950 ring-1 ring-white/10">
            <div className="flex items-center gap-3">
              <div className="text-lg font-semibold">Send a Zap ⚡</div>
            </div>
            <div className="mt-2 text-white/80">
              Lightning Address: <span className="font-semibold">{s.lightningAddress}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={openZap}
                className="px-3 py-2 rounded-2xl bg-indigo-500/90 hover:bg-indigo-500 ring-1 ring-white/10"
              >
                Zap now
              </button>
              {/* Basic deep link for wallets that support lightning:you@domain */}
              <a
                href={lightningHrefFromAddress(s.lightningAddress)}
                className="px-3 py-2 rounded-2xl bg-slate-800 ring-1 ring-white/10"
              >
                Open in wallet
              </a>
            </div>

            {/* Optional: QR as a convenience (just the lightning address) */}
            <div className="mt-4">
              <QR value={s.lightningAddress} size={180} className="inline-block" />
            </div>
          </div>
        ) : null}
      </div>

      {/* Zap modal */}
      {zapOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 py-6">
          <div className="absolute inset-0 bg-black/70" onClick={()=>setZapOpen(false)} />
          <div className="relative w-full max-w-lg sm:max-w-md rounded-t-3xl sm:rounded-3xl bg-slate-900 ring-1 ring-white/10 overflow-hidden">
            <div className="absolute right-4 top-4 sm:hidden">
              <button
                type="button"
                className="px-2 py-1 rounded-full bg-white/10 text-xs text-white/70"
                onClick={()=>setZapOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="max-h-[85vh] overflow-y-auto p-6 sm:p-6">
              <div className="text-lg font-semibold">Send a Zap ⚡</div>
              {!hasInvoice ? (
                <>
                  <div className="mt-2 text-white/70">
                    Choose amount and optionally include a note. We’ll generate a Lightning invoice for you.
                  </div>
                  <div className="mt-4 grid gap-3">
                    <label className="text-sm text-white/70">Amount (sats)</label>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
                      value={zapSats}
                      onChange={(e) => setZapSats(e.target.value)}
                    />
                    <label className="text-sm text-white/70">Note (optional)</label>
                    <textarea
                      rows={3}
                      className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
                      value={zapNote}
                      onChange={(e) => setZapNote(e.target.value)}
                      placeholder="Say thanks or include your npub"
                    />
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      className="w-full sm:w-auto px-3 py-2 rounded-2xl bg-slate-800 ring-1 ring-white/10"
                      onClick={() => setZapOpen(false)}
                    >
                      Close
                    </button>
                    <button
                      className="w-full sm:w-auto px-3 py-2 rounded-2xl bg-indigo-500/90 hover:bg-indigo-500"
                      onClick={createZapInvoice}
                      disabled={creating}
                      title="Create Lightning invoice"
                    >
                      {creating ? "Creating…" : "Create invoice"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-2 text-white/70">
                    Invoice ready. Scan or open it in your wallet to complete the zap.
                  </div>
                  <div className="mt-4 rounded-2xl bg-slate-950 ring-1 ring-white/10 p-4 space-y-2">
                    <div className="flex items-center justify-between text-sm text-white/60">
                      <span>Amount</span>
                      <span className="font-semibold text-white/80">
                        {invoiceAmount.toLocaleString("en-US")} sats
                      </span>
                    </div>
                    {invoiceNote && (
                      <div className="text-xs text-white/50">
                        Note: <span className="text-white/80 break-words">{invoiceNote}</span>
                      </div>
                    )}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <a
                      className="w-full sm:w-auto px-3 py-2 rounded-2xl bg-green-600/80 hover:bg-green-600 text-center"
                      href={`lightning:${zapInvoice.paymentRequest}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in wallet
                    </a>
                    <button
                      className="w-full sm:w-auto px-3 py-2 rounded-2xl bg-slate-800 ring-1 ring-white/10"
                      onClick={copyInvoice}
                    >
                      {copied ? "Copied!" : "Copy invoice"}
                    </button>
                    <button
                      className="w-full sm:w-auto px-3 py-2 rounded-2xl bg-slate-800 ring-1 ring-white/10"
                      onClick={() => {
                        setZapInvoice(null);
                        setZapError("");
                        setCopied(false);
                      }}
                    >
                      Create another
                    </button>
                    <button
                      className="w-full sm:w-auto px-3 py-2 rounded-2xl bg-slate-800 ring-1 ring-white/10"
                      onClick={() => setZapOpen(false)}
                    >
                      Close
                    </button>
                  </div>
                  <div className="mt-5 flex flex-col items-center gap-3">
                    <QR
                      value={zapInvoice.paymentRequest}
                      asLink
                      size={220}
                      className="rounded-2xl"
                    />
                    <div className="text-xs text-white/60 break-all text-center px-2">
                      {zapInvoice.paymentRequest}
                    </div>
                  </div>
                </>
              )}
              {zapError && (
                <div className="mt-3 text-sm text-rose-400">
                  {zapError}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
