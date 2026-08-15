/**
 * x402 exact / USDC on Ethereum Sepolia.
 * payTo is the buyer agent. The public x402.org facilitator does not list
 * eip155:11155111, so we self-settle EIP-3009 transferWithAuthorization.
 */
import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  parseSignature,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { config } from "./config.js";

const USDC_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

function normalizePrivateKey(key) {
  const hex = String(key || "").trim();
  if (!hex) return "";
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

function usdcAtomicFromCents(cents) {
  return BigInt(Math.max(0, Math.round(Number(cents) || 0))) * 10_000n;
}

function formatUsdc(raw) {
  if (raw === 0n) return "0";
  const s = raw.toString().padStart(7, "0");
  const whole = s.slice(0, -6);
  const frac = s.slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function chain() {
  return { ...sepolia, id: config.base.chainId || sepolia.id };
}

function clients(account) {
  const transport = http(config.base.rpcUrl);
  const ch = chain();
  return {
    publicClient: createPublicClient({ chain: ch, transport }),
    walletClient: account
      ? createWalletClient({ account, chain: ch, transport })
      : null,
  };
}

function configuredAccounts() {
  const out = [];
  const seen = new Set();
  for (const [role, key] of [
    ["seller", config.base.sellerPrivateKey],
    ["buyer", config.base.buyerPrivateKey],
  ]) {
    const hex = normalizePrivateKey(key);
    if (!hex || hex.length !== 66) continue;
    const account = privateKeyToAccount(hex);
    const id = account.address.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ role, account });
  }
  return out;
}

async function readUsdc(address) {
  const { publicClient } = clients();
  return publicClient.readContract({
    address: getAddress(config.base.usdc),
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [getAddress(address)],
  });
}

async function pickPayer(amountAtomic) {
  const list = configuredAccounts();
  if (!list.length) throw new Error("No wallet key configured to sign the x402 payment");
  const merchant = String(config.base.sellerAddress || "").toLowerCase();
  const ordered = [
    ...list.filter((x) => x.account.address.toLowerCase() === merchant),
    ...list.filter((x) => x.role === "seller"),
    ...list,
  ].filter((item, i, arr) => arr.findIndex((x) => x.account.address === item.account.address) === i);

  for (const item of ordered) {
    const usdc = await readUsdc(item.account.address);
    if (usdc >= amountAtomic) return { ...item, usdc };
  }
  const seller = ordered[0];
  return { ...seller, usdc: await readUsdc(seller.account.address) };
}

async function pickFacilitator(payerAddress) {
  const list = configuredAccounts();
  const { publicClient } = clients();
  let best = null;
  for (const item of list) {
    const eth = await publicClient.getBalance({ address: item.account.address });
    if (eth <= 0n) continue;
    if (!best || eth > best.eth) best = { ...item, eth };
  }
  if (best) return best.account;
  const payer = list.find((x) => x.account.address.toLowerCase() === payerAddress.toLowerCase());
  if (payer) return payer.account;
  throw new Error("No wallet with Sepolia ETH to submit the x402 settlement");
}

async function tokenDomain(publicClient) {
  const token = getAddress(config.base.usdc);
  const [name, version] = await Promise.all([
    publicClient.readContract({ address: token, abi: USDC_ABI, functionName: "name" }),
    publicClient.readContract({ address: token, abi: USDC_ABI, functionName: "version" }),
  ]);
  return {
    name: name || "USDC",
    version: version || "2",
    chainId: config.base.chainId || 11155111,
    verifyingContract: token,
  };
}

/**
 * x402 exact: merchant signs EIP-3009, payTo = buyer agent, then settle on-chain.
 */
export async function executeX402ToAgent({ amountCents, offerId }) {
  const payTo = getAddress(config.base.agentAddress || config.base.buyerAddress);
  const amount = usdcAtomicFromCents(amountCents);
  if (amount <= 0n) throw new Error("Bid amount is 0");

  const payer = await pickPayer(amount);
  if (payer.account.address.toLowerCase() === payTo.toLowerCase()) {
    throw new Error("x402 merchant and buyer agent are the same wallet; USDC would not move");
  }
  if (payer.usdc < amount) {
    const funded = config.base.sellerAddress;
    throw new Error(
      `x402 payer ${payer.account.address} has ${formatUsdc(payer.usdc)} USDC, need ${formatUsdc(amount)}. ` +
        `Set SELLER_WALLET_PRIVATE_KEY to the wallet that holds the USDC` +
        (funded ? ` (${funded})` : ""),
    );
  }

  const facilitator = await pickFacilitator(payer.account.address);
  const { publicClient, walletClient } = clients(facilitator);
  const domain = await tokenDomain(publicClient);
  const nonce = `0x${randomBytes(32).toString("hex")}`;
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const authorization = {
    from: payer.account.address,
    to: payTo,
    value: amount,
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await clients(payer.account).walletClient.signTypedData({
    account: payer.account,
    domain,
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  const parsed = parseSignature(signature);
  const v = parsed.v !== undefined ? Number(parsed.v) : Number(parsed.yParity ?? 0) + 27;
  const { r, s } = parsed;

  const hash = await walletClient.writeContract({
    address: getAddress(config.base.usdc),
    abi: USDC_ABI,
    functionName: "transferWithAuthorization",
    args: [
      authorization.from,
      authorization.to,
      authorization.value,
      authorization.validAfter,
      authorization.validBefore,
      authorization.nonce,
      Number(v),
      r,
      s,
    ],
    account: facilitator,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error("x402 USDC settlement reverted");

  return {
    hash,
    from: payer.account.address,
    to: payTo,
    amountAtomic: amount.toString(),
    amountUsdc: formatUsdc(amount),
    offerId,
    scheme: "exact",
    network: config.x402.network,
    facilitator: facilitator.address,
    payTo,
  };
}
