export function createAdminLoginLimiter({
  windowMs = 15 * 60 * 1000,
  maxAttempts = 5,
  blockMs = 15 * 60 * 1000,
  now = Date.now,
  getClientKey = (req) => req.ip || req.socket?.remoteAddress || "unknown",
} = {}) {
  const attempts = new Map();

  function keyFor(req) {
    return String(getClientKey(req) || "unknown");
  }

  function prune(currentTime) {
    for (const [key, state] of attempts) {
      const windowExpired = currentTime >= state.windowStart + windowMs;
      const blockExpired = !state.blockedUntil || currentTime >= state.blockedUntil;

      if (windowExpired && blockExpired) {
        attempts.delete(key);
      }
    }
  }

  function middleware(req, res, next) {
    const currentTime = now();
    prune(currentTime);

    const state = attempts.get(keyFor(req));

    if (state?.blockedUntil > currentTime) {
      const retryAfter = Math.max(
        1,
        Math.ceil((state.blockedUntil - currentTime) / 1000)
      );

      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        ok: false,
        error: "Too many login attempts. Try again later.",
      });
    }

    next();
  }

  function recordFailure(req) {
    const currentTime = now();
    const key = keyFor(req);
    let state = attempts.get(key);

    if (
      !state ||
      currentTime >= state.windowStart + windowMs ||
      (state.blockedUntil && currentTime >= state.blockedUntil)
    ) {
      state = { failures: 0, windowStart: currentTime, blockedUntil: 0 };
      attempts.set(key, state);
    }

    state.failures += 1;

    if (state.failures >= maxAttempts) {
      state.blockedUntil = currentTime + blockMs;
    }
  }

  function reset(req) {
    attempts.delete(keyFor(req));
  }

  return { middleware, recordFailure, reset };
}
