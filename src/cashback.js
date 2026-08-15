/**
 * midnightx402 cashback accounting, unchanged:
 *   merchant incentive → 60% user cashback + 40% agent
 *   Net Human Cost = price − confirmed cashback (projected cashback is ranking-only)
 */

export const USER_CASHBACK_BPS = 6_000;
export const AGENT_SHARE_BPS = 4_000;

export function splitIncentiveCents(bidCents) {
  const safe = Math.max(0, Math.round(Number(bidCents) || 0));
  const userCashbackCents = Math.round((safe * USER_CASHBACK_BPS) / 10_000);
  const agentShareCents = safe - userCashbackCents;
  return { userCashbackCents, agentShareCents };
}

export function bidFromPriceCents(priceCents) {
  const pct = 0.012 + Math.random() * 0.018;
  const bidUsdc = Math.max(0.05, Math.round(priceCents * pct) / 100);
  const bidCents = Math.round(bidUsdc * 100);
  return { bidUsdc, bidCents, ...splitIncentiveCents(bidCents) };
}

export function bumpBidUsdc(currentUsdc, bump) {
  const bidUsdc = Math.round((Number(currentUsdc) + bump) * 100) / 100;
  const bidCents = Math.round(bidUsdc * 100);
  return { bidUsdc, bidCents, ...splitIncentiveCents(bidCents) };
}

/** Ranking uses projected cashback from the live bid. Settlement uses confirmedCashbackCents. */
export function netHumanCostCents(priceCents, cashbackCents) {
  return priceCents - (cashbackCents || 0);
}
