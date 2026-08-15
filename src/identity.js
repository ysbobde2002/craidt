import { config } from "./config.js";

export const IDENTITY_REGISTRY_TESTNET = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const IDENTITY_REGISTRY_MAINNET = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

const CHAIN_SLUGS = {
  11155111: "sepolia",
  1: "ethereum",
  84532: "base-sepolia",
  8453: "base",
};

function identityRegistry(chainId) {
  return [1, 8453, 137, 56, 42161].includes(chainId)
    ? IDENTITY_REGISTRY_MAINNET
    : IDENTITY_REGISTRY_TESTNET;
}

function chainLabel(chainId) {
  if (chainId === 11155111) return "Ethereum Sepolia";
  if (chainId === 1) return "Ethereum";
  if (chainId === 84532) return "Base Sepolia";
  if (chainId === 8453) return "Base";
  return `chain ${chainId}`;
}

function explorerBase(chainId) {
  if (chainId === 11155111) return "https://sepolia.etherscan.io";
  if (chainId === 1) return "https://etherscan.io";
  if (chainId === 84532) return "https://sepolia.basescan.org";
  if (chainId === 8453) return "https://basescan.org";
  return config.base.explorer || "https://sepolia.etherscan.io";
}

function scanWebBase() {
  return (config.scan8004.webBase || "https://testnet.8004scan.io").replace(/\/$/, "");
}

function scanAgentUrl(chainId, agentId) {
  const slug = CHAIN_SLUGS[chainId] || String(chainId);
  return `${scanWebBase()}/agents/${slug}/${agentId}`;
}

function parseAgentBody(body) {
  if (!body || typeof body !== "object") return null;
  if (body.success === true && body.data && typeof body.data === "object") return body.data;
  if (body.token_id != null || body.agent_id != null || body.name) return body;
  if (body.data && typeof body.data === "object") return body.data;
  return null;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(12000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("not json");
  }
}

export async function fetchScanAgent(chainId, agentId) {
  const id = String(agentId);
  const bases = [
    `${scanWebBase()}/api/v1/public`,
    (config.scan8004.apiBase || "").replace(/\/$/, ""),
  ].filter(Boolean);
  const seen = new Set();
  for (const base of bases) {
    if (seen.has(base)) continue;
    seen.add(base);
    const url = `${base}/agents/${chainId}/${id}`;
    const headers = {};
    if (!url.includes("/public") && config.scan8004.apiKey) {
      headers["X-API-Key"] = config.scan8004.apiKey;
    }
    try {
      const body = await fetchJson(url, headers);
      const agent = parseAgentBody(body);
      if (agent) return agent;
    } catch {
      /* try next */
    }
  }
  return null;
}

function scoreBreakdown(scan) {
  const scores = scan?.scores && typeof scan.scores === "object" ? scan.scores : {};
  const dims = scores.breakdown?.dimensions && typeof scores.breakdown.dimensions === "object"
    ? scores.breakdown.dimensions
    : {};
  const service = dims.service?.details && typeof dims.service.details === "object"
    ? dims.service.details
    : {};
  return {
    healthScore: scores.health_score ?? null,
    quality: scores.quality ?? null,
    popularity: scores.popularity ?? null,
    activity: scores.activity ?? null,
    freshness: scores.freshness ?? null,
    metadataCompleteness: scores.metadata_completeness ?? null,
    walletScore: scores.wallet ?? null,
    serviceIntegrity: service.integrity_tier ?? null,
    discoverability: service.discoverability_tier ?? null,
  };
}

function serviceUrl() {
  return "https://craidt-railway-production.up.railway.app";
}

export async function buildAgentIdentity() {
  const chainId = Number(config.base.chainId || 11155111);
  const agentIdRaw = config.scan8004.agentId;
  const agentId = agentIdRaw ? Number(agentIdRaw) : null;
  const registry = identityRegistry(chainId);
  const agentRegistry = `eip155:${chainId}:${registry.toLowerCase()}`;

  if (!agentId) {
    return {
      configured: false,
      error: "ERC8004_AGENT_ID is not set",
      chainId,
      chainLabel: chainLabel(chainId),
    };
  }

  const scan = await fetchScanAgent(chainId, agentId);
  const owner = scan?.owner_address || config.base.sellerAddress || config.base.buyerAddress;
  const agentWallet = config.base.agentAddress || scan?.agent_wallet || owner;
  const ranking = scan ? scoreBreakdown(scan) : null;
  const verify = [
    { label: "8004scan profile", url: scanAgentUrl(chainId, agentId), kind: "indexer" },
    { label: "Etherscan NFT (on-chain ID)", url: `${explorerBase(chainId)}/nft/${registry}/${agentId}`, kind: "chain" },
    { label: "Identity Registry contract", url: `${explorerBase(chainId)}/address/${registry}`, kind: "chain" },
    { label: "Owner wallet", url: `${explorerBase(chainId)}/address/${owner}`, kind: "chain" },
    { label: "craidt demo", url: serviceUrl(), kind: "service" },
  ];

  const identity = {
    name: scan?.name || "craidt-buyer-agent",
    description: (scan?.description || "").trim(),
    agentId,
    chainId,
    chainLabel: chainLabel(chainId),
    globalId: `${agentRegistry}:${agentId}`,
    agentRegistry,
    identityRegistry: registry,
    owner,
    agentWallet,
    x402Support: scan?.x402_supported ?? scan?.x402Support ?? true,
    supportedTrust: scan?.supported_trust || scan?.supportedTrust || ["reputation"],
  };

  const feedback = {
    starCount: scan?.star_count ?? 0,
    watchCount: scan?.watch_count ?? 0,
    isVerified: Boolean(scan?.is_verified),
    ownerUsername: scan?.owner_username || null,
    totalFeedbacks: scan?.total_feedbacks ?? 0,
    averageScore: scan?.average_score ?? 0,
  };

  return {
    configured: true,
    protocol: "ERC-8004",
    name: identity.name,
    description: identity.description,
    agentId,
    chainId,
    chainLabel: identity.chainLabel,
    globalId: identity.globalId,
    identityRegistry: registry,
    agentRegistry,
    owner,
    agentWallet,
    x402Support: identity.x402Support,
    scan8004Url: scanAgentUrl(chainId, agentId),
    sections: {
      identity,
      ranking,
      feedback,
      verify: { links: verify },
    },
    verify,
  };
}
