#!/usr/bin/env node
/**
 * Builds assets/model-tracker.svg from git history.
 *
 * Counts commits that carry a `Model:` trailer (e.g. `Model: Cursor Grok 4.6`).
 * Commits without a trailer are grouped as Unattributed. Tracker-bot refreshes
 * and merge commits are skipped.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "model-tracker.svg");
const SKIP_SUBJECT = /^chore:\s*refresh model tracker$/i;

const WIDTH = 820;
const PAD_X = 28;
const PAD_Y = 24;
const HEADER_H = 92;
const ROW_H = 36;
const MOSAIC_GAP_TOP = 20;
const CELL = 16;
const CELL_GAP = 4;
const COLS = 32;
const FOOTER_H = 36;

const FAMILY_COLORS = [
  [/grok/i, "#F59E0B"],
  [/claude|anthropic/i, "#E8A87C"],
  [/gpt|openai|chatgpt/i, "#34D399"],
  [/gemini|google/i, "#60A5FA"],
  [/composer/i, "#A78BFA"],
  [/cursor/i, "#22D3EE"],
  [/copilot/i, "#93C5FD"],
  [/unattributed|human/i, "#64748B"],
];

const FALLBACK_PALETTE = [
  "#FB7185",
  "#F472B6",
  "#C084FC",
  "#818CF8",
  "#38BDF8",
  "#2DD4BF",
  "#A3E635",
  "#FBBF24",
];

function git(args) {
  return execSync(`git ${args}`, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseCommits() {
  let raw = "";
  try {
    raw = git("log --no-merges --format=%H%x00%aI%x00%s%x00%b%x1e");
  } catch {
    return [];
  }

  return raw
    .split("\x1e")
    .map((chunk) => chunk.replace(/^\n/, "").trimEnd())
    .filter(Boolean)
    .map((chunk) => {
      const [hash = "", date = "", subject = "", body = ""] = chunk.split("\x00");
      return { hash, date, subject: subject.trim(), body };
    })
    .filter((c) => c.hash && !SKIP_SUBJECT.test(c.subject));
}

function extractModel(body) {
  const match = body.match(/^Model:\s*(.+)$/im);
  if (!match) return null;
  const name = match[1].trim().replace(/\s+/g, " ");
  return name || null;
}

function groupKey(name) {
  return name.toLowerCase();
}

function colorFor(key) {
  for (const [re, color] of FAMILY_COLORS) {
    if (re.test(key)) return color;
  }
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shortDate(iso) {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function collect(commits) {
  const models = new Map();

  for (const commit of commits) {
    const named = extractModel(commit.body);
    const label = named ?? "Unattributed";
    const key = groupKey(label);
    const existing = models.get(key);
    if (existing) {
      existing.count += 1;
      existing.commits.push(commit);
      if (named && named.length > existing.label.length) existing.label = named;
    } else {
      models.set(key, {
        key,
        label,
        count: 1,
        color: colorFor(key),
        commits: [commit],
      });
    }
  }

  const rows = [...models.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.key === "unattributed") return 1;
    if (b.key === "unattributed") return -1;
    return a.label.localeCompare(b.label);
  });

  return rows;
}

function render(commits, rows) {
  const attributed = commits.filter((c) => extractModel(c.body)).length;
  const namedRows = rows.filter((r) => r.key !== "unattributed");
  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  const mosaicRows = Math.max(1, Math.ceil(commits.length / COLS));
  const mosaicH = MOSAIC_GAP_TOP + 18 + mosaicRows * (CELL + CELL_GAP);
  const height =
    PAD_Y + HEADER_H + rows.length * ROW_H + mosaicH + FOOTER_H + PAD_Y;

  const innerW = WIDTH - PAD_X * 2;
  const labelW = 176;
  const countW = 72;
  const barX = PAD_X + labelW + 8;
  const barW = innerW - labelW - countW - 8;
  const through = shortDate(commits[0]?.date) || shortDate(new Date().toISOString());
  const stackY = PAD_Y + 52;
  const stackH = 18;

  let stackX = PAD_X;
  const stack = rows
    .map((row, i) => {
      const w =
        i === rows.length - 1
          ? PAD_X + innerW - stackX
          : Math.max(row.count > 0 ? 4 : 0, (row.count / Math.max(commits.length, 1)) * innerW);
      const x = stackX;
      stackX += w;
      if (w <= 0) return "";
      return `<rect x="${x.toFixed(1)}" y="${stackY}" width="${w.toFixed(1)}" height="${stackH}" fill="${row.color}"/>`;
    })
    .join("");

  const header = `
  <text x="${PAD_X}" y="${PAD_Y + 20}" fill="#F0F6FC" font-size="18" font-weight="600">Cursor model commits</text>
  <text x="${PAD_X}" y="${PAD_Y + 40}" fill="#8B949E" font-size="12">${esc(
    `${attributed} attributed · ${commits.length} total · ${namedRows.length} model${namedRows.length === 1 ? "" : "s"}`
  )}</text>
  <text x="${WIDTH - PAD_X}" y="${PAD_Y + 20}" fill="#8B949E" font-size="11" text-anchor="end">through ${esc(through)}</text>
  <rect x="${PAD_X}" y="${stackY}" width="${innerW}" height="${stackH}" rx="4" fill="#21262D"/>
  <g clip-path="url(#stackClip)">${stack}</g>`;

  const bars = rows
    .map((row, i) => {
      const y = PAD_Y + HEADER_H + i * ROW_H;
      const w = Math.max(6, (row.count / maxCount) * barW);
      const pct = commits.length ? Math.round((row.count / commits.length) * 100) : 0;
      return `
  <circle cx="${PAD_X + 5}" cy="${y + 12}" r="5" fill="${row.color}"/>
  <text x="${PAD_X + 16}" y="${y + 16}" fill="#E6EDF3" font-size="13">${esc(truncate(row.label, 22))}</text>
  <rect x="${barX}" y="${y + 4}" width="${barW}" height="16" rx="4" fill="#21262D"/>
  <rect x="${barX}" y="${y + 4}" width="${w.toFixed(1)}" height="16" rx="4" fill="${row.color}"/>
  <text x="${barX + barW + 10}" y="${y + 16}" fill="#8B949E" font-size="12">${row.count} · ${pct}%</text>`;
    })
    .join("");

  const chronological = [...commits].reverse();
  const mosaicY = PAD_Y + HEADER_H + rows.length * ROW_H + MOSAIC_GAP_TOP;
  const mosaicLabel = `
  <text x="${PAD_X}" y="${mosaicY}" fill="#8B949E" font-size="11">Commit mosaic (oldest → newest, colored by model)</text>`;

  const cells = chronological
    .map((commit, i) => {
      const named = extractModel(commit.body);
      const key = groupKey(named ?? "Unattributed");
      const color = rows.find((r) => r.key === key)?.color ?? "#64748B";
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = PAD_X + col * (CELL + CELL_GAP);
      const y = mosaicY + 10 + row * (CELL + CELL_GAP);
      const tip = `${named ?? "Unattributed"} · ${shortDate(commit.date)} · ${truncate(commit.subject, 72)}`;
      return `
  <rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="3" fill="${color}">
    <title>${esc(tip)}</title>
  </rect>`;
    })
    .join("");

  const legend = namedRows.length
    ? namedRows
        .slice(0, 8)
        .map((row, i) => {
          const x = PAD_X + i * 96;
          const y = height - PAD_Y - 8;
          return `
  <rect x="${x}" y="${y - 9}" width="8" height="8" rx="2" fill="${row.color}"/>
  <text x="${x + 12}" y="${y}" fill="#8B949E" font-size="10">${esc(truncate(row.label, 12))}</text>`;
        })
        .join("")
    : `
  <text x="${PAD_X}" y="${height - PAD_Y - 8}" fill="#6E7681" font-size="10">No Model: trailers yet. Named commits will split the share bar and mosaic by color.</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Cursor model commit tracker</title>
  <desc id="desc">Commit counts by Cursor AI model, parsed from git Model trailers.</desc>
  <rect width="${WIDTH}" height="${height}" rx="12" fill="#0D1117" stroke="#30363D"/>
  <defs>
    <clipPath id="stackClip"><rect x="${PAD_X}" y="${stackY}" width="${innerW}" height="${stackH}" rx="4"/></clipPath>
  </defs>
  <g font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif">
    ${header}
    ${bars}
    ${mosaicLabel}
    ${cells}
    ${legend}
  </g>
</svg>
`;
}

const commits = parseCommits();
const rows = collect(commits);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, render(commits, rows));
console.log(
  `Wrote ${OUT} (${commits.length} commits, ${rows.length} groups)`
);
