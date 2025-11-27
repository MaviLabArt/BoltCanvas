import cookieSession from "cookie-session";
import cors from "cors";
import morgan from "morgan";

export function makeCors(origin) {
  // Allow a boolean or function in production, string in dev. Credentials are needed for admin cookie.
  return cors({
    origin,
    credentials: true
  });
}

export function sessions(secret) {
  const baseOpts = {
    name: "lasess",
    secret,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 3600 * 1000
  };
  const secureSession = cookieSession({ ...baseOpts, secure: true });
  const insecureSession = cookieSession({ ...baseOpts, secure: false });

  return function sessionMiddleware(req, res, next) {
    const host = String(req.headers.host || "").split(":")[0];
    const isLocalHost = host === "127.0.0.1" || host === "localhost";
    const prod = process.env.NODE_ENV === "production";

    // In production, use secure cookies for real hosts, but allow
    // plain HTTP cookies when accessing via 127.0.0.1 / localhost.
    if (prod && !isLocalHost) {
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
