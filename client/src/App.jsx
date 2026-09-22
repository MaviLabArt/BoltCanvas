import React, { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import Header from "./components/Header.jsx";
import Footer from "./components/Footer.jsx";
import Home from "./pages/Home.jsx";
const ProductDetail = lazy(() => import("./pages/ProductDetail.jsx"));
const Cart = lazy(() => import("./pages/Cart.jsx"));
const Checkout = lazy(() => import("./pages/Checkout.jsx"));
const Paid = lazy(() => import("./pages/Paid.jsx"));
const Orders = lazy(() => import("./pages/Orders.jsx"));
const About = lazy(() => import("./pages/About.jsx"));

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col">
      <Header />
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 pb-16">
        <Suspense fallback={<div role="status" className="py-8 text-white/70">Loading…</div>}>
        <Routes>
          <Route index element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="/product/:id" element={<ProductDetail />} />
          <Route path="/cart" element={<Cart />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/paid/:hash" element={<Paid />} />
        </Routes>
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
