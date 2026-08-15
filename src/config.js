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
    sellerAccountId: env("STRIPE_SELLER_ACCOUNT_ID"),
    testPaymentMethod: env("STRIPE_TEST_PM", "pm_card_visa"),
    testCustomerId: env("STRIPE_TEST_CUSTOMER_ID"),
  },
  base: {
    rpcUrl: env("BASE_SEPOLIA_RPC", "https://sepolia.base.org"),
    usdc: env("USDC_CONTRACT_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
    explorer: env("EXPLORER_BASE_URL", "https://sepolia.basescan.org"),
    chainId: 84532,
    network: "eip155:84532",
    buyerAddress: env("BUYER_WALLET_ADDRESS"),
    sellerAddress: env("SELLER_PAYTO_ADDRESS"),
    agentAddress: env("AGENT_WALLET_ADDRESS"),
  },
  openai: {
    apiKey: env("OPENAI_API_KEY"),
    model: env("OPENAI_MODEL", "gpt-4o-mini"),
  },
};

export function stripeConfigured() {
  return config.stripe.secretKey.startsWith("sk_test_");
}
