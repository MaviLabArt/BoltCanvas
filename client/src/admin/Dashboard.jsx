import React from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import api from "../services/api.js";
import AsyncButton from "../components/AsyncButton.jsx";
import { useAdminI18n } from "./i18n.jsx";

export default function Dashboard() {
  const nav = useNavigate();
  const { t } = useAdminI18n();
  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-semibold">
          {t("Pannello di Amministrazione", "Admin Panel")}
        </h1>
        <div className="flex-1" />
        <AsyncButton
          onClick={async ()=>{ await api.post("/admin/logout"); nav("/admin"); }}
          busyText={t("Uscita...", "Logging out...")}
          className="px-3 py-2"
        >
          {t("Esci", "Log out")}
        </AsyncButton>
      </div>
      <div className="flex gap-2 mb-6">
        <Tab to="/admin/dashboard">{t("Prodotti", "Products")}</Tab>
        <Tab to="/admin/dashboard/orders">{t("Ordini", "Orders")}</Tab>
        <Tab to="/admin/dashboard/pricing">{t("Prezzi", "Pricing")}</Tab>
        <Tab to="/admin/dashboard/settings">{t("Impostazioni", "Settings")}</Tab>
        <Tab to="/admin/dashboard/nostr">{t("Nostr", "Nostr")}</Tab>
      </div>
      <Outlet />
    </>
  );
}

function Tab({ to, children }) {
  return (
    <NavLink
      to={to}
      className={({isActive}) => `px-4 py-2 rounded-2xl bg-slate-900 ring-1 ring-white/10 ${isActive?"ring-indigo-400":""}`}
      end
    >
      {children}
    </NavLink>
  );
}
