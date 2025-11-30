import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn(async () => ({ message: Buffer.from("raw") }));
const createTransport = vi.fn(() => ({ sendMail }));

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
  }
}));

async function loadEmail() {
  process.env.SMTP_ENABLED = "true";
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

    expect(createTransport).toHaveBeenCalledTimes(2); // builder + smtp for first call
    expect(sendMail).toHaveBeenCalledTimes(2); // builder + smtp
  });
});
