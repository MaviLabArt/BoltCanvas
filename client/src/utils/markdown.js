const PLACEHOLDER_START = "\u0000MDP";
const PLACEHOLDER_END = "PDM\u0000";

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeUrl(raw = "") {
  const url = String(raw || "").trim();
  if (!url) return "";

  const lower = url.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("file:")
  ) {
    return "";
  }

  if (lower.startsWith("//")) return "";

  return escapeHtml(url);
}

function renderInline(text = "") {
  const placeholders = [];

  const store = (html) => {
    const token = `${PLACEHOLDER_START}${placeholders.length}${PLACEHOLDER_END}`;
    placeholders.push(html);
    return token;
  };

  let working = String(text || "");

  // Inline code first (no nested markdown inside)
  working = working.replace(/`([^`]+)`/g, (_, code) =>
    store(`<code>${escapeHtml(code)}</code>`)
  );

  // Strikethrough
  working = working.replace(/~~([^~]+)~~/g, (_, content) =>
    store(`<del>${renderInline(content)}</del>`)
  );

  // Bold (** or __)
  working = working.replace(/(\*\*|__)([^*_]+?)\1/g, (_, __, content) =>
    store(`<strong>${renderInline(content)}</strong>`)
  );

  // Italic (* or _)
  working = working.replace(/(\*|_)([^*_]+?)\1/g, (_, __, content) =>
    store(`<em>${renderInline(content)}</em>`)
  );

  // Links [label](url)
  working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safeHref = sanitizeUrl(href);
    const labelHtml = renderInline(label);
    if (!safeHref) {
      return store(labelHtml);
    }
    return store(
      `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`
    );
  });

  // Images ![alt](url) -> keep very limited
  working = working.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    const safeSrc = sanitizeUrl(src);
    if (!safeSrc) return store(escapeHtml(alt));
    return store(
      `<img src="${safeSrc}" alt="${escapeHtml(alt)}" class="max-w-full rounded-lg" />`
    );
  });

  // Escape remaining text
  working = escapeHtml(working);

  // Restore placeholders
  placeholders.forEach((html, idx) => {
    const token = `${PLACEHOLDER_START}${idx}${PLACEHOLDER_END}`;
    working = working.split(token).join(html);
  });

  return working;
}

export function renderMarkdown(src = "") {
  const input = String(src || "").replace(/\r\n?/g, "\n");
  const blocks = input.split(/\n{2,}/).map((block) => block.trimEnd());
  const output = [];

  for (const block of blocks) {
    if (!block.trim()) continue;

    // Headings (#, ##, ###)
    const headingMatch = block.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      const headingClasses = ["text-2xl", "text-xl", "text-lg"];
      const cls = headingClasses[Math.min(level - 1, headingClasses.length - 1)];
      output.push(
        `<h${level + 2} class="${cls} font-semibold text-white/90">${renderInline(
          content
        )}</h${level + 2}>`
      );
      continue;
    }

    const lines = block.split("\n");
    const isList = lines.every((line) => /^\s*[-*+]\s+/.test(line));

    if (isList) {
      const items = lines
        .map((line) => line.replace(/^\s*[-*+]\s+/, ""))
        .map((item) => `<li>${renderInline(item)}</li>`)
        .join("");
      output.push(`<ul class="list-disc pl-5 space-y-1">${items}</ul>`);
      continue;
    }

    const paragraph = renderInline(lines.join("\n")).replace(/\n/g, "<br />");
    output.push(`<p>${paragraph}</p>`);
  }

  return output.join("\n");
}

function decodeHtmlEntities(str = "") {
  return String(str)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function stripMarkdown(src = "") {
  const html = renderMarkdown(src);
  if (!html) return "";
  const noTags = html.replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(noTags).replace(/\s+/g, " ").trim();
}
