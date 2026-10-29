import React, { useEffect } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import Login from "./Login.jsx";
import Dashboard from "./Dashboard.jsx";
import Products from "./Products.jsx";
import Orders from "./Orders.jsx";
import Settings from "./Settings.jsx";
import BulkPricing from "./BulkPricing.jsx";
import { AdminI18nProvider } from "./i18n.jsx";
import { useAdmin } from "../store/useAdmin.js";

export default function AdminApp() {
  const { me } = useAdmin();
  const nav = useNavigate();

  // Isola il tema Admin dal tema pubblico durante la navigazione SPA.
  useEffect(() => {
    const root = document.documentElement;
    const previousTheme = root.getAttribute("data-theme");

    root.setAttribute("data-theme", "dark");

    return () => {
      if (previousTheme === null) {
        root.removeAttribute("data-theme");
      } else {
        root.setAttribute("data-theme", previousTheme);
      }
    };
  }, []);

  useEffect(() => {
    me()
      .then((ok) => {
        if (!ok) nav("/admin");
      })
      .catch(() => nav("/admin"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AdminI18nProvider>
      <div
        className="admin-shell"
        data-admin-theme="dark"
      >
        <div className="admin-frame">
          <Routes>
            <Route index element={<Login />} />
            <Route path="dashboard" element={<Dashboard />}>
              <Route index element={<Products />} />
              <Route path="orders" element={<Orders />} />
              <Route path="pricing" element={<BulkPricing />} />
              <Route path="settings" element={<Settings />} />
            </Route>
            <Route path="*" element={<div>Not Found</div>} />
          </Routes>
        </div>
      </div>
    </AdminI18nProvider>
  );
}
