import React, { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./index.css";
import App from "./App.jsx";
import { CartProvider } from "./store/cart.jsx";
import { SettingsProvider } from "./store/settings.jsx";

const AdminApp = React.lazy(() => import("./admin/AdminApp.jsx"));

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <SettingsProvider>
        <CartProvider>
          <Routes>
            <Route path="/*" element={<App />} />
            <Route
              path="/admin/*"
              element={
                <Suspense fallback={<div className="p-6 text-center text-white/70">Caricamento...</div>}>
                  <AdminApp />
                </Suspense>
              }
            />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </CartProvider>
      </SettingsProvider>
    </BrowserRouter>
  </React.StrictMode>
);
