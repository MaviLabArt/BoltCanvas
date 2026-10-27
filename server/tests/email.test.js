import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn(async () => ({ message: Buffer.from("raw") }));
const createTransport = vi.fn(() => ({ sendMail }));

// Registro SQLite simulato: nessuna email reale viene inviata dai test.
const notificationStates = new Map();
const notificationKey = (id, status) => `${String(id)}|${String(status).toUpperCase()}`;

const claimNotification = vi.fn((id, status, options = {}) => {
  const key = notificationKey(id, status);
  const current = notificationStates.get(key);

  if (!current) {
    if (!options.allowCreate) return false;
    notificationStates.set(key, "sending");
    return true;
  }
  if (current === "sent" || current === "sending") return false;

  notificationStates.set(key, "sending");
  return true;
});

const markNotificationSent = vi.fn((id, status) => {
  const key = notificationKey(id, status);
  notificationStates.set(key, "sent");
  return true;
});

const markNotificationFailed = vi.fn((id, status) => {
  const key = notificationKey(id, status);
  if (notificationStates.get(key) === "sending") {
    notificationStates.set(key, "failed");
  }
  return true;
});

vi.mock("nodemailer", () => ({ default: { createTransport }, createTransport }));
vi.mock("imapflow", () => ({ ImapFlow: class { async connect() {} async logout() {} async append() {} async mailboxOpen() {} async mailboxCreate() {} async list() { return []; } } }));
vi.mock("../db.js", () => ({
  Settings: {
    getAll: vi.fn(() => ({
      storeName: "Test Shop",
      smtpSignature: "Thanks!",
      notifyEmailSubject_PAID: "",
      notifyEmailBody_PAID: ""
    }))
  },
  OrderStatusEmails: {
    claim: claimNotification,
    markSent: markNotificationSent,
    markFailed: markNotificationFailed
  }
}));

async function loadEmail() {
  process.env.SMTP_ENABLED = "true";
  process.env.SMTP_SAVE_TO_SENT = "false";
  process.env.SMTP_FROM_ADDRESS = "shop@example.com";
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_USER = "";
  process.env.SMTP_PASS = "";
  process.env.SMTP_ENVELOPE_FROM = "";
  process.env.SMTP_REPLY_TO = "";
  process.env.IMAP_HOST = "";
  process.env.IMAP_USER = "";
  process.env.IMAP_PASS = "";
  vi.resetModules();
  return import("../email.js");
}

describe("email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notificationStates.clear();
  });

  it("sends order status email and respects deduplication", async () => {
    const email = await loadEmail();
    const order = {
      id: "o1",
      totalSats: 1234,
      subtotalSats: 1200,
      shippingSats: 34,
      status: "PENDING",
      contactEmail: "buyer@example.com",
      address: "123 St",
      city: "City",
      province: "TS",
      country: "IT",
      contactPhone: "123",
      createdAt: Date.now(),
      items: [{ title: "Art" }]
    };

    await email.sendOrderStatusEmail(order, "PAID");
    await email.sendOrderStatusEmail(order, "PAID");

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("allows retry after SMTP failure and deduplicates successful delivery", async () => {
    const email = await loadEmail();
    const order = { id: "retry", contactEmail: "buyer@example.com", items: [] };
    sendMail.mockRejectedValueOnce(new Error("SMTP unavailable"));
    await email.sendOrderStatusEmail(order, "PAID");
    await email.sendOrderStatusEmail(order, "PAID");
    await email.sendOrderStatusEmail(order, "PAID");
    expect(sendMail).toHaveBeenCalledTimes(2);
  });


  it("deduplicates successful delivery across email-module reloads", async () => {
    let email = await loadEmail();
    const order = { id: "persisted", contactEmail: "buyer@example.com", items: [] };

    await email.sendOrderStatusEmail(order, "PAID");

    // Simula un riavvio del modulo: il registro persistente resta presente.
    email = await loadEmail();
    await email.sendOrderStatusEmail(order, "PAID");

    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("suppresses concurrent sends for the same order and status", async () => {
    const email = await loadEmail();
    const order = { id: "concurrent", contactEmail: "buyer@example.com", items: [] };
    await Promise.all([email.sendOrderStatusEmail(order, "PAID"), email.sendOrderStatusEmail(order, "PAID")]);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
