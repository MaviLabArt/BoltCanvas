import { useEffect, useRef } from "react";

// Keep the current execution associated with its DOM container.
// This also prevents React StrictMode from initializing the same embed twice.
const executions = new WeakMap();

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
        const isModule = script.type === "module";
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

        if (hasSource || isModule) {
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
