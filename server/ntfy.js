// Share concurrent deliveries and remember only successfully delivered messages.
export function createNtfySender({ url, topic, user, password, priority, fetchImpl = fetch }) {
  const pending = new Map();
  const delivered = new Map();
  return async function send({ key, title, tags, body }) {
    if (!topic) return false;
    if (delivered.has(key)) return true;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      try {
        const headers = { "Content-Type": "application/json" };
        if (user || password) headers.Authorization = `Basic ${Buffer.from(`${user || ""}:${password || ""}`).toString("base64")}`;
        const priorities = { min: 1, low: 2, default: 3, high: 4, max: 5, urgent: 5 };
        const response = await fetchImpl(url, {
          method: "POST", headers, signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ topic, title, message: body, tags: tags.split(","), priority: priorities[priority] || Number(priority) || 3 })
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        delivered.set(key, true);
        if (delivered.size > 1000) delivered.delete(delivered.keys().next().value);
        return true;
      } catch (error) {
        console.warn("[ntfy] delivery failed:", error?.message || error);
        return false;
      }
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  };
}
