import React from "react";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import Cart from "../Cart.jsx";

const removeMock = vi.fn();

vi.mock("../../store/cart.jsx", () => ({
  useCart: () => ({
    items: [
      {
        product: {
          id: "p1",
          title: "Test Product",
          priceSats: 1234,
          images: ["data:image/png;base64,iVBORw0KGgo="]
        },
        qty: 1
      }
    ],
    remove: removeMock,
    subtotal: () => 1234
  })
}));

describe("Cart page", () => {
  it("renders items and removes on click", async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <Cart />
        </MemoryRouter>
      );
    });

    expect(screen.getByText("Test Product")).toBeInTheDocument();
    const prices = screen.getAllByText(/1,234/);
    expect(prices.length).toBeGreaterThan(0);

    await act(async () => {
      await userEvent.click(screen.getByText("Remove"));
    });
    expect(removeMock).toHaveBeenCalledWith("p1");
  });
});
