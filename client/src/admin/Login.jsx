import React, { useState } from "react";
import api from "../services/api.js";
import { useNavigate } from "react-router-dom";
import AsyncButton from "../components/AsyncButton.jsx";
import { useAdminI18n } from "./i18n.jsx";

export default function Login() {
  const [pin, setPin] = useState("");
  const nav = useNavigate();
  const { t } = useAdminI18n();

  async function submit() {
    try {
      await api.post("/admin/login", { pin });
      nav("/admin/dashboard");
    } catch (e) {
      alert(t("PIN non valido", "Invalid PIN"));
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-16 rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10">
      <div className="text-lg font-semibold mb-2">
        {t("Accesso Amministratore", "Admin Login")}
      </div>
      <input
        type="password" inputMode="numeric"
        value={pin} onChange={e=>setPin(e.target.value)}
        placeholder={t("PIN", "PIN")}
        className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
        onKeyDown={e=>e.key==="Enter" && submit()}
      />
      <AsyncButton className="mt-4" onClick={submit} busyText={t("Verifico PIN...", "Checking PIN...")}>
        {t("Accedi", "Sign in")}
      </AsyncButton>
    </div>
  );
}
