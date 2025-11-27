// server/email.js
// ESM module: SMTP send + optional IMAP "Save to Sent"
// Keeps best-effort idempotency to avoid double-sending the same status.

import "dotenv/config";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { Settings } from "./db.js";

const _sentKeys = new Map(); // key -> timestamp
const TTL = 10 * 60 * 1000; // 10 minutes

// Read-only mail transport config from environment (signature is from DB)
const MAIL = {
  enabled: String(process.env.SMTP_ENABLED || "false").toLowerCase() === "true",
  host: process.env.SMTP_HOST || "",
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
  user: process.env.SMTP_USER || "",
  pass: process.env.SMTP_PASS || "",
  fromName: process.env.SMTP_FROM_NAME || "",
  fromAddress: process.env.SMTP_FROM_ADDRESS || "",
  envelopeFrom: process.env.SMTP_ENVELOPE_FROM || "",
  replyTo: process.env.SMTP_REPLY_TO || "",
  saveToSent: String(process.env.SMTP_SAVE_TO_SENT || "false").toLowerCase() === "true",
  imapHost: process.env.IMAP_HOST || "",
  imapPort: Number(process.env.IMAP_PORT || 993),
  imapSecure: String(process.env.IMAP_SECURE || "true").toLowerCase() === "true",
  imapUser: process.env.IMAP_USER || "",
  imapPass: process.env.IMAP_PASS || "",
  imapMailbox: process.env.IMAP_MAILBOX || "Sent",
};

function dedupKey(orderId, status) {
  return `order:${orderId}|status:${status}`;
}
function shouldSend(orderId, status) {
  const key = dedupKey(orderId, status);
  const now = Date.now();
  for (const [k, ts] of _sentKeys) if (now - ts > TTL) _sentKeys.delete(k);
  if (_sentKeys.has(key)) return false;
  _sentKeys.set(key, now);
  return true;
}

function label(status) {
  switch (String(status).toUpperCase()) {
    case "PAID": return "Payment received";
    case "PREPARATION": return "In preparation";
    case "SHIPPED": return "Shipped";
    default: return String(status).toUpperCase();
  }
}

const fmtSats = (n) => (Number(n) || 0).toLocaleString("en-US");
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Tiny mustache-ish renderer
function renderTemplate(tpl, ctx) {
  if (!tpl) return "";
  return String(tpl).replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, k) => (k in ctx ? String(ctx[k]) : ""));
}

function makeContext(order, status, s) {
  const address = [order.address || "", order.postalCode || "", order.country || ""]
    .filter(Boolean)
    .join(", ");
  const createdAt = new Date(order.createdAt || Date.now()).toLocaleString();
  return {
    storeName: s.storeName || "Your Shop Name",
    orderId: order.id,
    status: String(status).toUpperCase(),
    statusLabel: label(status),
    totalSats: fmtSats(order.totalSats),
    subtotalSats: fmtSats(order.subtotalSats),
    shippingSats: fmtSats(order.shippingSats),
    courier: order.courier || "",
    tracking: order.tracking || "",
    customerName: order.name || "",
    address,
    createdAt,
    paymentHash: order.paymentHash || ""
  };
}

