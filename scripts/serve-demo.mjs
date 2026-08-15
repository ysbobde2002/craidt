#!/usr/bin/env node
/**
 * craidt demo — buyer | Shopify UCP
 *   npm run demo  → http://localhost:5180
 *
 * Purchase: Stripe (ACP-demo). Incentive/cashback: Ethereum Sepolia USDC, 60/40 from midnightx402.
 */

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { config, ROOT, stripeConfigured } from "../src/config.js";
import { captureTurn } from "../src/intent.js";
import { openaiConfigured } from "../src/openai.js";
import { discoverProducts } from "../src/ucp.js";
import { createAuction, getAuction, publicAuction, tickAuction } from "../src/auction.js";
import { stripeWallet } from "../src/stripe.js";
import { baseNetwork, fetchEthBalance, fetchRecentTransactions, fetchUsdcBalance } from "../src/base.js";
import { settlePurchase, pushPurchaseIncentive } from "../src/settle.js";
import { buildAgentIdentity } from "../src/identity.js";

const UI_ROOT = join(ROOT, "ui");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function serveStatic(url, res) {
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = resolve(UI_ROOT, `.${rel}`);
  if (!file.startsWith(UI_ROOT) || !existsSync(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

  try {
    if (url.pathname === "/api/turn" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) {
        sendJson(res, 400, { error: "prompt is required" });
        return;
      }
      const turn = await captureTurn({
        sessionId: String(body.sessionId ?? "").trim() || undefined,
        prompt,
      });
      if (!turn.ready) {
        sendJson(res, 200, { ...turn, intentSessionId: turn.sessionId });
        return;
      }
      const { products, source } = await discoverProducts(turn.parsed, Number(body.limit) || 5);
      const auction = createAuction(products);
      const pub = publicAuction(auction);
      sendJson(res, 200, {
        ...turn,
        intentSessionId: turn.sessionId,
        sessionId: pub.sessionId,
        recommendedProductId: pub.recommendedProductId,
        bids: pub.bids,
        source,
        products,
      });
      return;
    }

    if (url.pathname === "/api/discover" && req.method === "POST") {
      sendJson(res, 410, { error: "Use POST /api/turn — UCP search waits for product + budget." });
      return;
    }

    if (url.pathname === "/api/bids" && req.method === "GET") {
      const id = url.searchParams.get("sessionId")?.trim();
      if (!id) {
        sendJson(res, 400, { error: "sessionId is required" });
        return;
      }
      const session = getAuction(id);
      if (!session) {
        sendJson(res, 404, { error: "auction not found" });
        return;
      }
      sendJson(res, 200, publicAuction(tickAuction(session)));
      return;
    }

    if (url.pathname === "/api/settle" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const receipt = await settlePurchase({
        sessionId: String(body.sessionId ?? "").trim(),
        productId: String(body.productId ?? "").trim(),
      });
      sendJson(res, 200, receipt);
      return;
    }

    if (url.pathname === "/api/incentive" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const live = String(req.headers["x-craidt-eval"] || "") !== "1";
      const receipt = await pushPurchaseIncentive({
        sessionId: String(body.sessionId ?? "").trim(),
        productId: String(body.productId ?? "").trim(),
        live,
      });
      sendJson(res, 200, receipt);
      return;
    }

    if (url.pathname === "/api/agent/erc8004" && req.method === "GET") {
      const identity = await buildAgentIdentity();
      sendJson(res, identity.configured ? 200 : 503, identity);
      return;
    }

    if (url.pathname === "/api/wallets" && req.method === "GET") {
      const network = baseNetwork();
      const [buyerUsdc, sellerUsdc, agentUsdc, buyerEth, sellerEth, buyerTxs, sellerTxs] = await Promise.all([
        fetchUsdcBalance(network.buyerAddress).catch(() => null),
        fetchUsdcBalance(network.sellerAddress).catch(() => null),
        fetchUsdcBalance(network.agentAddress).catch(() => null),
        fetchEthBalance(network.buyerAddress).catch(() => null),
        fetchEthBalance(network.sellerAddress).catch(() => null),
        fetchRecentTransactions(network.buyerAddress, 3).catch(() => []),
        fetchRecentTransactions(network.sellerAddress, 3).catch(() => []),
      ]);
      sendJson(res, 200, {
        stripe: stripeWallet(),
        stripeLive: stripeConfigured(),
        scan8004: {
          agentId: config.scan8004.agentId || null,
          webBase: config.scan8004.webBase,
          chainId: network.chainId,
        },
        base: { ...network, buyerUsdc, sellerUsdc, agentUsdc, buyerEth, sellerEth, buyerTxs, sellerTxs },
      });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    serveStatic(url, res);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`craidt demo  →  http://0.0.0.0:${config.port}`);
  console.log(`  Stripe     →  ${stripeConfigured() ? "test key loaded" : "simulated (set STRIPE_SECRET_KEY)"}`);
  console.log(`  OpenAI     →  ${openaiConfigured() ? config.openai.model : "regex fallback (set OPENAI_API_KEY)"}`);
  console.log(`  ERC-8004   →  ${config.scan8004.agentId ? `#${config.scan8004.agentId}` : "unset (ERC8004_AGENT_ID)"}`);
  console.log(`  Chain      →  ${config.base.chainName} ${config.base.network}`);
});
