import { useEffect, useRef } from "react";

// Keep the current execution associated with its DOM container.
// This also prevents React StrictMode from initializing the same embed twice.
const executions = new WeakMap();

const JAVASCRIPT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript"
]);

function isExecutableScript(script) {
  const type = (script.getAttribute("type") || "").trim().toLowerCase();

  if (!type || type === "module") return true;

  const mimeType = type.split(";")[0].trim();
  return JAVASCRIPT_MIME_TYPES.has(mimeType);
}

export default function HtmlEmbed({ html = "", className = "" }) {
  const containerRef = useRef(null);
  const source = String(html || "");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previous = executions.get(container);

    if (previous?.html === source) {
      return;
    }

    if (previous) {
      previous.cancelled = true;
    }

    const execution = {
      html: source,
      cancelled: false
    };

    executions.set(container, execution);

    const template = document.createElement("template");
    template.innerHTML = source;

    const entries = Array.from(
      template.content.querySelectorAll("script")
    ).map((original) => {
      const placeholder = document.createComment("embed-script");
      original.replaceWith(placeholder);
      return { original, placeholder };
    });

    container.replaceChildren(template.content);

    const runScripts = async () => {
      for (const { original, placeholder } of entries) {
        if (execution.cancelled || !container.isConnected) return;

        const script = document.createElement("script");

        for (const attribute of Array.from(original.attributes)) {
          script.setAttribute(attribute.name, attribute.value);
        }

        const hasSource = script.hasAttribute("src");
        const isModule = script.type.trim().toLowerCase() === "module";
        const hasExecutableType = isExecutableScript(script);
        const isExplicitlyAsync = script.hasAttribute("async");
        // Modern browsers ignore classic scripts marked nomodule.
        const isIgnoredNomodule =
          hasSource &&
          !isModule &&
          script.noModule &&
          "noModule" in script;

        // Dynamically inserted classic scripts are async by default.
        // Disable that behavior unless async was explicitly requested.
        if (hasSource && !isExplicitlyAsync) {
          script.async = false;
        }

        let loadPromise = null;

        // Inline module scripts do not provide a reliable load/error event
        // for this sequencing mechanism. Let the browser evaluate them
        // asynchronously without blocking the insertion of following scripts.
        if (hasSource && hasExecutableType) {
          loadPromise = new Promise((resolve) => {
            script.addEventListener("load", resolve, { once: true });
            script.addEventListener(
              "error",
              () => {
                console.warn(
                  "[HtmlEmbed] Unable to load embed script:",
                  script.src || "inline module"
                );
                resolve();
              },
              { once: true }
            );
          });
        }

        script.textContent = original.textContent;
        placeholder.replaceWith(script);

        // Explicitly async scripts retain their requested behavior.
        if (
          loadPromise &&
          !(hasSource && isExplicitlyAsync) &&
          !isIgnoredNomodule
        ) {
          await loadPromise;
        }
      }
    };

    void runScripts().catch((error) => {
      console.error("[HtmlEmbed] Embed initialization failed:", error);
    });

    // Deliberately do not cancel here: React StrictMode replays effects
    // during development. A changed HTML value cancels scripts that have
    // not yet been inserted, and a real unmount is detected through
    // container.isConnected. An external script already inserted into the
    // document cannot be aborted here and may still execute after removal.
  }, [source]);

  return <div ref={containerRef} className={className} />;
}
