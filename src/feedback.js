/**
 * ERC-8004 Reputation Registry — ACP-demo giveFeedback on Ethereum Sepolia.
 * Merchant client signs; agent owner/operators cannot self-rate.
 */
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { config } from "./config.js";
import { fetchScanAgent } from "./identity.js";

const REPUTATION_ABI = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);

function normalizePrivateKey(key) {
  const hex = String(key || "").trim();
  if (!hex) return "";
  return hex.startsWith("0x") ? hex : `0x${hex}`;
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

function configuredFeedbackAccounts() {
  const out = [];
  const seen = new Set();
  for (const [role, key] of [
    ["rater", config.base.feedbackClientPrivateKey],
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

function buildFeedbackUri(proof) {
  const raw = JSON.stringify(proof);
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  const hash = keccak256(stringToHex(raw));
  return { uri: `data:application/json;base64,${b64}`, hash };
}

async function pickRater(ownerAddress) {
  const list = configuredFeedbackAccounts();
  if (!list.length) throw new Error("No wallet key configured to sign ERC-8004 giveFeedback");
  const owner = String(ownerAddress || "").toLowerCase();
  const { publicClient } = clients();
  let blocked = null;
  for (const item of list) {
    if (owner && item.account.address.toLowerCase() === owner) {
      blocked = item.account.address;
      continue;
    }
    const eth = await publicClient.getBalance({ address: item.account.address });
    if (eth > parseEther("0.0002")) return { ...item, eth };
  }
  if (blocked) {
    throw new Error(
      `ERC-8004 blocks self-feedback from agent owner ${blocked}. Set FEEDBACK_CLIENT_PRIVATE_KEY to a different wallet with Sepolia ETH`,
    );
  }
  throw new Error("No non-owner wallet with Sepolia ETH to submit giveFeedback");
}

/**
 * Merchant submits on-chain giveFeedback for the buyer agent.
 */
export async function submitGiveFeedback({
  score,
  stars,
  comment = "",
  payment = {},
  live = true,
}) {
  const value = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const agentId = Number(config.scan8004.agentId);
  if (!agentId) {
    return { submitted: false, indexerStatus: "skipped", error: "ERC8004_AGENT_ID is not set" };
  }
  if (!live) {
    return {
      submitted: true,
      live: false,
      agentId,
      feedbackScore: value,
      feedbackStars: stars ?? null,
      indexerStatus: "simulated",
      detail: "demo feedback (eval)",
    };
  }

  const chainId = config.base.chainId || 11155111;
  const scan = await fetchScanAgent(chainId, agentId);
  const owner = scan?.owner_address || config.base.sellerAddress;
  let rater;
  try {
    rater = await pickRater(owner);
  } catch (err) {
    return {
      submitted: false,
      indexerStatus: "error",
      error: err instanceof Error ? err.message : String(err),
      agentId,
    };
  }

  const tag1 = payment.txHash ? "x402" : "stripe";
  const tag2 = "craidt-commerce";
  const endpoint = "https://craidt-railway-production.up.railway.app";
  const proof = {
    type: payment.txHash ? "craidt-x402-bid" : "craidt-stripe-purchase",
    createdAt: new Date().toISOString(),
    comment: comment || null,
    offerId: payment.offerId || null,
    txHash: payment.txHash || null,
    paymentIntentId: payment.paymentIntentId || null,
    amountCents: payment.amountCents || null,
    bidCents: payment.bidCents || null,
    provider: payment.provider || (payment.txHash ? "x402" : "stripe"),
    stars: stars ?? null,
    score: value,
  };
  const { uri, hash } = buildFeedbackUri(proof);
  const { publicClient, walletClient } = clients(rater.account);
  const registry = getAddress(config.base.reputationRegistry);

  try {
    const txHash = await walletClient.writeContract({
      address: registry,
      abi: REPUTATION_ABI,
      functionName: "giveFeedback",
      args: [BigInt(agentId), BigInt(value), 0, tag1, tag2, endpoint, uri, hash],
      account: rater.account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
    if (receipt.status !== "success") {
      return {
        submitted: false,
        indexerStatus: "error",
        error: "giveFeedback transaction reverted on-chain",
        agentId,
        feedbackTxHash: txHash,
      };
    }
    return {
      submitted: true,
      live: true,
      agentId,
      client: rater.account.address,
      registry,
      feedbackTxHash: txHash,
      feedbackExplorer: `${config.base.explorer}/tx/${txHash}`,
      feedbackScore: value,
      feedbackStars: stars ?? null,
      tags: [tag1, tag2],
      scan8004Url: `${(config.scan8004.webBase || "https://testnet.8004scan.io").replace(/\/$/, "")}/agents/sepolia/${agentId}`,
      indexerStatus: "pending",
      detail: "ERC-8004 giveFeedback confirmed",
    };
  } catch (err) {
    return {
      submitted: false,
      indexerStatus: "error",
      error: err instanceof Error ? err.message : String(err),
      agentId,
      client: rater.account.address,
    };
  }
}
