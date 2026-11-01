import React from "react";
import {
  MemoryRouter, Link, Route, Routes, useNavigate, useLocation
} from "react-router-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ScrollRestorationManager from "../ScrollRestorationManager.jsx";

let currentY = 0;
let listingReady = true;

function Listing() {
  return (
    <main {...(listingReady ? { "data-scroll-restoration-ready": "true" } : {})}>
      <Link to="/product/p1" data-product-card-id="p1">
        Open painting
      </Link>
      <Link to="/gallery" onClick={() => { currentY = 0; }}>
        Open gallery
      </Link>
      <Link to="/gallery#%E0%A4%A">
        Open malformed anchor
      </Link>
    </main>
  );
}

function Detail() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>Back</button>;
}

function RouteProbe() {
  const location = useLocation();
  return <output data-testid="route">{location.pathname}</output>;
}

function Harness() {
  return (
    <>
      <ScrollRestorationManager />
      <RouteProbe />
      <Routes>
        <Route path="/" element={<Listing />} />
        <Route path="/gallery" element={<Listing />} />
        <Route path="/product/:id" element={<Detail />} />
      </Routes>
    </>
  );
}

const originalRaf = window.requestAnimationFrame;
const originalCaf = window.cancelAnimationFrame;
const originalScrollTo = window.scrollTo;
const originalMutationObserver = window.MutationObserver;

beforeEach(() => {
  currentY = 0;
  listingReady = true;
  sessionStorage.clear();

  Object.defineProperty(window, "scrollY", {
    configurable: true,
    get: () => currentY
  });

  Object.defineProperty(window, "scrollX", {
    configurable: true,
    get: () => 0
  });

  window.scrollTo = vi.fn((_x, y) => {
    currentY = Number(y) || 0;
  });

  window.requestAnimationFrame = callback =>
    window.setTimeout(() => callback(Date.now()), 0);

  window.cancelAnimationFrame = id => window.clearTimeout(id);

  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function () {
      const isCard =
        this.getAttribute?.("data-product-card-id") === "p1";
      const top = isCard ? (currentY === 0 ? 1140 : 240) : 0;

      return {
        x: 0, y: top, top, bottom: top + 200,
        left: 0, right: 300, width: 300, height: 200,
        toJSON: () => ({})
      };
    });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  listingReady = true;
  window.requestAnimationFrame = originalRaf;
  window.cancelAnimationFrame = originalCaf;
  window.scrollTo = originalScrollTo;
  window.MutationObserver = originalMutationObserver;
});

describe.each(["/", "/gallery"])(
  "Scroll restoration from %s",
  startPath => {
    it("restores the clicked painting and its previous position", async () => {
      render(
        <MemoryRouter initialEntries={[startPath]}>
          <Harness />
        </MemoryRouter>
      );

      const link = screen.getByRole("link", { name: "Open painting" });

      currentY = 900;

      await act(async () => {
        fireEvent.scroll(window);
        await new Promise(resolve => setTimeout(resolve, 5));
      });

      await act(async () => {
        fireEvent.pointerDown(link, { button: 0 });
        fireEvent.click(link, { button: 0 });
      });

      expect(screen.getByTestId("route")).toHaveTextContent("/product/p1");

      let saved = null;
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (!key.startsWith("isolabellart:scroll:v1:")) continue;

        const value = JSON.parse(sessionStorage.getItem(key));
        if (value.pathname === startPath) saved = value;
      }

      expect(saved).toMatchObject({
        pathname: startPath,
        productId: "p1",
        scrollY: 900,
        viewportTop: 240
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
      });

      await waitFor(() => {
        expect(screen.getByTestId("route")).toHaveTextContent(startPath);
        expect(currentY).toBe(900);
      });
    });
  }
);


describe("Scroll restoration edge cases", () => {
  it("restores a saved position on the initial mount after the listing is ready", async () => {
    listingReady = false;
    sessionStorage.setItem(
      "isolabellart:scroll:v1:home-entry",
      JSON.stringify({ pathname: "/", scrollX: 0, scrollY: 640 })
    );

    render(
      <React.StrictMode>
        <MemoryRouter initialEntries={[{ pathname: "/", key: "home-entry" }]}>
          <Harness />
        </MemoryRouter>
      </React.StrictMode>
    );

    expect(window.scrollTo).not.toHaveBeenCalled();

    document.querySelector("main").setAttribute(
      "data-scroll-restoration-ready",
      "true"
    );

    await waitFor(() => {
      expect(window.scrollTo).toHaveBeenCalledWith(0, 640);
    });
  });

  it("does not throw when a pushed route contains a malformed URL fragment", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Harness />
      </MemoryRouter>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Open malformed anchor" }));
    });

    expect(screen.getByTestId("route")).toHaveTextContent("/gallery");
  });

  it("saves the pre-navigation position and ignores a stale scroll frame", async () => {
    const frames = new Map();
    let nextFrameId = 1;

    const requestFrame = vi.fn(callback => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    const cancelFrame = vi.fn(id => {
      frames.delete(id);
    });

    window.requestAnimationFrame = requestFrame;
    window.cancelAnimationFrame = cancelFrame;

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Harness />
      </MemoryRouter>
    );

    currentY = 900;
    fireEvent.scroll(window);

    const pendingFrame = [...frames.entries()][0];
    expect(pendingFrame).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Open gallery" }));
    });

    expect(screen.getByTestId("route")).toHaveTextContent("/gallery");
    expect(cancelFrame).toHaveBeenCalledWith(pendingFrame[0]);

    // Simulate a callback that was already queued when navigation committed.
    pendingFrame[1](Date.now());

    let saved = null;
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key.startsWith("isolabellart:scroll:v1:")) continue;
      const value = JSON.parse(sessionStorage.getItem(key));
      if (value.pathname === "/") saved = value;
    }

    expect(saved).toMatchObject({ pathname: "/", scrollY: 900 });
  });

  it("does not restore a second time when readiness arrives after the max wait", async () => {
    listingReady = false;

    const observers = [];
    class ControlledMutationObserver {
      constructor(callback) {
        this.callback = callback;
        this.disconnect = vi.fn();
        this.observe = vi.fn();
        observers.push(this);
      }
    }
    window.MutationObserver = ControlledMutationObserver;

    sessionStorage.setItem(
      "isolabellart:scroll:v1:home-entry",
      JSON.stringify({ pathname: "/", scrollX: 0, scrollY: 640 })
    );

    render(
      <MemoryRouter
        initialEntries={[
          { pathname: "/", key: "home-entry" },
          { pathname: "/product/p1", key: "detail-entry" }
        ]}
        initialIndex={1}
      >
        <Harness />
      </MemoryRouter>
    );

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
    });

    expect(screen.getByTestId("route")).toHaveTextContent("/");
    expect(observers).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(observers[0].disconnect).toHaveBeenCalled();

    document.querySelector("main").setAttribute(
      "data-scroll-restoration-ready",
      "true"
    );
    await act(async () => {
      observers[0].callback([]);
      vi.runOnlyPendingTimers();
    });

    expect(window.scrollTo).toHaveBeenCalledTimes(1);
  });
});
