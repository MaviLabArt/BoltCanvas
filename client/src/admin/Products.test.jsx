import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn()
}));

vi.mock("../services/api.js", () => ({
  default: { get: mocks.apiGet, put: vi.fn(), post: vi.fn(), delete: vi.fn() },
  absoluteApiUrl: value => value || ""
}));
vi.mock("./i18n.jsx", () => ({
  useAdminI18n: () => ({ t: (_it, en) => en ?? _it })
}));
vi.mock("../components/AsyncButton.jsx", () => ({
  default: ({ children, onClick, disabled, ...props }) => (
    <button type="button" onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  )
}));

import Products from "./Products.jsx";

describe("Products reorder status overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const items = [
      { id: "sold-1", title: "Sold painting", artworkStatus: "sold", imageCount: 0 },
      { id: "available-1", title: "Available painting", artworkStatus: "for_sale", imageCount: 0 }
    ];

    mocks.apiGet.mockImplementation(async path => {
      if (path === "/admin/settings") return { data: {} };
      if (path === "/admin/products?page=1&pageSize=24") {
        return { data: { items, page: 1, totalPages: 1, total: items.length } };
      }
      if (path === "/admin/products?page=1&pageSize=100") {
        return { data: { items, page: 1, totalPages: 1, total: items.length } };
      }
      return { data: {} };
    });
  });

  it("keeps the reorder position badge above the sold-artwork overlay", async () => {
    render(<Products />);

    await waitFor(() => {
      expect(screen.getByText("SOLD")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Reorder" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Reorder" }));

    const badge = await screen.findByText("#1");
    const overlayLabel = await screen.findByText("SOLD");

    expect(badge).toHaveClass("z-10");
    expect(overlayLabel.parentElement).toHaveClass("z-0");
  });
});
