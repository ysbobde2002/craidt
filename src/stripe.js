import { config, stripeConfigured } from "./config.js";

const STRIPE_API = "https://api.stripe.com/v1";

function last4FromPm(pm) {
  if (String(pm).includes("mastercard")) return "4444";
  return "4242";
}

export function stripeWallet() {
  const pm = config.stripe.testPaymentMethod;
  return {
    provider: "stripe",
    mode: "test",
    configured: stripeConfigured(),
    cardBrand: String(pm).includes("mastercard") ? "mastercard" : "visa",
    cardLast4: last4FromPm(pm),
    paymentMethodId: pm,
  };
}

async function stripeForm(path, params, secretKey) {
  const body = new URLSearchParams(params);
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Stripe ${res.status}`);
  }
  return data;
}

/**
 * ACP-demo style test charge: confirm pm_card_visa (4242) on the platform key.
 * Optional second PaymentIntent on STRIPE_SELLER_SECRET_KEY as a seller receipt.
 */
export async function chargePurchase({ amountCents, offerId, offerName }) {
  const wallet = stripeWallet();
  if (!stripeConfigured()) {
    return {
      status: "simulated",
      mode: "demo",
      provider: "stripe",
      amountCents,
      currency: "usd",
      card: { brand: wallet.cardBrand, last4: wallet.cardLast4 },
      paymentIntentId: `pi_demo_${offerId}`.slice(0, 40),
      dashboardUrl: null,
      detail: "No STRIPE_SECRET_KEY — simulated test charge. Add sk_test_… to .env to hit Stripe.",
    };
  }

  const params = {
    amount: String(amountCents),
    currency: "usd",
    payment_method: wallet.paymentMethodId,
    confirm: "true",
    "automatic_payment_methods[enabled]": "true",
    "automatic_payment_methods[allow_redirects]": "never",
    "metadata[offerId]": String(offerId),
    "metadata[offerName]": String(offerName || "").slice(0, 200),
    "metadata[demo]": "craidt",
  };
  if (config.stripe.testCustomerId) params.customer = config.stripe.testCustomerId;
  if (config.stripe.sellerAccountId.startsWith("acct_")) {
    params["transfer_data[destination]"] = config.stripe.sellerAccountId;
  }

  const intent = await stripeForm("/payment_intents", params, config.stripe.secretKey);
  if (!["succeeded", "requires_capture"].includes(intent.status)) {
    throw new Error(`Stripe PaymentIntent status: ${intent.status}`);
  }

  let sellerReceipt = null;
  if (config.stripe.sellerSecretKey.startsWith("sk_test_")) {
    try {
      sellerReceipt = await stripeForm(
        "/payment_intents",
        {
          amount: String(amountCents),
          currency: "usd",
          payment_method: "pm_card_visa",
          confirm: "true",
          "automatic_payment_methods[enabled]": "true",
          "automatic_payment_methods[allow_redirects]": "never",
          "metadata[type]": "seller_receipt",
          "metadata[buyerPaymentIntentId]": intent.id,
        },
        config.stripe.sellerSecretKey,
      );
    } catch (err) {
      sellerReceipt = { error: err.message };
    }
  }

  return {
    status: "paid",
    mode: "test",
    provider: "stripe",
    amountCents,
    currency: "usd",
    card: { brand: wallet.cardBrand, last4: wallet.cardLast4 },
    paymentIntentId: intent.id,
    chargeId: typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id,
    dashboardUrl: `https://dashboard.stripe.com/test/payments/${intent.id}`,
    sellerPaymentIntentId: sellerReceipt?.id ?? null,
    sellerReceiptError: sellerReceipt?.error ?? null,
  };
}
