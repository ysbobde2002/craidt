import { randomUUID } from "node:crypto";
import { bidFromPriceCents, bumpBidUsdc, netHumanCostCents } from "./cashback.js";

const auctions = new Map();

function recommend(bids) {
  return [...bids].sort(
    (a, b) =>
      netHumanCostCents(a.priceCents, a.userCashbackCents) -
      netHumanCostCents(b.priceCents, b.userCashbackCents),
  )[0];
}

export function createAuction(products) {
  const bids = products.map((p) => ({ ...p, ...bidFromPriceCents(p.priceCents) }));
  const session = {
    id: randomUUID(),
    bids,
    recommendedProductId: recommend(bids)?.productId ?? null,
  };
  auctions.set(session.id, session);
  return session;
}

export function getAuction(sessionId) {
  return auctions.get(sessionId) ?? null;
}

export function tickAuction(session) {
  if (!session.bids.length) return session;
  const row = session.bids[Math.floor(Math.random() * session.bids.length)];
  Object.assign(row, bumpBidUsdc(row.bidUsdc, 0.04 + Math.random() * 0.18));
  session.recommendedProductId = recommend(session.bids)?.productId ?? session.recommendedProductId;
  return session;
}

export function publicAuction(session) {
  return {
    sessionId: session.id,
    recommendedProductId: session.recommendedProductId,
    bids: session.bids,
  };
}
