import React, { createContext, useContext, useMemo, useState, useEffect, useRef } from "react";
import api from "../services/api.js";

const Ctx = createContext(null);

const STORAGE_KEY = "cart_v1";
const CART_VERSION = 4;
const SHIPPING_KEYS = [
  "shippingItalySats",
  "shippingEuropeSats",
  "shippingWorldSats"
];
const MAX_CART_ITEMS = 24;

function readStoredItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safePersist(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    return true;
  } catch (err) {
    console.warn("[cart] Failed to persist cart:", err?.message || err);
    return false;
  }
}

function selectPreviewImage(product) {
  if (!product) return "";
  const idx = Number.isInteger(product.mainImageIndex) ? product.mainImageIndex : 0;
  const pickFromArray = (arr) =>
    Array.isArray(arr) && arr.length
      ? arr[Math.min(Math.max(0, idx), Math.max(0, arr.length - 1))] || arr[0]
      : "";
  return (
    product.previewImage ||
    product.mainImageThumbAbsoluteUrl ||
    product.mainImageThumbUrl ||
    pickFromArray(product.thumbUrls) ||
    product.mainImageAbsoluteUrl ||
    product.mainImageUrl ||
    pickFromArray(product.imageUrls) ||
    pickFromArray(product.images) ||
    ""
  );
}

function sanitizeZoneOverrides(source) {
  const list = Array.isArray(source) ? source : [];
  const seen = new Set();
  const result = [];
  for (const entry of list) {
    const id = String(entry?.id || "").trim();
    if (!id || seen.has(id)) continue;
    const price = Math.max(0, Number(entry?.priceSats || 0));
    result.push({ id, priceSats: price });
    seen.add(id);
  }
  return result;
}

function snapshotProduct(product, { needsShippingHydrate = false } = {}) {
  if (!product || !product.id) return null;

  const missingShipping = SHIPPING_KEYS.some(
    (key) => product[key] === undefined || product[key] === null
  );

  const numbers = SHIPPING_KEYS.reduce((acc, key) => {
    const raw = product[key];
    const num = Number(raw);
    acc[key] = Number.isFinite(num) ? num : 0;
    return acc;
  }, {});
  const zoneOverrides = sanitizeZoneOverrides(product?.shippingZoneOverrides);

  const out = {
    id: product.id,
    title: product.title || "Artwork",
    priceSats: Number(product.priceSats || 0),
    available: !!product.available,
    mainImageIndex: Number.isInteger(product.mainImageIndex) ? product.mainImageIndex : 0,
    mainImageThumbAbsoluteUrl: product.mainImageThumbAbsoluteUrl || "",
    mainImageAbsoluteUrl: product.mainImageAbsoluteUrl || "",
    mainImageThumbUrl: product.mainImageThumbUrl || "",
    mainImageUrl: product.mainImageUrl || "",
    thumbUrls: Array.isArray(product.thumbUrls) ? product.thumbUrls.slice(0, 3) : undefined,
    imageUrls: Array.isArray(product.imageUrls) ? product.imageUrls.slice(0, 3) : undefined,
    previewImage: selectPreviewImage(product),
    shippingItalySats: numbers.shippingItalySats,
    shippingEuropeSats: numbers.shippingEuropeSats,
    shippingWorldSats: numbers.shippingWorldSats,
    shippingZoneOverrides: zoneOverrides
  };
  out.__cartVersion = CART_VERSION;
  if (needsShippingHydrate || missingShipping) out.__needsShippingHydrate = true;
  return out;
}

function reviveStoredItems(rawList) {
  return rawList
    .map((entry) => {
      const legacyMissingShipping = !SHIPPING_KEYS.every((key) =>
        Object.prototype.hasOwnProperty.call(entry?.product || {}, key)
      );
      const legacyCartVersion = Number(entry?.product?.__cartVersion || 0);
      const product = snapshotProduct(entry?.product, {
        needsShippingHydrate: legacyMissingShipping || legacyCartVersion < CART_VERSION
      });
      if (!product) return null;
      const qty = Math.max(1, Math.floor(Number(entry?.qty) || 1));
      return { product, qty };
    })
    .filter(Boolean);
}

function serializeCartItems(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const product = snapshotProduct(entry?.product);
      if (!product) return null;
      const qty = Math.max(1, Math.floor(Number(entry?.qty) || 1));
      const out = { product, qty };
      if (entry?.product?.__needsShippingHydrate) {
        out.product.__needsShippingHydrate = true;
      }
      return out;
    })
    .filter(Boolean);
}

