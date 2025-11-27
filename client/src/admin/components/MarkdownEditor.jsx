import React, { useMemo, useRef } from "react";
import { renderMarkdown } from "../../utils/markdown.js";

function Button({ onClick, label, title }) {
  return (
    <button
      type="button"
      title={title || label}
      className="px-2 py-1 rounded-xl bg-slate-950 hover:bg-slate-900 ring-1 ring-white/10 text-xs text-white/70"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export default function MarkdownEditor({ value, onChange, placeholder, showPreview = true }) {
  const textareaRef = useRef(null);

  const preview = useMemo(() => renderMarkdown(value || ""), [value]);

  const updateValue = (next, selectionStart, selectionEnd) => {
    if (typeof onChange === "function") {
      onChange(next);
    }
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el && typeof selectionStart === "number" && typeof selectionEnd === "number") {
        el.focus();
        el.setSelectionRange(selectionStart, selectionEnd);
      }
    });
  };

  const wrapSelection = (prefix, suffix = prefix, placeholderText = "") => {
    const el = textareaRef.current;
    if (!el) return;

    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const current = value || "";
    const selected = current.slice(start, end) || placeholderText;
    const nextStart = start + prefix.length;
    const nextEnd = nextStart + selected.length;
    const nextValue = current.slice(0, start) + prefix + selected + suffix + current.slice(end);

    updateValue(nextValue, nextStart, nextEnd);
  };

  const toggleList = () => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const current = value || "";
    const before = current.slice(0, start);
    const selected = current.slice(start, end);
    const after = current.slice(end);

    const lines = selected ? selected.split("\n") : [""];
    const transformed = lines
      .map((line) => {
        if (!line.trim()) return "- ";
        if (/^\s*[-*+]\s+/.test(line)) return line;
        return `- ${line}`;
      })
      .join("\n");

    const nextValue = before + transformed + after;
    const nextStart = before.length;
    const nextEnd = nextStart + transformed.length;
    updateValue(nextValue, nextStart, nextEnd);
  };

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Button label="B" title="Grassetto" onClick={() => wrapSelection("**", "**", "testo")} />
        <Button label="I" title="Corsivo" onClick={() => wrapSelection("_", "_", "testo")} />
        <Button label="H2" title="Sottotitolo" onClick={() => wrapSelection("## ", "", "Titolo")} />
        <Button label="•" title="Elenco puntato" onClick={toggleList} />
        <Button label="Link" title="Aggiungi link" onClick={() => wrapSelection("[", "](https://)", "testo")} />
        <Button label="Code" title="Inline code" onClick={() => wrapSelection("`", "`", "codice")} />
      </div>
      <textarea
        ref={textareaRef}
        rows={6}
        className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      />
      {showPreview && (
        <>
          <div className="text-xs text-white/60">Anteprima</div>
          <div
            className="rounded-2xl bg-slate-950 ring-1 ring-white/10 px-4 py-3 text-sm leading-relaxed text-white/80 space-y-3 markdown-preview"
            dangerouslySetInnerHTML={{
              __html: preview || '<p class="text-white/40">Nessun contenuto</p>'
            }}
          />
        </>
      )}
    </div>
  );
}
