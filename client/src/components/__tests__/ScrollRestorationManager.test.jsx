import React from "react";
import {
  MemoryRouter, Link, Route, Routes, useNavigate, useLocation
} from "react-router-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ScrollRestorationManager from "../ScrollRestorationManager.jsx";

let currentY = 0;

function Listing() {
  return (
    <main data-scroll-restoration-ready="true">
      <Link to="/product/p1" data-product-card-id="p1">
        Open painting
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

beforeEach(() => {
  currentY = 0;
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
  vi.restoreAllMocks();
  window.requestAnimationFrame = originalRaf;
  window.cancelAnimationFrame = originalCaf;
  window.scrollTo = originalScrollTo;
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