function mergeCartState(localEntries, remoteEntries) {
  const remote = reviveStoredItems(Array.isArray(remoteEntries) ? remoteEntries : []);
  const local = reviveStoredItems(serializeCartItems(localEntries));
  const order = [];
  const map = new Map();

  const absorb = (list) => {
    for (const entry of list) {
      const product = snapshotProduct(entry?.product);
      if (!product) continue;
      const pid = product.id;
      if (!pid) continue;
      const qty = Math.max(1, Math.floor(Number(entry?.qty) || 1));
      const existing = map.get(pid);
      if (existing) {
        const mergedProduct = snapshotProduct({ ...existing.product, ...product }) || existing.product;
        const mergedQty = Math.max(existing.qty, qty);
        map.set(pid, { product: mergedProduct, qty: mergedQty });
      } else if (order.length < MAX_CART_ITEMS) {
        order.push(pid);
        map.set(pid, { product, qty });
      }
    }
  };

  absorb(remote);
  absorb(local);

  return order.map((id) => map.get(id));
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(() => {
    const revived = reviveStoredItems(readStoredItems());
    safePersist(revived);
    return revived;
  });
  const [lastAdded, setLastAdded] = useState(null);
  const [nostrPk, setNostrPk] = useState("");
  const itemsRef = useRef(items);
  const fetchedForPkRef = useRef("");
  const readyForSyncRef = useRef(false);
  const lastSyncedRef = useRef("");

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    let cancelled = false;
    api.get("/nostr/me")
      .then((r) => {
        if (cancelled) return;
        const pk = r.data?.pubkey ? String(r.data.pubkey) : "";
        setNostrPk(pk);
      })
      .catch(() => {});
    const handleSession = (event) => {
      if (cancelled) return;
      const pk = event?.detail?.pubkey ? String(event.detail.pubkey) : "";
      setNostrPk(pk);
    };
    const handleLogout = () => {
      if (cancelled) return;
      setNostrPk("");
    };
    window.addEventListener("nostr:session", handleSession);
    window.addEventListener("nostr:logout", handleLogout);
    return () => {
      cancelled = true;
      window.removeEventListener("nostr:session", handleSession);
      window.removeEventListener("nostr:logout", handleLogout);
    };
  }, []);

  useEffect(() => {
    if (!nostrPk) {
      fetchedForPkRef.current = "";
      readyForSyncRef.current = false;
      lastSyncedRef.current = "";
      return;
    }
    if (fetchedForPkRef.current === nostrPk) {
      readyForSyncRef.current = true;
      return;
    }
    fetchedForPkRef.current = nostrPk;
    readyForSyncRef.current = false;
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.get("/cart", { headers: { "cache-control": "no-cache" } });
        if (cancelled) return;
        const serverItems = Array.isArray(resp.data?.items) ? resp.data.items : [];
        if (serverItems.length) {
          setItems((prev) => {
            const merged = mergeCartState(prev, serverItems);
            safePersist(merged);
            lastSyncedRef.current = JSON.stringify(serializeCartItems(merged));
            return merged;
          });
        } else {
          const serializedLocal = serializeCartItems(itemsRef.current);
          lastSyncedRef.current = JSON.stringify(serializedLocal);
        }
      } catch {
        // ignore fetch errors silently
      } finally {
        if (!cancelled) {
          readyForSyncRef.current = true;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nostrPk]);

  useEffect(() => {
    if (!nostrPk || !readyForSyncRef.current) return;
    const serialized = serializeCartItems(items);
    const json = JSON.stringify(serialized);
    if (json === lastSyncedRef.current) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.put("/cart", { items: serialized })
        .then(() => {
          if (!cancelled) {
            lastSyncedRef.current = json;
          }
        })
        .catch(() => {});
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [items, nostrPk]);

  // Refresh legacy cart entries that are missing shipping info (added before we started storing it)
  useEffect(() => {
    const needsHydration = items.filter((it) => {
      const p = it.product || {};
      if (!p.id) return false;
      if (p.__needsShippingHydrate) return true;
      return Number(p.__cartVersion || 0) < CART_VERSION;
    });
    if (!needsHydration.length) return;

    let cancelled = false;
    (async () => {
      try {
        const ids = Array.from(new Set(needsHydration.map((it) => it.product?.id).filter(Boolean)));
        if (!ids.length) return;
        const fetched = await Promise.all(
          ids.map(async (id) => {
            try {
              const resp = await api.get(`/products/${id}`, {
                headers: { "cache-control": "no-cache" }
              });
              return [id, resp.data];
            } catch {
              return [id, null];
            }
          })
        );
        if (cancelled) return;
        const map = new Map(fetched);
        setItems((prev) => {
          const next = prev.map((entry) => {
            const pid = entry.product?.id;
            if (!pid || !map.has(pid) || !map.get(pid)) return entry;
            const merged = snapshotProduct({ ...map.get(pid) });
            delete merged.__needsShippingHydrate;
            const out = { product: merged, qty: entry.qty };
            return out;
          });
          safePersist(next);
          return next;
        });
      } catch (err) {
        console.warn("[cart] Failed to hydrate shipping info:", err?.message || err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);

  function add(product, qty=1) {
    if (!product || !product.id) return;
    (async () => {
      let enriched = product;
      const hydrateIfMissing = SHIPPING_KEYS.some(
        (key) => enriched[key] === undefined || enriched[key] === null
      );
      if (hydrateIfMissing) {
        try {
          const resp = await api.get(`/products/${product.id}`, {
            headers: { "cache-control": "no-cache" }
          });
          if (resp?.data) {
            enriched = { ...enriched, ...resp.data };
          }
        } catch (err) {
          console.warn("[cart] failed to fetch product details for shipping:", err?.message || err);
        }
      }

      const needsHydrateFlag = SHIPPING_KEYS.some(
        (key) => enriched[key] === undefined || enriched[key] === null
      );
      const snapshot = snapshotProduct(enriched, { needsShippingHydrate: needsHydrateFlag });
      if (!snapshot) return;
      if (!snapshot.__needsShippingHydrate) delete snapshot.__needsShippingHydrate;

      let added = null;
      setItems(prev => {
        const exists = prev.find(it => it.product.id === snapshot.id);
        const q = Math.max(1, Math.floor(qty || 1));
        if (exists) {
          safePersist(prev);
          return prev;
        }
        const next = [...prev, { product: snapshot, qty: q }];
        const ok = safePersist(next);
        if (!ok) return prev;
        added = snapshot;
        return next;
      });
      if (added) {
        setLastAdded({ product: added, at: Date.now() });
      }
    })();
  }
  function remove(productId) {
    setItems(prev => {
      const next = prev.filter(it => it.product.id !== productId);
      safePersist(next);
      return next;
    });
  }
  function clear() {
    setItems([]);
    safePersist([]);
  }
  function subtotal() {
    return items.reduce((s, it) => s + it.product.priceSats * it.qty, 0);
  }
  const value = useMemo(() => ({
    items,
    add,
    remove,
    clear,
    subtotal,
    count: items.length,
    nostrPubkey: nostrPk
  }), [items, nostrPk]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <CartToast notice={lastAdded} onHide={() => setLastAdded(null)} />
    </Ctx.Provider>
  );
}

export function useCart() {
  return useContext(Ctx);
}

function CartToast({ notice, onHide }) {
  const [visible, setVisible] = useState(false);
  const [pop, setPop] = useState(false);

  useEffect(() => {
    if (!notice) return;
    setVisible(true);
    setPop(true);
    const popTimer = setTimeout(() => setPop(false), 360);
    const hideTimer = setTimeout(() => setVisible(false), 3600);
    const cleanupTimer = setTimeout(() => onHide?.(), 4000);
    return () => {
      clearTimeout(popTimer);
      clearTimeout(hideTimer);
      clearTimeout(cleanupTimer);
    };
  }, [notice, onHide]);

  if (!notice) return null;
  const product = notice.product || {};
  const img = selectPreviewImage(product);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div
        className={[
          "flex items-center gap-3 rounded-2xl bg-slate-900/95 px-4 py-3 ring-1 ring-white/15 shadow-2xl backdrop-blur transition-all duration-500 ease-out transform",
          visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6",
          pop ? "scale-105 shadow-[0_12px_40px_rgba(99,102,241,0.35)] ring-2 ring-indigo-400/60" : "scale-100"
        ].join(" ")}
        role="status"
        aria-live="polite"
      >
        {img ? (
          <img
            src={img}
            alt=""
            className="h-12 w-12 rounded-xl object-cover ring-1 ring-white/10 bg-black/30"
            loading="lazy"
          />
        ) : (
          <div className="h-12 w-12 rounded-xl bg-slate-800 ring-1 ring-white/10 grid place-items-center text-white/60">
            ✓
          </div>
        )}
        <div>
          <div className="text-xs uppercase tracking-wide text-white/60">Added to cart</div>
          <div className="font-semibold text-white">
            {product.title || "Artwork"}
          </div>
        </div>
      </div>
    </div>
  );
}
