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

  useEffect(() => {
    me()
      .then((ok) => {
        // If someone hits /admin/dashboard directly and isn't logged in, send them to /admin (login)
        if (!ok) nav("/admin");
      })
      .catch(() => nav("/admin"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AdminI18nProvider>
      <div className="min-h-screen bg-slate-950 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
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
