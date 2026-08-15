import { config } from "./config.js";

function padAddress(addr) {
  return addr.trim().toLowerCase();
}

function isAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr || "");
}

function formatUnits(raw, decimals) {
  if (raw === 0n) return "0";
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

async function rpc(method, params) {
  const res = await fetch(config.base.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Base RPC error");
  return data.result;
}

export async function fetchUsdcBalance(address) {
  if (!isAddress(address)) return null;
  const padded = "0".repeat(24) + padAddress(address).slice(2);
  const data = "0x70a08231" + padded;
  const rawHex = await rpc("eth_call", [
    { to: config.base.usdc, data },
    "latest",
  ]);
  const raw = rawHex && rawHex !== "0x" ? BigInt(rawHex) : 0n;
  return {
    symbol: "USDC",
    decimals: 6,
    formatted: formatUnits(raw, 6),
    contract: config.base.usdc,
    address,
  };
}

export function baseNetwork() {
  return {
    chain: "Base Sepolia",
    chainId: config.base.chainId,
    network: config.base.network,
    explorer: config.base.explorer,
    usdc: config.base.usdc,
    buyerAddress: config.base.buyerAddress || null,
    sellerAddress: config.base.sellerAddress || null,
    agentAddress: config.base.agentAddress || null,
  };
}

/** Incentive rail: merchant bid in USDC on Base. Live transfer is optional; accounting is always recorded. */
export function recordBaseIncentive({ bidCents, userCashbackCents, agentShareCents, offerId }) {
  return {
    chain: "Base Sepolia",
    asset: "USDC",
    bidUsdc: bidCents / 100,
    userCashbackUsdc: userCashbackCents / 100,
    agentShareUsdc: agentShareCents / 100,
    buyer: config.base.buyerAddress || "buyer (demo)",
    seller: config.base.sellerAddress || "merchant (demo)",
    agent: config.base.agentAddress || "agent (demo)",
    explorer: config.base.explorer,
    reference: `base:${offerId}:${Date.now().toString(16)}`,
    confirmed: true,
  };
}
