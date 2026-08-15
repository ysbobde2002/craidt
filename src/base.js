import { createPublicClient, createWalletClient, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { config } from "./config.js";

const USDC_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

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
  if (data.error) throw new Error(data.error.message || "RPC error");
  return data.result;
}

export async function fetchEthBalance(address) {
  if (!isAddress(address)) return null;
  const rawHex = await rpc("eth_getBalance", [address, "latest"]);
  const raw = rawHex && rawHex !== "0x" ? BigInt(rawHex) : 0n;
  return {
    symbol: "ETH",
    decimals: 18,
    formatted: formatUnits(raw, 18),
    address,
  };
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
    raw: raw.toString(),
    formatted: formatUnits(raw, 6),
    contract: config.base.usdc,
    address,
  };
}

export function baseNetwork() {
  return {
    chain: config.base.chainName,
    chainId: config.base.chainId,
    network: config.base.network,
    explorer: config.base.explorer,
    usdc: config.base.usdc,
    buyerAddress: config.base.buyerAddress || null,
    sellerAddress: config.base.sellerAddress || null,
    agentAddress: config.base.agentAddress || null,
  };
}

function normalizePrivateKey(key) {
  const hex = String(key || "").trim();
  if (!hex) return "";
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

function usdcAtomicFromCents(cents) {
  return BigInt(Math.max(0, Math.round(Number(cents) || 0))) * 10_000n;
}

/** Incentive rail accounting. Live USDC send happens in payMerchantIncentive. */
export function recordBaseIncentive({ bidCents, userCashbackCents, agentShareCents, offerId }) {
  return {
    chain: config.base.chainName,
    asset: "USDC",
    bidUsdc: bidCents / 100,
    userCashbackUsdc: userCashbackCents / 100,
    agentShareUsdc: agentShareCents / 100,
    buyer: config.base.buyerAddress || "buyer (demo)",
    seller: config.base.sellerAddress || "merchant (demo)",
    agent: config.base.agentAddress || "agent (demo)",
    explorer: config.base.explorer,
    reference: `base:${offerId}:${Date.now().toString(16)}`,
    confirmed: false,
    live: false,
    txHash: null,
    explorerTx: null,
  };
}

export async function transferUsdcToAgent({ amountCents, offerId }) {
  const key = normalizePrivateKey(config.base.sellerPrivateKey);
  const to = getAddress(config.base.agentAddress || config.base.buyerAddress);
  if (!key || key.length !== 66) throw new Error("Merchant wallet key missing");
  const amount = usdcAtomicFromCents(amountCents);
  if (amount <= 0n) throw new Error("Bid amount is 0");

  const account = privateKeyToAccount(key);
  const seller = String(config.base.sellerAddress || "").toLowerCase();
  if (seller && account.address.toLowerCase() !== seller) {
    throw new Error("Merchant key does not match SELLER_PAYTO_ADDRESS");
  }

  const chain = { ...sepolia, id: config.base.chainId || sepolia.id };
  const transport = http(config.base.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  const hash = await walletClient.writeContract({
    address: getAddress(config.base.usdc),
    abi: USDC_ABI,
    functionName: "transfer",
    args: [to, amount],
    account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 90_000,
  });
  if (receipt.status !== "success") throw new Error("USDC transfer reverted");
  return {
    hash,
    to,
    from: account.address,
    amountAtomic: amount.toString(),
    amountUsdc: formatUnits(amount, 6),
    offerId,
  };
}

export async function payMerchantIncentive({
  bidCents,
  userCashbackCents,
  agentShareCents,
  offerId,
  live = true,
}) {
  const recorded = recordBaseIncentive({
    bidCents,
    userCashbackCents,
    agentShareCents,
    offerId,
  });
  if (!live) {
    return { ...recorded, confirmed: true, detail: "simulated" };
  }
  try {
    const tx = await transferUsdcToAgent({ amountCents: bidCents, offerId });
    return {
      ...recorded,
      confirmed: true,
      live: true,
      txHash: tx.hash,
      explorerTx: `${config.base.explorer}/tx/${tx.hash}`,
      from: tx.from,
      to: tx.to,
      detail: "USDC transfer confirmed",
    };
  } catch (err) {
    return {
      ...recorded,
      confirmed: false,
      live: true,
      error: err instanceof Error ? err.message : String(err),
      detail: "USDC bid transfer failed",
    };
  }
}

function formatTs(unix) {
  const n = Number(unix);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function shortHash(hash) {
  const h = String(hash || "");
  if (h.length < 12) return h;
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

function explorerQueryOk(data) {
  if (data?.status === "1" && Array.isArray(data.result)) return data.result;
  const message = String(data?.message || "").toLowerCase();
  if (message.includes("no transaction") || message.includes("no records")) return [];
  if (Array.isArray(data?.result)) return data.result;
  return null;
}

async function explorerGet(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  return explorerQueryOk(await res.json());
}

async function etherscan(action, extra) {
  const shared = {
    module: "account",
    action,
    page: "1",
    offset: "10",
    sort: "desc",
    ...extra,
  };
  const v2 = new URLSearchParams({
    chainid: String(config.base.chainId || 11155111),
    ...shared,
  });
  if (config.base.etherscanApiKey) v2.set("apikey", config.base.etherscanApiKey);
  try {
    const v2Rows = await explorerGet(`https://api.etherscan.io/v2/api?${v2}`);
    if (v2Rows) return v2Rows;
  } catch {
    /* fall through to Blockscout */
  }
  try {
    const blockscout = new URLSearchParams(shared);
    const scoutRows = await explorerGet(`https://eth-sepolia.blockscout.com/api?${blockscout}`);
    if (scoutRows) return scoutRows;
  } catch {
    /* no explorer history */
  }
  return [];
}

function parseNativeTx(row, owner) {
  const from = String(row.from || "").toLowerCase();
  const to = String(row.to || "").toLowerCase();
  const me = owner.toLowerCase();
  const value = BigInt(row.value || "0");
  const incoming = to === me;
  const amount = value > 0n ? formatUnits(value, 18) : "0";
  return {
    hash: row.hash,
    time: formatTs(row.timeStamp),
    dir: incoming ? "tx-in" : "tx-out",
    asset: "ETH",
    amount,
    label: value > 0n ? "ETH" : "contract",
    explorer: `${config.base.explorer}/tx/${row.hash}`,
    timestamp: Number(row.timeStamp || 0),
  };
}

function parseTokenTx(row, owner) {
  const to = String(row.to || "").toLowerCase();
  const me = owner.toLowerCase();
  const incoming = to === me;
  const decimals = Number(row.tokenDecimal || 6);
  const amount = formatUnits(BigInt(row.value || "0"), decimals);
  const symbol = row.tokenSymbol || "USDC";
  return {
    hash: row.hash,
    time: formatTs(row.timeStamp),
    dir: incoming ? "tx-in" : "tx-out",
    asset: symbol,
    amount,
    label: symbol,
    explorer: `${config.base.explorer}/tx/${row.hash}`,
    timestamp: Number(row.timeStamp || 0),
  };
}

export async function fetchRecentTransactions(address, limit = 3) {
  if (!isAddress(address)) return [];
  const [native, tokens] = await Promise.all([
    etherscan("txlist", { address, startblock: "0", endblock: "99999999" }).catch(() => []),
    etherscan("tokentx", {
      address,
      contractaddress: config.base.usdc,
    }).catch(() => []),
  ]);
  const tokenHashes = new Set(tokens.map((row) => String(row.hash || "").toLowerCase()));
  const rows = [];
  for (const row of native) {
    if (row.isError === "1") continue;
    const parsed = parseNativeTx(row, address);
    if (parsed.amount === "0" && tokenHashes.has(String(row.hash || "").toLowerCase())) continue;
    rows.push(parsed);
  }
  for (const row of tokens) rows.push(parseTokenTx(row, address));
  rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const seen = new Set();
  const out = [];
  for (const tx of rows) {
    const key = `${tx.hash}:${tx.asset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...tx, hashShort: shortHash(tx.hash) });
    if (out.length >= limit) break;
  }
  return out;
}
