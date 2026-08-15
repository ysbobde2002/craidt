import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotenv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotenv(join(ROOT, ".env"));

function env(name, fallback = "") {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

export const config = {
  port: Number(env("PORT", "5180")),
  stripe: {
    secretKey: env("STRIPE_SECRET_KEY"),
    publicKey: env("STRIPE_PUBLIC_KEY"),
    sellerSecretKey: env("STRIPE_SELLER_SECRET_KEY"),
    sellerPublicKey: env("STRIPE_SELLER_PUBLIC_KEY"),
    sellerAccountId: env("STRIPE_SELLER_ACCOUNT_ID"),
    testPaymentMethod: env("STRIPE_TEST_PM", "pm_card_visa"),
    testCustomerId: env("STRIPE_TEST_CUSTOMER_ID"),
  },
  base: {
    chainName: env("CHAIN_NAME", "Ethereum Sepolia"),
    rpcUrl: env("ETH_SEPOLIA_RPC", env("BASE_SEPOLIA_RPC", "https://ethereum-sepolia-rpc.publicnode.com")),
    usdc: env("USDC_CONTRACT_ADDRESS", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"),
    explorer: env("EXPLORER_BASE_URL", "https://sepolia.etherscan.io"),
    chainId: Number(env("ERC8004_CHAIN_ID", "11155111")),
    network: env("X402_NETWORK", "eip155:11155111"),
    buyerAddress: env("BUYER_WALLET_ADDRESS", "0x8873cD8D93D6FDee9d21F699723C90eeC783747e"),
    sellerAddress: env("SELLER_PAYTO_ADDRESS", "0x9f7A0813674F48d2f2824B5099fBbD68686764B3"),
    agentAddress: env("AGENT_WALLET_ADDRESS", "0x8873cD8D93D6FDee9d21F699723C90eeC783747e"),
    buyerPrivateKey: env("BUYER_WALLET_PRIVATE_KEY"),
    sellerPrivateKey: env("SELLER_WALLET_PRIVATE_KEY"),
    etherscanApiKey: env("ETHERSCAN_API_KEY", env("BASESCAN_API_KEY")),
  },
  openai: {
    apiKey: env("OPENAI_API_KEY"),
    model: env("OPENAI_MODEL", "gpt-4o-mini"),
  },
  scan8004: {
    apiBase: env("SCAN8004_API_BASE", "https://testnet.8004scan.io/api/v1"),
    webBase: env("SCAN8004_WEB_BASE", "https://testnet.8004scan.io"),
    apiKey: env("SCAN8004_API_KEY"),
    agentId: env("ERC8004_AGENT_ID", "9638"),
  },
  x402: {
    facilitatorUrl: env("X402_FACILITATOR_URL", "https://x402.org/facilitator"),
    network: env("X402_NETWORK", "eip155:11155111"),
  },
};

export function stripeConfigured() {
  return config.stripe.secretKey.startsWith("sk_test_");
}
