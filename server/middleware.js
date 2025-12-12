import cookieSession from "cookie-session";
import cors from "cors";
import morgan from "morgan";

// Extremely permissive CORS: reflect any Origin and allow credentials.
export function makeCors() {
  return cors({
    origin: (origin, cb) => cb(null, origin || "*"),
    credentials: true
  });
}

export function sessions(secret) {
  const prod = process.env.NODE_ENV === "production";

  // For localhost, use lax sameSite to avoid cookie rejection
  const baseOpts = {
    name: "lasess",
    secret,
    httpOnly: true,
    sameSite: "lax", // use lax for better localhost compatibility
    path: "/",
    maxAge: 7 * 24 * 3600 * 1000
  };

  const secureSession = cookieSession({ ...baseOpts, secure: true });
  const insecureSession = cookieSession({ ...baseOpts, secure: false });

  return function sessionMiddleware(req, res, next) {
    const currentHost = String(req.headers.host || "").split(":")[0];
    const currentIsLocalHost = currentHost === "127.0.0.1" || currentHost === "localhost";

    // Keep secure cookies on real hosts; allow insecure for local dev.
    if (prod && !currentIsLocalHost) {
      return secureSession(req, res, next);
    }
    return insecureSession(req, res, next);
  };
}

export function logger() {
  return morgan("dev");
}

export function requireAdmin(req, res, next) {
  if (!req.session?.admin) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