function buildBodies(order, status, s) {
  // Render from customizable templates in Settings (DB); transport is env-based
  const ctx = makeContext(order, status, s);

  const subjTpl = s[`notifyEmailSubject_${String(status).toUpperCase()}`] || `[{{storeName}}] Order {{orderId}}, {{statusLabel}}`;
  const bodyTpl = s[`notifyEmailBody_${String(status).toUpperCase()}`];

  const subject = renderTemplate(subjTpl, ctx);

  let text;
  if (bodyTpl && bodyTpl.trim()) {
    text = renderTemplate(bodyTpl, ctx);
  } else {
    // Fallback to legacy content (kept intact)
    const lines = [];
    lines.push(`${ctx.storeName}, Order ${order.id}`);
    lines.push(`Status: ${ctx.statusLabel}`);
    lines.push("");
    if (String(status).toUpperCase() === "PAID") {
      lines.push("🎉 Thank you, we received your payment.");
      lines.push("We’re preparing your order and will send tracking as soon as it ships.");
    }
    if (String(status).toUpperCase() === "SHIPPED") {
      lines.push("Your order has shipped! 🚚");
      lines.push(`Courier: ${ctx.courier || "-"}`);
      lines.push(`Tracking: ${ctx.tracking || "-"}`);
    }
    lines.push("");
    lines.push(`Total: ${ctx.totalSats} sats`);
    text = lines.join("\n");
  }

  // Signature is configured from Admin Dashboard (DB), not env
  const textSig = String(s.smtpSignature || "").trim();
  if (textSig) {
    text += `\n\n${textSig}`;
  }

  // HTML mirror: simple conversion with escaping + <br>
  const htmlBody = esc(text).replace(/\n/g, "<br/>");
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
      ${htmlBody}
    </div>
  `.trim();

  return { subject, text, html };
}

// Robust IMAP append that discovers the "Sent" mailbox and retries on TRYCREATE
async function appendToSent(rawBuffer) {
  if (!rawBuffer || !MAIL.saveToSent) return;
  if (!MAIL.imapHost || !MAIL.imapUser || !MAIL.imapPass) return;

  const client = new ImapFlow({
    host: MAIL.imapHost,
    port: Number(MAIL.imapPort || 993),
    secure: MAIL.imapSecure === undefined ? true : !!MAIL.imapSecure,
    auth: {
      user: MAIL.imapUser,
      pass: MAIL.imapPass
    }
  });

  let sentMailbox = String(MAIL.imapMailbox || "").trim(); // env override, if any

  try {
    await client.connect();

    // 1) Discover special-use \Sent if not explicitly configured
    if (!sentMailbox) {
      try {
        for await (const box of client.list()) {
          if (box.specialUse === "\\Sent") {
            sentMailbox = box.path; // iCloud/Gmail/O365 pick-up
            break;
          }
        }
      } catch {}
    }

    // 2) Fallbacks if discovery did not find anything
    const fallbacks = [
      sentMailbox,
      "Sent Messages",
      "[Gmail]/Sent Mail",
      "Sent Items",
      "Sent"
    ].filter(Boolean);
    if (fallbacks.length === 0) fallbacks.push("Sent Messages");

    // 3) Open or create
    let opened = false;
    for (const candidate of fallbacks) {
      try {
        await client.mailboxOpen(candidate, { readOnly: false });
        sentMailbox = candidate;
        opened = true;
        break;
      } catch (err) {
        if (String(err?.response || err?.message || "").includes("TRYCREATE")) {
          sentMailbox = candidate;
          break;
        }
      }
    }
    if (!opened) {
      try { await client.mailboxCreate(sentMailbox); } catch {}
      try { await client.mailboxOpen(sentMailbox, { readOnly: false }); opened = true; } catch {}
      if (!opened) {
        for (const alt of ["Sent Messages", "[Gmail]/Sent Mail", "Sent Items", "Sent"]) {
          try { await client.mailboxOpen(alt, { readOnly: false }); sentMailbox = alt; opened = true; break; } catch {}
        }
      }
    }

    // 4) Append with flags & date
    try {
      await client.append(sentMailbox, rawBuffer, ["\\Seen"], new Date());
    } catch (err) {
      if (String(err?.response || err?.message || "").includes("TRYCREATE")) {
        await client.mailboxCreate(sentMailbox);
        await client.append(sentMailbox, rawBuffer, ["\\Seen"], new Date());
      } else {
        throw err;
      }
    }
  } finally {
    try { await client.logout(); } catch {}
  }
}

/**
 * Send a status email if SMTP is enabled and recipient exists.
 * Also (optionally) appends to the Sent mailbox via IMAP.
 */
export async function sendOrderStatusEmail(order, status) {
  try {
    if (!order || !order.contactEmail) return;

    // Templates + store metadata + signature come from DB; transport from env
    const s = Settings.getAll();
    if (!MAIL.enabled) return;

    if (!shouldSend(order.id, status)) return; // idempotency guard

    const fromAddr = String(MAIL.fromAddress || "").trim();
    if (!fromAddr) return; // can't send without visible From:

    const { subject, text, html } = buildBodies(order, status, s);

    // Build the message once into a Buffer so we can IMAP-append it later.
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const mail = {
      from: MAIL.fromName ? `"${MAIL.fromName}" <${fromAddr}>` : fromAddr,
      to: order.contactEmail,
      replyTo: MAIL.replyTo || undefined,
      subject,
      text,
      html,
      envelope: {
        from: MAIL.envelopeFrom || fromAddr,
        to: order.contactEmail
      }
    };
    const compiled = await builder.sendMail(mail);
    const raw = compiled?.message; // Buffer with CRLF line endings

    // Real SMTP send
    const transporter = nodemailer.createTransport({
      host: MAIL.host,
      port: Number(MAIL.port || 587),
      secure: !!MAIL.secure,
      auth: (MAIL.user || MAIL.pass) ? { user: MAIL.user, pass: MAIL.pass } : undefined
    });
    await transporter.sendMail(mail);

    // Optional: append to Sent via IMAP
    try { await appendToSent(raw); } catch (e) {
      console.warn("[email] appendToSent failed:", e?.message || e);
    }
  } catch (e) {
    console.warn("[email] sendOrderStatusEmail failed:", e?.message || e);
  }
}

export { label };
