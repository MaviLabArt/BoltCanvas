import React from "react";
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";

const apiGet = vi.fn(async (path) => {
  if (path === "/payments/config") return { data: { provider: "blink", onchainEnabled: true, onchainMinSats: 0 } };
  return { data: {} };
});
const apiPost = vi.fn(async () => ({
  data: {
    paymentHash: "hash-1",
    paymentRequest: "lnbc1invoice",
    satoshis: 1234,
    paymentMethod: "lightning"
  }
}));
const clearCart = vi.fn();

vi.mock("../../services/api.js", () => ({
  default: { get: (...args) => apiGet(...args), post: (...args) => apiPost(...args) },
  API_BASE: "/api",
  absoluteApiUrl: (p) => p
}));
vi.mock("../../store/cart.jsx", () => ({
  useCart: () => ({
    items: [
      {
        product: {
          id: "p1",
          title: "Item",
          priceSats: 1000,
          shippingZoneOverrides: []
        },
        qty: 1
      }
    ],
    clear: clearCart,
    subtotal: () => 1000
  })
}));
vi.mock("../../store/settings.jsx", () => ({
  useSettings: () => ({
    settings: {
      shippingZones: [],
      nostrRelays: [],
      nostrShopPubkey: "pk"
    }
  })
}));
vi.mock("../../components/QR.jsx", () => ({ default: () => <div data-testid="qr" /> }));
vi.mock("../../components/AsyncButton.jsx", () => ({
  default: ({ children, onClick, className }) => (
    <button onClick={onClick} className={className}>
      {children}
    </button>
  )
}));
vi.mock("framer-motion", () => {
  const MotionStub = ({ children, ...props }) => {
    const safe = { ...props };
    delete safe.initial;
    delete safe.animate;
    delete safe.exit;
    delete safe.variants;
    delete safe.transition;
    delete safe.layoutId;
    delete safe.whileTap;
    delete safe.whileHover;
    return <div {...safe}>{children}</div>;
  };
  return {
    motion: new Proxy({}, { get: () => MotionStub }),
    AnimatePresence: ({ children }) => <>{children}</>,
    useReducedMotion: () => true
  };
});
vi.mock("light-bolt11-decoder", () => ({ decode: () => ({ sections: [{ name: "expiry", value: 600 }] }) }));
vi.mock("../../utils/loadNip19.js", () => ({ loadNip19: async () => ({ npubEncode: (v) => `npub${v}` }) }));

global.alert = vi.fn();

describe("Checkout page", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it.each(["lightning", "onchain"])("restores a saved %s payment after reload", async (paymentMethod) => {
    localStorage.setItem("lightning-shop-active-payment", JSON.stringify({
      savedAt: Date.now(), paymentMethod, paymentHash: "saved-hash",
      paymentRequest: "lnbc1saved", satoshis: 1234,
      onchainId: "saved-order", onchainAddress: "bc1saved", onchainAmountSats: 1234
    }));
    const Checkout = (await import("../Checkout.jsx")).default;
    render(<MemoryRouter><Checkout /></MemoryRouter>);
    expect(await screen.findByText(paymentMethod === "lightning" ? /Pay with Lightning/ : /Pay on-chain/)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.queryByText("Pay Now")).not.toBeInTheDocument();
  });

  it("does not restart polling when a request finishes after unmount", async () => {
    vi.useFakeTimers();
    let resolveStatus;
    const original = apiGet.getMockImplementation();
    apiGet.mockImplementation((path) => path.includes("/status")
      ? new Promise((resolve) => { resolveStatus = resolve; })
      : original(path));
    try {
      localStorage.setItem("lightning-shop-active-payment", JSON.stringify({
        savedAt: Date.now(), paymentMethod: "lightning", paymentHash: "saved-hash",
        paymentRequest: "lnbc1saved", satoshis: 1234
      }));
      const Checkout = (await import("../Checkout.jsx")).default;
      const view = render(<MemoryRouter><Checkout /></MemoryRouter>);
      await act(async () => {});
      expect(resolveStatus).toBeTypeOf("function");
      view.unmount();
      await act(async () => {
        resolveStatus({ data: { status: "PENDING" } });
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(apiGet.mock.calls.filter(([path]) => path.includes("/status"))).toHaveLength(1);
    } finally {
      apiGet.mockImplementation(original);
      vi.useRealTimers();
    }
  });

  it("creates an invoice and shows the pay modal", async () => {
    const Checkout = (await import("../Checkout.jsx")).default;
    await act(async () => {
      render(
        <MemoryRouter>
          <Checkout />
        </MemoryRouter>
      );
    });

    await act(async () => {
      await userEvent.type(screen.getByPlaceholderText("Name"), "John");
      await userEvent.type(screen.getByPlaceholderText("Surname"), "Doe");
      await userEvent.type(screen.getByPlaceholderText("Address"), "123 Street");
      await userEvent.type(screen.getByPlaceholderText("City"), "Town");
      await userEvent.type(screen.getByPlaceholderText("Province / State"), "TS");
      await userEvent.type(screen.getByPlaceholderText("Postal code"), "12345");
      await userEvent.selectOptions(screen.getByRole("combobox"), "IT");
      await userEvent.type(screen.getByPlaceholderText("Phone number (required for courier)"), "123");
      await userEvent.type(screen.getByPlaceholderText("Email"), "a@b.com");
      await userEvent.type(screen.getByPlaceholderText("Telegram (e.g. @nickname)"), "@me");
      await userEvent.click(screen.getByText("Pay Now"));
    });

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/checkout/create-invoice", expect.any(Object)));
    await waitFor(() => {
      expect(screen.getByText(/Pay with Lightning/)).toBeInTheDocument();
    });
  });
});
