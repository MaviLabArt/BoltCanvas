import React from "react";
import AccountManager from "./AccountManager.jsx";

export default function LoginDialog({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4" onClick={onClose}>
      <div
        className="relative w-full max-w-md bg-slate-900 text-white rounded-2xl shadow-2xl ring-1 ring-white/10 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-3 top-3 h-8 w-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-sm"
          aria-label="Close"
        >
          ✕
        </button>
        <AccountManager onClose={onClose} />
      </div>
    </div>
  );
}
