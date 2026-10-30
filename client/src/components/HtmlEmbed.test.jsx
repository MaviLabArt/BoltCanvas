import React, { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import HtmlEmbed from "./HtmlEmbed.jsx";

describe("HtmlEmbed", () => {
  it("renders ordinary HTML content", () => {
    const { getByText } = render(
      <HtmlEmbed html="<div><p>Embed content</p></div>" />
    );

    expect(getByText("Embed content")).toBeTruthy();
  });

  it("loads external scripts before running following inline scripts", async () => {
    const html = `
      <div id="widget-container"></div>
      <script src="/widget-library.js"></script>
      <script>window.__embedInitialized = true;</script>
    `;

    const { container } = render(<HtmlEmbed html={html} />);

    const externalScript = container.querySelector(
      'script[src="/widget-library.js"]'
    );

    expect(externalScript).toBeTruthy();
    expect(container.querySelectorAll("script")).toHaveLength(1);

    fireEvent.load(externalScript);

    await waitFor(() => {
      expect(container.querySelectorAll("script")).toHaveLength(2);
    });

    const inlineScript = container.querySelectorAll("script")[1];
    expect(inlineScript.textContent).toContain(
      "window.__embedInitialized = true"
    );
  });

  it("does not insert the same scripts twice in React StrictMode", () => {
    const html = '<script src="/widget-library.js"></script>';

    const { container } = render(
      <StrictMode>
        <HtmlEmbed html={html} />
      </StrictMode>
    );

    expect(
      container.querySelectorAll('script[src="/widget-library.js"]')
    ).toHaveLength(1);
  });

  it("updates the rendered HTML when the embed changes", () => {
    const { getByText, queryByText, rerender } = render(
      <HtmlEmbed html="<p>First version</p>" />
    );

    expect(getByText("First version")).toBeTruthy();

    rerender(<HtmlEmbed html="<p>Second version</p>" />);

    expect(queryByText("First version")).toBeNull();
    expect(getByText("Second version")).toBeTruthy();
  });
});
