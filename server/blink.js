// server/blink.js
import fetch from "node-fetch";

const DEFAULT_URL = "https://api.blink.sv/graphql";

// We keep expiry in *seconds* on our side.
// Set BLINK_INVOICE_EXPIRES_IN=900 for 15 minutes, for example.
const DEFAULT_EXPIRES_IN_SECONDS = Number(process.env.BLINK_INVOICE_EXPIRES_IN || 900);

function headers(apiKey) {
  // Make sure you already switched to X-API-KEY (not Authorization)
  return {
    "content-type": "application/json",
    "X-API-KEY": apiKey,
  };
}

export async function gqlRequest({ url, apiKey, query, variables }) {
  const res = await fetch(url || DEFAULT_URL, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Blink HTTP ${res.status} ${text}`);
  }
  const body = await res.json();
  if (body.errors) {
    const msg = body.errors.map((e) => e.message).join("; ");
    throw new Error(`Blink GraphQL error: ${msg}`);
  }
  return body.data;
}

// ✅ resolve BTC wallet id by listing wallets and picking BTC
export async function ensureBtcWalletId({ url, apiKey, explicitWalletId }) {
  if (explicitWalletId) return explicitWalletId;

  const query = `
    query MyWallets {
      me {
        defaultAccount {
          wallets {
            id
            walletCurrency
          }
        }
      }
    }
  `;
  const data = await gqlRequest({ url, apiKey, query });
  const wallets = data?.me?.defaultAccount?.wallets || [];
  const btc = wallets.find((w) => w.walletCurrency === "BTC");
  if (!btc?.id) {
    throw new Error(
      "No BTC wallet found. Set BLINK_BTC_WALLET_ID or ensure your account has a BTC wallet."
    );
  }
  return btc.id;
}

// Create a BTC invoice in satoshis.
// We accept {expiresIn} in *seconds*; if omitted, use DEFAULT_EXPIRES_IN_SECONDS.
// Blink's API interprets `expiresIn` as *minutes* (based on your observed 900 -> 900 minutes),
// so we convert seconds -> minutes before sending.
export async function createInvoiceSats({
  url,
  apiKey,
  walletId,
  amount,
  memo,
  expiresIn, // seconds (optional override)
}) {
  const query = `
    mutation LnInvoiceCreate($input: LnInvoiceCreateInput!) {
      lnInvoiceCreate(input: $input) {
        invoice {
          paymentRequest
          paymentHash
          satoshis
        }
        errors { message }
      }
    }
  `;

  // Compute effective expiry in our *seconds* unit.
  const effectiveSeconds =
    Number.isFinite(Number(expiresIn)) && Number(expiresIn) > 0
      ? Number(expiresIn)
      : DEFAULT_EXPIRES_IN_SECONDS;

  // Convert to *minutes* for the Blink API to avoid the 900-minutes issue.
  const expiresInMinutes = Math.max(1, Math.round(effectiveSeconds / 60));

  const variables = {
    input: {
      walletId,
      amount,
      memo: memo || null,
      expiresIn: expiresInMinutes, // Blink expects minutes
    },
  };

  const data = await gqlRequest({ url, apiKey, query, variables });
  const out = data?.lnInvoiceCreate;
  if (!out || out.errors?.length) {
    const m = out?.errors?.map((e) => e.message).join("; ") || "Unknown error";
    throw new Error("lnInvoiceCreate failed: " + m);
    }
  return out.invoice;
}

export async function invoiceStatus({ url, apiKey, paymentHash }) {
  const query = `
    query LnInvoicePaymentStatusByHash($input: LnInvoicePaymentStatusByHashInput!) {
      lnInvoicePaymentStatusByHash(input: $input) { status }
    }
  `;
  const variables = { input: { paymentHash } };
  const data = await gqlRequest({ url, apiKey, query, variables });
  return data?.lnInvoicePaymentStatusByHash?.status;
}
