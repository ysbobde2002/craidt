import { getAuction } from "./auction.js";
import { netHumanCostCents, splitIncentiveCents } from "./cashback.js";
import { chargePurchase } from "./stripe.js";
import { payMerchantIncentive, recordBaseIncentive } from "./base.js";
import { submitGiveFeedback } from "./feedback.js";

function selectedOffer(session, productId) {
  if (!session) throw new Error("auction session not found");
  const pick = session.bids.find((b) => b.productId === productId);
  if (!pick) throw new Error("product not in auction");
  const bidCents = Math.round(Number(pick.bidUsdc) * 100);
  const split = splitIncentiveCents(bidCents);
  return { pick, bidCents, split };
}

function publicPick(pick) {
  return {
    productId: pick.productId,
    title: pick.title,
    merchantName: pick.merchantName,
    priceCents: pick.priceCents,
    bidUsdc: pick.bidUsdc,
  };
}

function economics({ pick, bidCents, split, confirmedCashbackCents }) {
  return {
    bidCents,
    userCashbackCents: split.userCashbackCents,
    agentShareCents: split.agentShareCents,
    confirmedCashbackCents,
    netHumanCostCents: netHumanCostCents(pick.priceCents, confirmedCashbackCents),
    split: "60/40",
  };
}

/**
 * Fail-closed settlement:
 *   1. Stripe must succeed for the selected offer
 *   2. Receipt is returned
 *   3. Caller then pushes the merchant bid as USDC to the buyer agent
 */
export async function settlePurchase({ sessionId, productId }) {
  const session = getAuction(sessionId);
  const { pick, bidCents, split } = selectedOffer(session, productId);

  const stripe = await chargePurchase({
    amountCents: pick.priceCents,
    offerId: pick.productId,
    offerName: pick.title,
  });

  if (stripe.status !== "paid" && stripe.status !== "simulated") {
    throw new Error(stripe.detail || "Stripe purchase failed");
  }

  session.settledProductId = pick.productId;
  session.stripeReceipt = stripe;

  const base = recordBaseIncentive({
    bidCents,
    userCashbackCents: split.userCashbackCents,
    agentShareCents: split.agentShareCents,
    offerId: pick.productId,
  });

  return {
    pick: publicPick(pick),
    stripe,
    base,
    economics: economics({ pick, bidCents, split, confirmedCashbackCents: 0 }),
  };
}

/** After Stripe receipt: merchant Wm → buyer agent Wa1 USDC for the winning bid. */
export async function pushPurchaseIncentive({ sessionId, productId, live = true }) {
  const session = getAuction(sessionId);
  const { pick, bidCents, split } = selectedOffer(session, productId);

  if (session.settledProductId !== pick.productId) {
    throw new Error("Stripe receipt missing for this offer");
  }
  if (session.incentive) return session.incentive;

  const base = await payMerchantIncentive({
    bidCents,
    userCashbackCents: split.userCashbackCents,
    agentShareCents: split.agentShareCents,
    offerId: pick.productId,
    live,
  });
  const confirmedCashbackCents = base.confirmed ? split.userCashbackCents : 0;
  const result = {
    pick: publicPick(pick),
    stripe: session.stripeReceipt,
    base,
    economics: economics({ pick, bidCents, split, confirmedCashbackCents }),
  };
  if (base.confirmed) session.incentive = result;
  return result;
}

/** After payout: merchant client writes ERC-8004 giveFeedback for the buyer agent. */
export async function submitPurchaseFeedback({ sessionId, productId, stars, live = true }) {
  const session = getAuction(sessionId);
  const { pick, bidCents } = selectedOffer(session, productId);
  if (session.settledProductId !== pick.productId) {
    throw new Error("Stripe receipt missing for this offer");
  }
  if (session.feedback) return session.feedback;

  const score = Math.max(0, Math.min(100, Math.round(Number(stars) || 0) * 20));
  const stripe = session.stripeReceipt || {};
  const incentive = session.incentive?.base || {};
  const result = await submitGiveFeedback({
    score,
    stars: Number(stars) || null,
    payment: {
      offerId: pick.productId,
      paymentIntentId: stripe.paymentIntentId,
      amountCents: pick.priceCents,
      bidCents,
      txHash: incentive.txHash,
      provider: incentive.txHash ? "x402" : stripe.provider,
    },
    live,
  });
  if (result.submitted) session.feedback = result;
  return result;
}
