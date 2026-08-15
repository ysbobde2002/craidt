import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT } from "./config.js";

const SHOPIFY_UCP_MCP = "https://catalog.shopify.com/api/ucp/mcp";
const UCP_AGENT_PROFILE =
  "https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json";

const fallbackCatalog = JSON.parse(
  readFileSync(join(ROOT, "data/ucp-fallback.json"), "utf8"),
).products;

function priceToCents(product) {
  const amount =
    product.variants?.[0]?.price?.amount ??
    product.price_range?.min?.amount ??
    product.priceCents;
  if (amount == null) return 0;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (!Number.isInteger(n) || String(amount).includes(".")) {
    return Math.round(n * 100);
  }
  return n;
}

function mapUcpProduct(product) {
  const variant = product.variants?.[0] ?? {};
  const priceCents = priceToCents(product);
  if (!priceCents) return null;
  return {
    productId: String(product.id || variant.id || randomUUID()),
    title: product.title || variant.title || "Shopify product",
    merchantName: variant.seller?.name || product.seller?.name || "Shopify merchant",
    priceCents,
    imageUrl: product.media?.[0]?.url || "",
  };
}

export function searchFallback(parsed, limit) {
  const tokens = parsed.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const toOffer = (p) => ({
    productId: p.id,
    title: p.title,
    merchantName: p.merchantName,
    priceCents: p.priceCents,
    imageUrl: p.imageUrl,
  });

  const inBudget = (p) => !parsed.maxPriceCents || p.priceCents <= parsed.maxPriceCents;

  const scored = fallbackCatalog
    .map((p) => {
      const hay = `${p.title} ${p.merchantName} ${p.keywords.join(" ")}`.toLowerCase();
      return { p, hits: tokens.filter((t) => hay.includes(t)).length };
    })
    .filter((row) => row.hits > 0 || tokens.length === 0)
    .sort((a, b) => b.hits - a.hits)
    .map((row) => toOffer(row.p))
    .filter(inBudget);

  const backup = fallbackCatalog.map(toOffer).filter(inBudget);
  return (scored.length ? scored : backup).slice(0, limit);
}

export async function searchUcp(parsed, limit) {
  const catalog = {
    query: parsed.query,
    view: "offer",
    filters: {
      ships_to: {
        country: parsed.shipTo.country,
        region: parsed.shipTo.region,
        postal_code: parsed.shipTo.postalCode,
      },
      available: true,
      ...(parsed.maxPriceCents ? { price: { max: parsed.maxPriceCents } } : {}),
    },
    context: {
      address_country: parsed.shipTo.country,
      address_region: parsed.shipTo.region,
      postal_code: parsed.shipTo.postalCode,
      intent: parsed.intent,
      currency: "USD",
    },
    pagination: { limit },
  };

  const res = await fetch(SHOPIFY_UCP_MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 1,
      params: {
        name: "search_catalog",
        arguments: {
          meta: { "ucp-agent": { profile: UCP_AGENT_PROFILE } },
          catalog,
        },
      },
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Shopify UCP HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "UCP error");

  let content = data.result?.structuredContent;
  if (!content?.products && Array.isArray(data.result?.content)) {
    for (const block of data.result.content) {
      if (block.type === "text" && block.text) {
        try {
          content = JSON.parse(block.text);
        } catch {
          /* ignore */
        }
      }
    }
  }

  return (content?.products ?? []).map(mapUcpProduct).filter(Boolean);
}

export async function discoverProducts(parsed, limit) {
  let products = [];
  let source = "fallback";
  try {
    products = await searchUcp(parsed, limit);
    if (products.length) source = "shopify-ucp";
  } catch {
    products = [];
  }
  if (!products.length) products = searchFallback(parsed, limit);
  if (parsed.maxPriceCents) {
    products = products.filter((p) => p.priceCents <= parsed.maxPriceCents);
  }
  if (!products.length) products = searchFallback(parsed, limit);
  return { products: products.slice(0, limit), source };
}
