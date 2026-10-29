import React from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import api from "../services/api.js";
import AsyncButton from "../components/AsyncButton.jsx";
import { useAdminI18n } from "./i18n.jsx";
import { useSettings } from "../store/settings.jsx";

export default function Dashboard() {
  const nav = useNavigate();
  const { t } = useAdminI18n();
  const { settings } = useSettings();
  const storeName =
    settings?.storeName?.trim() || t("Il tuo negozio", "Your shop");

  return (
    <div className="admin-dashboard">
      <header className="admin-header">
        <div className="admin-brand">
          <div className="admin-store-name">{storeName}</div>
          <h1 className="admin-heading">
            {t("Pannello di Amministrazione", "Admin Panel")}
          </h1>
        </div>

        <div className="admin-header-actions">
          <Link
            className="admin-home-link"
            to="/"
            title={t("Torna al negozio", "Return to shop")}
            aria-label={t("Torna al negozio", "Return to shop")}
          >
            <svg
              viewBox="0 0 24 24"
              width="19"
              height="19"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m3 10 9-7 9 7" />
              <path d="M5 9v12h14V9" />
              <path d="M9 21v-7h6v7" />
            </svg>
            <span>{t("Negozio", "Store")}</span>
          </Link>

          <AsyncButton
            onClick={async () => {
              await api.post("/admin/logout");
              nav("/admin");
            }}
            busyText={t("Uscita...", "Logging out...")}
            className="admin-logout-button"
          >
            {t("Esci", "Log out")}
          </AsyncButton>
        </div>
      </header>

      <div className="admin-workspace">
        <nav
          className="admin-nav"
          aria-label={t("Navigazione amministrazione", "Admin navigation")}
        >
          <div className="admin-nav-label">
            {t("GESTIONE NEGOZIO", "STORE MANAGEMENT")}
          </div>

          <Tab to="/admin/dashboard" end>
            {t("Prodotti", "Products")}
          </Tab>
          <Tab to="/admin/dashboard/orders">
            {t("Ordini", "Orders")}
          </Tab>
          <Tab to="/admin/dashboard/pricing">
            {t("Prezzi", "Pricing")}
          </Tab>
          <Tab to="/admin/dashboard/settings">
            {t("Impostazioni", "Settings")}
          </Tab>
        </nav>

        <main className="admin-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Tab({ to, end = false, children }) {
  return (
    <NavLink to={to} end={end} className="admin-tab">
      {children}
    </NavLink>
  );
}
