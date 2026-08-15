import { getAuction } from "./auction.js";
import { netHumanCostCents, splitIncentiveCents } from "./cashback.js";
import { chargePurchase } from "./stripe.js";
import { recordBaseIncentive } from "./base.js";

/**
 * Fail-closed settlement:
 *   1. Stripe must succeed for the purchase
 *   2. Then merchant incentive splits 60/40 on Base Sepolia
 *   3. Cashback reduces Net Human Cost only after this confirmation
 */
export async function settlePurchase({ sessionId, productId }) {
  const session = getAuction(sessionId);
  if (!session) throw new Error("auction session not found");

  const pick = session.bids.find((b) => b.productId === productId);
  if (!pick) throw new Error("product not in auction");

  const bidCents = Math.round(Number(pick.bidUsdc) * 100);
  const split = splitIncentiveCents(bidCents);

  const stripe = await chargePurchase({
    amountCents: pick.priceCents,
    offerId: pick.productId,
    offerName: pick.title,
  });

  if (stripe.status !== "paid" && stripe.status !== "simulated") {
    throw new Error(stripe.detail || "Stripe purchase failed");
  }

  const base = recordBaseIncentive({
    bidCents,
    userCashbackCents: split.userCashbackCents,
    agentShareCents: split.agentShareCents,
    offerId: pick.productId,
  });

  const confirmedCashbackCents = split.userCashbackCents;
  const nhc = netHumanCostCents(pick.priceCents, confirmedCashbackCents);

  return {
    pick: {
      productId: pick.productId,
      title: pick.title,
      merchantName: pick.merchantName,
      priceCents: pick.priceCents,
    },
    stripe,
    base,
    economics: {
      bidCents,
      userCashbackCents: split.userCashbackCents,
      agentShareCents: split.agentShareCents,
      confirmedCashbackCents,
      netHumanCostCents: nhc,
      split: "60/40",
    },
  };
}
