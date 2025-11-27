import { Webhook } from "svix";

export function verifySvixSignature({ secret, payload, headers }) {
  if (!secret) throw new Error("SVIX secret not configured");
  if (!payload) throw new Error("Missing webhook payload");

  const wh = new Webhook(secret);
  // Headers may be a Node.js IncomingHttpHeaders object (lowercase keys)
  const verified = wh.verify(payload, headers);
  return verified;
}
