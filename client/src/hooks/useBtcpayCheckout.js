import { useCallback, useEffect, useState } from "react";
import api from "../services/api.js";

export function useBtcpayCheckout({ paymentConfig }) {
  const provider = String(paymentConfig?.provider || "").toLowerCase();
  const modalUrl = paymentConfig?.btcpayModalUrl || "";
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadScript() {
      if (provider !== "btcpay" || !modalUrl) {
        setReady(false);
        return;
      }
      if (typeof window === "undefined") return;
      if (window.btcpay) {
        setReady(true);
        return;
      }
      await new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${modalUrl}"]`);
        if (existing) {
          existing.onload = () => resolve();
          existing.onerror = reject;
          return;
        }
        const s = document.createElement("script");
        s.src = modalUrl;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = reject;
        document.body.appendChild(s);
      });
      if (!cancelled) setReady(true);
    }
    loadScript().catch(() => setReady(false));
    return () => {
      cancelled = true;
    };
  }, [provider, modalUrl]);

  const startBtcpayCheckout = useCallback(
    async ({ invoiceId, paymentHash, checkoutLink, onPaid, onExpired }) => {
      if (provider !== "btcpay") return false;
      const id = invoiceId || paymentHash;

      const triggerPaid = async () => {
        if (id) {
          try {
            const r = await api.get(`/invoices/${id}/status`);
            const st = String(r.data?.status || "").toUpperCase();
            if (st === "PAID") {
              onPaid?.(id);
              return;
            }
          } catch {
            // swallow and still invoke
          }
        }
        onPaid?.(id);
      };

      if (ready && typeof window !== "undefined" && window.btcpay && id) {
        window.btcpay.onModalReceiveMessage?.((msg) => {
          const st = String(msg?.status || "").toLowerCase();
          if (st === "paid" || st === "complete") {
            triggerPaid();
            window.btcpay.hideFrame?.();
          } else if (st === "expired") {
            onExpired?.();
            window.btcpay.hideFrame?.();
          }
        });
        window.btcpay.showInvoice(id);
        return true;
      }

      if (checkoutLink) {
        try {
          window.location.href = checkoutLink;
        } catch {
          /* noop */
        }
        return true;
      }
      return false;
    },
    [provider, ready]
  );

  return { startBtcpayCheckout, btcpayReady: ready };
}
