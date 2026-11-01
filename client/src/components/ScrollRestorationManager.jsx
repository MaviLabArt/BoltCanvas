import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

const STORAGE_PREFIX = "isolabellart:scroll:v1:";
const READY_ROUTES = new Set(["/", "/gallery"]);

function readSnapshot(key) {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;

    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function writeSnapshot(key, value) {
  try {
    window.sessionStorage.setItem(
      STORAGE_PREFIX + key,
      JSON.stringify(value)
    );
  } catch {
    // Scroll recovery must never interfere with navigation.
  }
}

function saveCurrentPosition(key, pathname, position) {
  if (!key || position?.key !== key) return;

  const previous = readSnapshot(key) || {};
  const scrollX = Number(position.scrollX) || 0;
  const scrollY = Number(position.scrollY) || 0;

  const moved =
    Number.isFinite(Number(previous.scrollY)) &&
    Math.abs(Number(previous.scrollY) - scrollY) > 2;

  const next = {
    ...previous,
    pathname,
    scrollX,
    scrollY,
    updatedAt: Date.now()
  };

  // A manual scroll means the previous clicked artwork is no longer
  // the best anchor for a future return.
  if (moved) {
    delete next.productId;
    delete next.viewportTop;
  }

  writeSnapshot(key, next);
}

function rememberProductClick(key, pathname, card) {
  const productId = card.getAttribute("data-product-card-id");
  if (!productId) return;

  const rect = card.getBoundingClientRect();

  writeSnapshot(key, {
    ...(readSnapshot(key) || {}),
    pathname,
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    productId,
    viewportTop: rect.top,
    updatedAt: Date.now()
  });
}

function restoreSnapshot(snapshot) {
  let targetY = Math.max(0, Number(snapshot.scrollY) || 0);

  if (
    snapshot.productId != null &&
    Number.isFinite(Number(snapshot.viewportTop))
  ) {
    const cards = Array.from(
      document.querySelectorAll("[data-product-card-id]")
    );

    const matches = cards.filter(
      card =>
        card.getAttribute("data-product-card-id") ===
        String(snapshot.productId)
    );

    if (matches.length) {
      // A featured artwork can also appear in the main grid.
      // Choose the matching card nearest to its former screen position.
      const target = matches.reduce((best, card) => {
        const distance = Math.abs(
          card.getBoundingClientRect().top - Number(snapshot.viewportTop)
        );

        return !best || distance < best.distance
          ? { card, distance }
          : best;
      }, null);

      if (target) {
        targetY = Math.max(
          0,
          window.scrollY +
            target.card.getBoundingClientRect().top -
            Number(snapshot.viewportTop)
        );
      }
    }
  }

  const scrollX = Number(snapshot.scrollX) || 0;
  window.scrollTo(scrollX, targetY);
  return { scrollX, scrollY: targetY };
}

export default function ScrollRestorationManager() {
  const location = useLocation();
  const navigationType = useNavigationType();

  // A null key lets the initial POP pass through the same restoration
  // path as a browser back/forward navigation. The real key is installed
  // before any asynchronous restoration work is scheduled.
  const activeLocationRef = useRef({
    key: null,
    pathname: location.pathname
  });
  const pendingProductNavigationRef = useRef(null);
  const scrollFrameRef = useRef(0);
  const lastScrollPositionRef = useRef({
    key: location.key,
    pathname: location.pathname,
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0
  });

  // Let this component, rather than the browser's premature native
  // restoration, control positions after asynchronous page loading.
  useEffect(() => {
    const previous = window.history.scrollRestoration;

    try {
      window.history.scrollRestoration = "manual";
    } catch {
      // Some embedded browsers may not expose this property.
    }

    return () => {
      try {
        window.history.scrollRestoration = previous;
      } catch {}
    };
  }, []);

  // Save the active history entry while scrolling and immediately
  // remember the exact artwork card when its product link is clicked.
  useEffect(() => {
    const save = () => {
      const active = activeLocationRef.current;
      const pending = pendingProductNavigationRef.current;
      if (pending?.key === active.key) {
        if (Date.now() - pending.timestamp < 2000) return;
        pendingProductNavigationRef.current = null;
      }

      const position = lastScrollPositionRef.current;
      if (position?.key !== active.key) return;
      saveCurrentPosition(active.key, active.pathname, position);
    };

    const onScroll = () => {
      const active = activeLocationRef.current;
      lastScrollPositionRef.current = {
        key: active.key,
        pathname: active.pathname,
        scrollX: window.scrollX || 0,
        scrollY: window.scrollY || 0
      };

      if (scrollFrameRef.current) return;
      const scheduledKey = active.key;

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = 0;
        // A frame queued by the previous route must never save into the
        // history entry that became active after navigation.
        if (activeLocationRef.current.key !== scheduledKey) return;
        save();
      });
    };

    const onProductClick = event => {
      const target =
        event.target?.nodeType === 1
          ? event.target
          : event.target?.parentElement;

      if (!target?.closest) return;

      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) return;
      const link = target.closest('a[href^="/product/"][data-product-card-id]');
      if (!link) return;
      const active = activeLocationRef.current;
      const productId = link.getAttribute("data-product-card-id");
      if (!productId) return;
      pendingProductNavigationRef.current = {
        key: active.key,
        timestamp: Date.now()
      };
      rememberProductClick(active.key, active.pathname, link);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    document.addEventListener("pointerdown", onProductClick, true);
    document.addEventListener("click", onProductClick, true);

    return () => {
      if (scrollFrameRef.current) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = 0;
      }
      save();

      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("pointerdown", onProductClick, true);
      document.removeEventListener("click", onProductClick, true);
    };
  }, []);

  // POP restores the previous entry. PUSH starts at the top of the
  // new page, preserving the conventional navigation behavior.
  useLayoutEffect(() => {
    const previous = activeLocationRef.current;

    if (previous.key === location.key) return;

    const pending = pendingProductNavigationRef.current;
    const previousPosition = lastScrollPositionRef.current;
    const openingClickedProduct =
      pending?.key === previous.key &&
      location.pathname.startsWith("/product/");
    if (
      !openingClickedProduct &&
      previousPosition?.key === previous.key
    ) {
      // useLayoutEffect runs after the destination route has committed.
      // Persist the position captured by the old route's scroll listener.
      saveCurrentPosition(previous.key, previous.pathname, previousPosition);
    }

    // Cancel the old entry's pending frame before changing activeLocationRef.
    if (scrollFrameRef.current) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = 0;
    }

    if (pending?.key === previous.key) {
      pendingProductNavigationRef.current = null;
    }

    activeLocationRef.current = {
      key: location.key,
      pathname: location.pathname
    };

    const carriedPosition =
      navigationType === "REPLACE" && previousPosition?.key === previous.key
        ? previousPosition
        : null;
    lastScrollPositionRef.current = {
      key: location.key,
      pathname: location.pathname,
      scrollX: carriedPosition?.scrollX ?? 0,
      scrollY: carriedPosition?.scrollY ?? 0
    };

    if (navigationType === "POP") {
      const snapshot = readSnapshot(location.key);
      if (!snapshot) return;

      lastScrollPositionRef.current = {
        key: location.key,
        pathname: location.pathname,
        scrollX: Number(snapshot.scrollX) || 0,
        scrollY: Number(snapshot.scrollY) || 0
      };

      const rememberRestoredPosition = () => {
        const restored = restoreSnapshot(snapshot);
        lastScrollPositionRef.current = {
          key: location.key,
          pathname: location.pathname,
          ...restored
        };
      };

      const needsPageReady = READY_ROUTES.has(location.pathname);

      let cancelled = false;
      let observer = null;
      let frameOne = 0;
      let frameTwo = 0;
      let fallbackTimer = 0;
      let maxWaitTimer = 0;
      let maxWaitExpired = false;
      let scheduled = false;

      const cleanup = () => {
        cancelled = true;
        observer?.disconnect();

        if (frameOne) window.cancelAnimationFrame(frameOne);
        if (frameTwo) window.cancelAnimationFrame(frameTwo);
        if (fallbackTimer) window.clearTimeout(fallbackTimer);
        if (maxWaitTimer) window.clearTimeout(maxWaitTimer);
      };

      const scheduleRestore = () => {
        if (cancelled || scheduled) return;

        const ready =
          !needsPageReady ||
          document.querySelector(
            '[data-scroll-restoration-ready="true"]'
          );

        if (!ready) return;

        scheduled = true;
        observer?.disconnect();
        if (fallbackTimer) {
          window.clearTimeout(fallbackTimer);
          fallbackTimer = 0;
        }
        if (maxWaitTimer) {
          window.clearTimeout(maxWaitTimer);
          maxWaitTimer = 0;
        }

        frameOne = window.requestAnimationFrame(() => {
          frameTwo = window.requestAnimationFrame(() => {
            if (!cancelled) rememberRestoredPosition();
          });
        });
      };

      if (needsPageReady) {
        maxWaitTimer = window.setTimeout(() => {
          maxWaitTimer = 0;
          maxWaitExpired = true;
          observer?.disconnect();
          if (fallbackTimer) {
            window.clearTimeout(fallbackTimer);
            fallbackTimer = 0;
          }
          if (cancelled || scheduled) return;
          scheduled = true;
          rememberRestoredPosition();
        }, 5000);
      }

      if (needsPageReady && "MutationObserver" in window) {
        observer = new MutationObserver(scheduleRestore);

        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-scroll-restoration-ready"]
        });
      } else if (needsPageReady) {
        const waitForReady = () => {
          if (cancelled) return;

          if (
            document.querySelector(
              '[data-scroll-restoration-ready="true"]'
            )
          ) {
            scheduleRestore();
          } else if (!maxWaitExpired) {
            fallbackTimer = window.setTimeout(waitForReady, 60);
          }
        };

        waitForReady();
      }

      scheduleRestore();
      return cleanup;
    }

    if (navigationType === "PUSH") {
      if (location.hash) {
        // A malformed percent-escape must not break an otherwise valid route.
        let id = location.hash.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          // Fall back to the literal fragment; it may still be a valid DOM id.
        }

        window.requestAnimationFrame(() => {
          if (activeLocationRef.current.key !== location.key) return;
          document.getElementById(id)?.scrollIntoView();
          lastScrollPositionRef.current = {
            key: location.key,
            pathname: location.pathname,
            scrollX: window.scrollX || 0,
            scrollY: window.scrollY || 0
          };
        });
      } else {
        window.scrollTo(0, 0);
        lastScrollPositionRef.current = {
          key: location.key,
          pathname: location.pathname,
          scrollX: 0,
          scrollY: 0
        };
      }
    }

    return undefined;
  }, [
    location.key,
    location.pathname,
    location.hash,
    navigationType
  ]);

  return null;
}
