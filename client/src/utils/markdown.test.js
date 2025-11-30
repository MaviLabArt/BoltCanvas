import { describe, expect, it } from "vitest";
import { renderMarkdown, stripMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  it("renders headings, emphasis, and inline code", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** and _italic_ with `code`.");
    expect(html).toContain("<h3");
    expect(html).toContain("Title");
    expect(html).toContain("<strong>");
    expect(html).toContain("<em>");
    expect(html).toContain("<code>code</code>");
  });

  it("sanitizes dangerous links and URLs", () => {
    const html = renderMarkdown("[bad](javascript:alert(1)) and ![img](data:text/html,<x>)");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<img");
    expect(html).toContain("bad");
    expect(html).toContain("img");
  });
});

describe("stripMarkdown", () => {
  it("removes tags and collapses whitespace", () => {
    const text = stripMarkdown("## Hello\n\nList:\n- One\n- Two\n\n[Link](https://example.com)");
    expect(text).toBe("Hello List: One Two Link");
  });
});
