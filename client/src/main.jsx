import React, { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./index.css";
import "./admin/admin.css";
import App from "./App.jsx";
import { CartProvider } from "./store/cart.jsx";
import { SettingsProvider } from "./store/settings.jsx";
import { NostrProvider } from "./providers/NostrProvider.jsx";

const AdminApp = React.lazy(() => import("./admin/AdminApp.jsx"));

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
                element={
                  <Suspense
                    fallback={
                      <div className="flex min-h-screen items-center justify-center bg-[#171614]">
                        <span
                          role="status"
                          aria-label="Loading"
                          className="h-8 w-8 animate-spin rounded-full border-2 border-[#a98a52]/30 border-t-[#a98a52]"
                        />
                      </div>
                    }
                  >
                    <AdminApp />
                  </Suspense>
                }
              />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </CartProvider>
        </SettingsProvider>
      </NostrProvider>
    </BrowserRouter>
  </React.StrictMode>
);
