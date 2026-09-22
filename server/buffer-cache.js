// LRU cache with a byte budget; concurrent requests share the same work.
export function createBufferCache(maxBytes = 16 * 1024 * 1024) {
  const cached = new Map();
  const pending = new Map();
  let bytes = 0;
  return async (key, produce) => {
    if (cached.has(key)) {
      const value = cached.get(key);
      cached.delete(key);
      cached.set(key, value);
      return value;
    }
    if (pending.has(key)) return pending.get(key);
    const task = Promise.resolve().then(produce).then((value) => {
      if (value.length <= maxBytes) {
        while (bytes + value.length > maxBytes && cached.size) {
          const oldest = cached.keys().next().value;
          bytes -= cached.get(oldest).length;
          cached.delete(oldest);
        }
        cached.set(key, value);
        bytes += value.length;
      }
      return value;
    });
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  };
}
