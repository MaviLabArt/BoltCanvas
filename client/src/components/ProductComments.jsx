import React, { useEffect, useMemo, useState } from "react";
import { fetchProductComments, subscribeToProductComments } from "../nostr/read-comments.js";
import { fetchProfilesForEvents } from "../nostr/profiles.js";
import { normalizeComments } from "../nostr/normalize.js";
import { publishProductComment } from "../nostr/publish-comment.js";
import { useSettings } from "../store/settings.jsx";
import { isEventBlocked, makeBlockedSets, nostrCommentsEnabled } from "../nostr/config.js";
import { useNostr } from "../providers/NostrProvider.jsx";

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - ts * 1000);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function extractImageFromTags(tags) {
  for (const tag of tags || []) {
    if (Array.isArray(tag) && tag[0] === "imeta") {
      const urlEntry = tag.find((t) => typeof t === "string" && t.startsWith("url "));
      if (urlEntry) return urlEntry.slice(4);
    }
  }
  return "";
}

function parseContent(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const known = ["Product:", "Store:", "URL:", "Rating:", "Image:"];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      break;
    }
    const isHeader = known.some((p) => line.startsWith(p));
    if (!isHeader) {
      break;
    }
  }
  const comment = lines.slice(i).join("\n").trim();
  // Best-effort: extract header image if present
  const headerImage = lines
    .map((l) => l.trim())
    .find((l) => l.startsWith("Image: "))?.slice("Image: ".length) || "";
  return { comment: comment || raw || "", headerImage };
}

function CommentCard({ comment }) {
  const name = comment.profile?.name || comment.shortNpub || "Someone";
  const avatar = comment.profile?.picture || "";
  const nip05 = comment.profile?.nip05 || "";
  const { comment: displayText, headerImage } = parseContent(comment.content);
  const tagImage = extractImageFromTags(comment.tags);
  const imageToShow = tagImage || headerImage;
  return (
    <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-4 flex gap-3">
      <div className="h-10 w-10 rounded-full overflow-hidden bg-slate-800 ring-1 ring-white/10 flex items-center justify-center text-sm font-semibold">
        {avatar ? (
          <img src={avatar} alt={name} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <span>{name.slice(0, 2)}</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm text-white/70">
          <span className="font-medium text-white">{name}</span>
          {nip05 ? <span className="text-xs text-white/50">· {nip05}</span> : null}
          <span className="text-xs text-white/40 ml-auto">{timeAgo(comment.createdAt)}</span>
        </div>
        <p className="mt-2 text-sm text-white/80 whitespace-pre-wrap break-words">{displayText}</p>
        {imageToShow ? (
          <div className="mt-3">
            <img
              src={imageToShow}
              alt="Attached"
              className="w-full max-h-48 object-cover rounded-xl ring-1 ring-white/10"
              loading="lazy"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function ProductComments({ productId }) {
  const { pubkey: nostrPubkey, hasSigner } = useNostr();
  const { settings } = useSettings();
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const maxLen = 600;
  const [input, setInput] = useState("");
  const relays = useMemo(() => settings?.nostrRelays, [settings]);
  const storePubkey = useMemo(() => String(settings?.nostrShopPubkey || "").toLowerCase(), [settings]);
  const enabled = nostrCommentsEnabled(settings) && !!storePubkey;
  const blocked = useMemo(() => makeBlockedSets(settings), [settings]);
  const cancelledRef = React.useRef(false);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = null;
    cancelledRef.current = false;

    async function load() {
      if (!settings) {
        return;
      }
      if (!enabled) {
        setComments([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const events = await fetchProductComments({ productId, relays, storePubkey, limit: 40 });
        const filtered = events.filter((ev) => !isEventBlocked(ev, blocked));
        const profiles = await fetchProfilesForEvents(filtered, relays);
        const normalized = normalizeComments(filtered, profiles);
        if (!cancelled) setComments(normalized);
      } catch (err) {
        console.warn("[comments] load failed", err);
      } finally {
        if (!cancelled) setLoading(false);
      }

      unsubscribe = subscribeToProductComments({
        productId,
        relays,
        storePubkey,
        since: Math.floor(Date.now() / 1000),
        onEvent: (ev) => {
          if (isEventBlocked(ev, blocked)) return;
          (async () => {
            try {
              const profiles = await fetchProfilesForEvents([ev], relays);
              if (cancelledRef.current) return;
              setComments((prev) => {
                if (prev.some((c) => c.id === ev.id)) return prev;
                const normalized = normalizeComments([ev], profiles);
                return [normalized[0], ...prev].slice(0, 60);
              });
            } catch {
              // ignore profile fetch errors; still add comment
              if (cancelledRef.current) return;
              setComments((prev) => {
                if (prev.some((c) => c.id === ev.id)) return prev;
                const normalized = normalizeComments([ev], {});
                return [normalized[0], ...prev].slice(0, 60);
              });
            }
          })();
        }
      });
    }

    load();
    return () => {
      cancelled = true;
      cancelledRef.current = true;
      if (unsubscribe) unsubscribe();
    };
  }, [productId, relays, storePubkey, enabled, blocked, settings]);

  if (!enabled) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!hasSigner || !nostrPubkey) {
      alert("Connect a Nostr signer to post");
      return;
    }
    try {
      await publishProductComment({
        content: input,
        productId,
        relays,
        storePubkey
      });
      setInput("");
    } catch (err) {
      alert(err?.message || "Failed to post comment");
    }
  };

  const canPost = hasSigner && !!nostrPubkey;

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold">Comment through NOSTR</h3>
        {!canPost && (
          <span className="text-xs text-white/60">Login with Nostr to post</span>
        )}
      </div>

      <div className="rounded-2xl bg-slate-950/80 ring-1 ring-white/10 p-3 sm:p-4 shadow-[0_10px_40px_rgba(0,0,0,0.25)]">
        <form onSubmit={handleSubmit} className="space-y-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, maxLen))}
            maxLength={maxLen}
            placeholder={canPost ? "Share your thoughts… (text only, 600 chars max)" : "Connect Nostr in the header to leave a note."}
            className="w-full rounded-xl bg-slate-900 ring-1 ring-white/10 px-3 py-2 text-sm text-white placeholder:text-white/40 resize-y focus:outline-hidden focus:ring-2 focus:ring-indigo-400"
            rows={3}
            disabled={!canPost}
          />
          <div className="flex items-center justify-end text-xs text-white/70">
            <span className="mr-3">{maxLen - input.length} chars left</span>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!canPost || !input.trim()}
                className="px-3 py-2 rounded-xl bg-indigo-500/90 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-indigo-300 shadow-lg shadow-indigo-500/20"
              >
                Post
              </button>
            </div>
          </div>
        </form>
      </div>

      <div className="mt-4 space-y-3">
        {loading && (
          <div className="text-sm text-white/60">Loading comments…</div>
        )}
        {!loading && comments.length === 0 && (
          <div className="text-sm text-white/60">Be the first to leave a note.</div>
        )}
        {comments.map((c) => (
          <CommentCard key={c.id} comment={c} />
        ))}
      </div>
    </section>
  );
}
