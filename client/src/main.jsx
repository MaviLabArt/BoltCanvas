import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./index.css";
import "./admin/admin.css";
import App from "./App.jsx";
import { CartProvider } from "./store/cart.jsx";
import { SettingsProvider } from "./store/settings.jsx";
import { NostrProvider } from "./providers/NostrProvider.jsx";

import AdminApp from "./admin/AdminApp.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <NostrProvider>
        <SettingsProvider>
          <CartProvider>
            <Routes>
              <Route path="/*" element={<App />} />
              <Route
                path="/admin/*"
                element={<AdminApp />}
              />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </CartProvider>
        </SettingsProvider>
      </NostrProvider>
    </BrowserRouter>
  </React.StrictMode>
);
