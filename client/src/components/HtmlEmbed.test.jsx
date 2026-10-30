import React, { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import HtmlEmbed from "./HtmlEmbed.jsx";

describe("HtmlEmbed", () => {
  it("renders ordinary HTML content", () => {
    const { getByText } = render(
      <HtmlEmbed html="<div><p>Embed content</p></div>" />
    );

    expect(getByText("Embed content")).toBeTruthy();
  });

  it("executes external scripts before following inline scripts", async () => {
    const executionOrder = [];
    window.__embedExecutionOrder = executionOrder;

    const originalReplaceWith = Comment.prototype.replaceWith;
    const replaceWithSpy = vi
      .spyOn(Comment.prototype, "replaceWith")
      .mockImplementation(function (...nodes) {
        // Prevent jsdom from executing the inline script in its VM context.
        for (const node of nodes) {
          if (
            node instanceof HTMLScriptElement &&
            !node.hasAttribute("src") &&
            node.textContent.trim()
          ) {
            node.type = "application/x-test";
          }
        }

        const result = originalReplaceWith.apply(this, nodes);

        for (const node of nodes) {
          if (
            node instanceof HTMLScriptElement &&
            !node.hasAttribute("src") &&
            node.textContent.trim()
          ) {
            // jsdom does not execute dynamically inserted inline scripts.
            // Simulate browser execution when the script enters the document.
            new Function("window", node.textContent)(window);
          }
        }

        return result;
      });

    try {
      const html = `
        <div id="widget-container"></div>
        <script src="/widget-library.js"></script>
        <script>window.__embedExecutionOrder.push("inline");</script>
      `;

      const { container } = render(<HtmlEmbed html={html} />);

      const externalScript = container.querySelector(
        'script[src="/widget-library.js"]'
      );

      expect(externalScript).toBeTruthy();
      expect(executionOrder).toEqual([]);

      // Simulate the external script's side effect when it finishes loading.
      externalScript.addEventListener(
        "load",
        () => executionOrder.push("external"),
        { once: true }
      );
      fireEvent.load(externalScript);

      await waitFor(() => {
        expect(executionOrder).toEqual(["external", "inline"]);
        expect(container.querySelectorAll("script")).toHaveLength(2);
      });
    } finally {
      replaceWithSpy.mockRestore();
      delete window.__embedExecutionOrder;
    }
  });

  it("does not block following scripts on inline module scripts", async () => {
    const html = `
      <script type="module">
        window.__inlineModule = true;
      </script>
      <script>
        window.__afterInlineModule = true;
      </script>
    `;
    const { container } = render(<HtmlEmbed html={html} />);
    await waitFor(() => {
      expect(container.querySelectorAll("script")).toHaveLength(2);
    });
  });
  it("does not wait for external data-block scripts", async () => {
    const html = `
      <script type="application/ld+json" src="/metadata.json"></script>
      <script type="application/json" src="/config.json"></script>
      <script>
        window.__afterDataBlocks = true;
      </script>
    `;

    const { container } = render(<HtmlEmbed html={html} />);

    await waitFor(() => {
      const scripts = container.querySelectorAll("script");
      expect(scripts).toHaveLength(3);
      expect(scripts[0].type).toBe("application/ld+json");
      expect(scripts[1].type).toBe("application/json");
      expect(scripts[2].textContent).toContain("window.__afterDataBlocks");
    });
  });

  it("does not wait for nomodule scripts in browsers supporting modules", async () => {
    const originalNoModule = Object.getOwnPropertyDescriptor(
      HTMLScriptElement.prototype,
      "noModule"
    );

    Object.defineProperty(HTMLScriptElement.prototype, "noModule", {
      configurable: true,
      get() {
        return this.hasAttribute("nomodule");
      }
    });

    try {
      const html = `
        <script nomodule src="/legacy-widget.js"></script>
        <script>window.__afterNomodule = true;</script>
      `;

      const { container } = render(<HtmlEmbed html={html} />);

      await waitFor(() => {
        expect(container.querySelectorAll("script")).toHaveLength(2);
      });

      expect(container.querySelectorAll("script")[1].textContent).toContain(
        "window.__afterNomodule = true"
      );
    } finally {
      if (originalNoModule) {
        Object.defineProperty(
          HTMLScriptElement.prototype,
          "noModule",
          originalNoModule
        );
      } else {
        delete HTMLScriptElement.prototype.noModule;
      }
    }
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
