#!/usr/bin/env npx tsx
/**
 * Ingestion crawler for NKSC — Nacionalinis kibernetinio saugumo centras
 * (National Cyber Security Centre of Lithuania) / CERT-LT.
 *
 * Crawls three content streams from nksc.lt and nksc.lrv.lt and inserts into
 * the local better-sqlite3 database used by the Lithuanian Cybersecurity MCP:
 *
 *   1. Naujienos (news / advisories) — nksc.lrv.lt/lt/naujienos/?page=N
 *      Individual articles at /lt/naujienos/<slug>/
 *
 *   2. Rekomendacijos (recommendations / guidelines) — www.nksc.lt/rekomendacijos.html
 *      Bulletins and PDF-linked documents from /doc/biuleteniai/
 *
 *   3. Aktualūs dokumentai (current information) — www.nksc.lt/aktualu.html
 *      Regulatory info, reports, and current cybersecurity law resources
 *
 * Usage:
 *   npx tsx scripts/ingest-nksc.ts
 *   npx tsx scripts/ingest-nksc.ts --dry-run     # parse without DB writes
 *   npx tsx scripts/ingest-nksc.ts --resume       # skip already-ingested references
 *   npx tsx scripts/ingest-nksc.ts --force        # drop existing data first
 *   npx tsx scripts/ingest-nksc.ts --pages 5      # limit listing pages per stream
 *   npx tsx scripts/ingest-nksc.ts --stream news  # crawl only one stream
 *
 * Environment:
 *   NKSC_DB_PATH — SQLite database path (default: data/nksc.db)
 *
 * Rate limit: 1 500 ms between HTTP requests (respectful crawling).
 * Retry: up to 3 attempts per request with exponential backoff.
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Config & CLI flags
// ---------------------------------------------------------------------------

const DB_PATH = process.env["NKSC_DB_PATH"] ?? "data/nksc.db";
const BASE_LRV = "https://nksc.lrv.lt";
const BASE_NKSC = "https://www.nksc.lt";
const RATE_LIMIT_MS = 1_500;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2_000;
const USER_AGENT =
  "AnsvarNKSCCrawler/1.0 (+https://github.com/Ansvar-Systems/lithuanian-cybersecurity-mcp)";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const force = args.includes("--force");

function flagValue(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const maxPages = parseInt(flagValue("--pages") ?? "0", 10) || 0; // 0 = unlimited
const streamFilter = flagValue("--stream"); // "news" | "recommendations" | "documents"

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimit(): Promise<void> {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
}

async function fetchPage(url: string): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await rateLimit();
    lastRequestTime = Date.now();

    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "lt,en;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${url}`);
      }

      return await resp.text();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log(
        `  Attempt ${attempt}/${MAX_RETRIES} failed for ${url}: ${lastError.message}`,
      );

      if (attempt < MAX_RETRIES) {
        const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Lithuanian month names (genitive form, as used in dates). */
const LT_MONTHS: Record<string, string> = {
  sausio: "01",
  vasario: "02",
  kovo: "03",
  "baland\u017eio": "04",
  "gegu\u017e\u0117s": "05",
  "bir\u017eelio": "06",
  liepos: "07",
  "rugpj\u016b\u010dio": "08",
  "rugs\u0117jo": "09",
  spalio: "10",
  "lapkri\u010dio": "11",
  "gruod\u017eio": "12",
};

/** Normalise Lithuanian date string ("2024 m. spalio 15 d.") to ISO date. */
function parseLithuanianDate(raw: string): string | null {
  // Pattern: "2024 m. spalio 15 d." or "2024-10-15" or "spalio 15, 2024"
  // Also handles: "2024 m. spalio 15 d."

  // Try ISO format first
  const isoMatch = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // "2024 m. spalio 15 d." pattern
  const fullMatch = raw.match(
    /(\d{4})\s*m\.\s+(\S+)\s+(\d{1,2})\s*d\./i,
  );
  if (fullMatch) {
    const year = fullMatch[1]!;
    const monthName = fullMatch[2]!.toLowerCase();
    const day = fullMatch[3]!.padStart(2, "0");
    const month = LT_MONTHS[monthName];
    if (month) return `${year}-${month}-${day}`;
  }

  // "spalio 15, 2024" or "15 spalio 2024"
  const altMatch1 = raw.match(/(\S+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (altMatch1) {
    const monthName = altMatch1[1]!.toLowerCase();
    const day = altMatch1[2]!.padStart(2, "0");
    const year = altMatch1[3]!;
    const month = LT_MONTHS[monthName];
    if (month) return `${year}-${month}-${day}`;
  }

  const altMatch2 = raw.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (altMatch2) {
    const day = altMatch2[1]!.padStart(2, "0");
    const monthName = altMatch2[2]!.toLowerCase();
    const year = altMatch2[3]!;
    const month = LT_MONTHS[monthName];
    if (month) return `${year}-${month}-${day}`;
  }

  // "YYYY-MM" partial
  const partialMatch = raw.match(/(\d{4})-(\d{2})/);
  if (partialMatch) return `${partialMatch[1]}-${partialMatch[2]}-01`;

  // Year only
  const yearOnly = raw.match(/(\d{4})/);
  if (yearOnly) return `${yearOnly[1]}-01-01`;

  return null;
}

/** Extract visible text from a cheerio element, collapsing whitespace. */
function cleanText($el: cheerio.Cheerio<AnyNode>): string {
  return $el
    .text()
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListingEntry {
  url: string;
  title: string;
  dateRaw: string;
  summary: string;
}

interface ParsedArticle {
  reference: string;
  title: string;
  date: string | null;
  topics: string[];
  summary: string;
  fullText: string;
  cveIds: string[];
  affectedProducts: string[];
  severity: string | null;
  type: "advisory" | "guidance";
}

// ---------------------------------------------------------------------------
// News listing parser (nksc.lrv.lt/lt/naujienos/?page=N)
// ---------------------------------------------------------------------------

/**
 * Parse a news listing page from the LRV government portal.
 * Returns article stubs and whether a next page exists.
 */
function parseNewsListingPage(
  html: string,
  baseUrl: string,
): { entries: ListingEntry[]; hasNext: boolean; nextUrl: string | null } {
  const $ = cheerio.load(html);
  const entries: ListingEntry[] = [];

  // The LRV portal renders news as list items or cards with links to
  // /lt/naujienos/<slug>/ pages. Look for heading links within article/list
  // containers.

  // Strategy 1: find links whose href matches /lt/naujienos/<slug>
  $('a[href*="/lt/naujienos/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href) return;

    // Skip pagination, category, and self-referential links
    if (href.includes("?page=")) return;
    if (href === "/lt/naujienos/" || href === "/lt/naujienos") return;

    const title = cleanText($a);
    if (!title || title.length < 10) return;

    const url = new URL(href, baseUrl).toString();

    // Avoid duplicate entries
    if (entries.some((e) => e.url === url)) return;

    // Look for date in surrounding elements
    let dateRaw = "";
    const $parent = $a.parent();
    const parentText = cleanText($parent);

    // LRV date format: "2024-10-15" or "2024 m. spalio 15 d."
    const dateMatch = parentText.match(
      /(\d{4}-\d{2}-\d{2}|\d{4}\s*m\.\s+\S+\s+\d{1,2}\s*d\.)/,
    );
    if (dateMatch) dateRaw = dateMatch[1]!;

    // Also check sibling elements for dates
    if (!dateRaw) {
      $parent.siblings().each((_, sib) => {
        if (dateRaw) return;
        const sibText = cleanText($(sib));
        const dm = sibText.match(
          /(\d{4}-\d{2}-\d{2}|\d{4}\s*m\.\s+\S+\s+\d{1,2}\s*d\.)/,
        );
        if (dm) dateRaw = dm[1]!;
      });
    }

    // Summary: text content near the link that is not the title
    let summary = "";
    const $desc = $parent.find("p, .description, .summary, .lead");
    if ($desc.length > 0) {
      summary = cleanText($desc.first());
    }

    entries.push({ url, title, dateRaw, summary });
  });

  // Strategy 2: if no entries found with strategy 1, fall back to <h2>/<h3>
  // links anywhere in the body
  if (entries.length === 0) {
    $("h2 a, h3 a, h4 a").each((_, el) => {
      const $a = $(el);
      const href = $a.attr("href");
      if (!href) return;
      if (href.includes("?page=")) return;

      const title = cleanText($a);
      if (!title || title.length < 10) return;

      const url = new URL(href, baseUrl).toString();
      if (entries.some((e) => e.url === url)) return;

      entries.push({ url, title, dateRaw: "", summary: "" });
    });
  }

  // Pagination: look for ?page=N+1 link
  let hasNext = false;
  let nextUrl: string | null = null;

  $('a[href*="?page="]').each((_, el) => {
    const href = $(el).attr("href");
    const text = cleanText($(el));
    // "Kitas" = "Next" in Lithuanian, or "›", "»", or a number
    if (
      text === "Kitas" ||
      text === ">" ||
      text === "›" ||
      text === "»" ||
      text === "Toliau"
    ) {
      if (href) {
        hasNext = true;
        nextUrl = new URL(href, baseUrl).toString();
      }
    }
  });

  // If no explicit "next" link, check for sequential page numbers
  if (!hasNext) {
    const currentPageMatch = baseUrl.match(/[?&]page=(\d+)/);
    const currentPage = currentPageMatch ? parseInt(currentPageMatch[1]!, 10) : 1;
    const nextPageNum = currentPage + 1;

    $(`a[href*="page=${nextPageNum}"]`).each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        hasNext = true;
        nextUrl = new URL(href, baseUrl).toString();
      }
    });
  }

  return { entries, hasNext, nextUrl };
}

/**
 * Alternative listing parser for www.nksc.lt/naujienos/ pages.
 * The nksc.lt site uses /naujienos/psl_N.html for paginated listing and
 * /naujienos/slug.html for individual articles.
 */
function parseNkscNewsListingPage(
  html: string,
  baseUrl: string,
): { entries: ListingEntry[]; hasNext: boolean; nextUrl: string | null } {
  const $ = cheerio.load(html);
  const entries: ListingEntry[] = [];

  // Collect all internal links to /naujienos/ that are not pagination
  $('a[href*="/naujienos/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href) return;
    if (href.includes("psl_")) return; // skip pagination links
    if (href === "/naujienos/" || href === "/naujienos.html") return;

    const title = cleanText($a);
    if (!title || title.length < 10) return;

    const url = new URL(href, baseUrl).toString();
    if (entries.some((e) => e.url === url)) return;

    entries.push({ url, title, dateRaw: "", summary: "" });
  });

  // Also collect links from headings
  $("h2 a, h3 a, h4 a").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href) return;

    const title = cleanText($a);
    if (!title || title.length < 8) return;

    const url = new URL(href, baseUrl).toString();
    if (entries.some((e) => e.url === url)) return;

    entries.push({ url, title, dateRaw: "", summary: "" });
  });

  // Pagination: look for psl_N+1.html
  let hasNext = false;
  let nextUrl: string | null = null;

  const currentMatch = baseUrl.match(/psl_(\d+)\.html/);
  const currentPage = currentMatch ? parseInt(currentMatch[1]!, 10) : 1;
  const nextPageNum = currentPage + 1;

  $(`a[href*="psl_${nextPageNum}.html"]`).each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      hasNext = true;
      nextUrl = new URL(href, baseUrl).toString();
    }
  });

  // Also check for generic "next" links
  if (!hasNext) {
    $("a").each((_, el) => {
      const text = cleanText($(el)).trim();
      if (text === "»" || text === "›" || text === "Kitas" || text === "Toliau") {
        const href = $(el).attr("href");
        if (href && href.includes("psl_")) {
          hasNext = true;
          nextUrl = new URL(href, baseUrl).toString();
        }
      }
    });
  }

  return { entries, hasNext, nextUrl };
}

// ---------------------------------------------------------------------------
// Article detail parser
// ---------------------------------------------------------------------------

function parseArticleDetail(html: string, url: string): ParsedArticle {
  const $ = cheerio.load(html);

  // Title: first <h1> in content area
  const title =
    cleanText($("h1").first()) ||
    cleanText($("title")) ||
    "Untitled";

  // Date: look for Lithuanian date patterns in the page
  let dateRaw = "";

  // Search for date in meta tags first
  const metaDate =
    $('meta[property="article:published_time"]').attr("content") ??
    $('meta[name="date"]').attr("content") ??
    $('meta[name="DC.date"]').attr("content") ??
    "";
  if (metaDate) dateRaw = metaDate;

  // Search body text for Lithuanian date patterns
  if (!dateRaw) {
    const bodyText = $.text();
    // "2024 m. spalio 15 d." pattern
    const ltDateMatch = bodyText.match(
      /(\d{4}\s*m\.\s+(?:sausio|vasario|kovo|baland\u017eio|gegu\u017e\u0117s|bir\u017eelio|liepos|rugpj\u016b\u010dio|rugs\u0117jo|spalio|lapkri\u010dio|gruod\u017eio)\s+\d{1,2}\s*d\.)/i,
    );
    if (ltDateMatch) {
      dateRaw = ltDateMatch[1]!;
    }
  }

  // Fallback: ISO date in URL or text
  if (!dateRaw) {
    const isoMatch = $.text().match(/(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) dateRaw = isoMatch[1]!;
  }

  const date = parseLithuanianDate(dateRaw);

  // CVE references from body text
  const bodyHtml = $.html() ?? "";
  const cveMatches = bodyHtml.match(/CVE-\d{4}-\d{4,}/g);
  const cveIds = cveMatches ? [...new Set(cveMatches)] : [];

  // Determine type: advisory if CVEs present or certain keywords found
  const bodyLower = $.text().toLowerCase();
  const isAdvisory =
    cveIds.length > 0 ||
    /pažeidžiamyb/.test(bodyLower) ||       // pažeidžiamybė (vulnerability)
    /perspėjimas/.test(bodyLower) ||         // perspėjimas (warning)
    /grėsmė/.test(bodyLower) ||              // grėsmė (threat)
    /ddos\s+atak/.test(bodyLower) ||         // DDoS attack
    /ransomware/.test(bodyLower) ||
    /kenkėjišk/.test(bodyLower) ||           // kenkėjiška (malicious)
    /incidentas/.test(bodyLower) ||           // incidentas (incident)
    /eksploatavim/.test(bodyLower);           // eksploatavimas (exploitation)

  const type: "advisory" | "guidance" = isAdvisory ? "advisory" : "guidance";

  // Full text: extract from content area, skip nav/footer
  const contentSelectors = [
    "article",
    ".content",
    ".post-content",
    ".entry-content",
    ".article-content",
    ".page-content",
    "main",
    "#content",
  ];

  let $content: cheerio.Cheerio<AnyNode> | null = null;
  for (const sel of contentSelectors) {
    const $c = $(sel);
    if ($c.length > 0) {
      $content = $c.first();
      break;
    }
  }

  if (!$content || $content.length === 0) {
    $content = $("body");
    $content.find("nav, footer, header, script, style, noscript").remove();
  }

  const textParts: string[] = [];
  $content
    .find("h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, pre, dt, dd")
    .each((_, el) => {
      const tag = (el as Element).tagName?.toLowerCase() ?? "";
      const text = $(el).text().trim();
      if (!text) return;

      if ($(el).closest("nav, footer, header").length > 0) return;

      if (tag.startsWith("h")) {
        textParts.push(`\n${text}\n`);
      } else if (tag === "li") {
        textParts.push(`- ${text}`);
      } else {
        textParts.push(text);
      }
    });

  const fullText = textParts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Summary: first meaningful paragraph (>40 chars)
  let summary = "";
  $content.find("p").each((_, el) => {
    if (summary) return;
    const t = $(el).text().trim();
    if (t.length > 40) summary = t;
  });

  // Topics: detect cybersecurity topics from Lithuanian keywords
  const topics: string[] = [];
  const topicKeywords: Record<string, RegExp> = {
    incident_response: /incident(?:as|ų|ams)|reagavim/i,
    vulnerability: /pažeidžiamyb|vulnerability|CVE-/i,
    malware: /kenkėjišk|malware|ransomware|trojan/i,
    phishing: /fišing|phishing|sukči/i,
    ddos: /ddos|paslaugų trikdym/i,
    network_security: /tinklo saugu|network.?secur/i,
    critical_infrastructure: /ypatingos svarbos|kritin(?:ė|ės) infrastruktūr/i,
    NIS2: /NIS.?2|direktyv/i,
    risk_management: /rizik(?:os|ų) valdym|risk.?manage/i,
    access_control: /prieigos valdym|autentifikavim|access.?control/i,
    data_protection: /duomenų apsaug|data.?protect|BDAR|GDPR/i,
    cloud_security: /debesij|cloud/i,
    email_security: /el\.\s*pašt|email.?secur/i,
    supply_chain: /tiekimo grandin|supply.?chain/i,
    IoT_security: /IoT|daiktų internet/i,
    OT_security: /OT|operacinių technologij/i,
    encryption: /šifravim|kriptograf|encrypt/i,
    awareness: /sąmoning|awareness|mokym/i,
  };

  for (const [topic, pattern] of Object.entries(topicKeywords)) {
    if (pattern.test(bodyLower) || pattern.test(fullText)) {
      topics.push(topic);
    }
  }

  // Affected products (for advisories)
  const affectedProducts: string[] = [];
  if (type === "advisory") {
    const productPatterns = [
      /(?:Produktas|Programinė įranga|Software|Product)\s*[:—–]\s*(.+)/gi,
      /(?:Paveikti produktai|Affected products?)\s*[:—–]\s*(.+)/gi,
      /(?:Gamintojas|Vendor)\s*[:—–]\s*(.+)/gi,
    ];
    for (const pattern of productPatterns) {
      let pm;
      while ((pm = pattern.exec(fullText)) !== null) {
        const product = pm[1]!.trim();
        if (product && !affectedProducts.includes(product)) {
          affectedProducts.push(product);
        }
      }
    }
  }

  // Severity: check for CVSS or Lithuanian severity keywords
  let severity: string | null = null;
  const cvssMatch = fullText.match(/CVSS[^:]*:\s*(\d+\.?\d*)/i);
  if (cvssMatch) {
    const score = parseFloat(cvssMatch[1]!);
    if (score >= 9.0) severity = "critical";
    else if (score >= 7.0) severity = "high";
    else if (score >= 4.0) severity = "medium";
    else severity = "low";
  }
  if (!severity && type === "advisory") {
    if (/kritin(?:ė|is)|critical/i.test(fullText)) severity = "critical";
    else if (/aukšt(?:a|as|o)|high/i.test(fullText)) severity = "high";
    else if (/vidutin(?:ė|is)|medium/i.test(fullText)) severity = "medium";
    else severity = "high"; // default for advisories without explicit severity
  }

  // Build reference from URL slug
  let reference: string;
  if (cveIds.length > 0) {
    reference = `NKSC-CVE-${cveIds[0]}`;
  } else {
    // Extract slug from URL
    // nksc.lrv.lt: /lt/naujienos/<slug>/
    // nksc.lt: /naujienos/<slug>.html
    let slug = "";
    const lrvSlugMatch = url.match(/\/lt\/naujienos\/([^/?]+)\/?$/);
    const nkscSlugMatch = url.match(/\/naujienos\/([^/?]+?)\.html$/);

    if (lrvSlugMatch) {
      slug = lrvSlugMatch[1]!;
    } else if (nkscSlugMatch) {
      slug = nkscSlugMatch[1]!;
    } else {
      slug = url
        .replace(/https?:\/\/[^/]+/, "")
        .replace(/[/?#].*/, "")
        .replace(/\//g, "-")
        .replace(/^-/, "");
    }

    // Truncate long slugs but keep them identifiable
    if (slug.length > 80) slug = slug.substring(0, 80);
    reference = `NKSC-${type === "advisory" ? "A" : "G"}-${slug}`;
  }

  return {
    reference,
    title,
    date,
    topics,
    summary,
    fullText,
    cveIds,
    affectedProducts,
    severity,
    type,
  };
}

// ---------------------------------------------------------------------------
// Recommendations page parser (www.nksc.lt/rekomendacijos.html)
// ---------------------------------------------------------------------------

interface RecommendationEntry {
  title: string;
  url: string;
  isPdf: boolean;
}

function parseRecommendationsPage(
  html: string,
): RecommendationEntry[] {
  const $ = cheerio.load(html);
  const entries: RecommendationEntry[] = [];

  $("a").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    const title = cleanText($a);

    if (!href || !title) return;
    if (title.length < 10) return;

    // Keep links to documents (PDFs) and internal recommendation pages
    const isPdf = href.endsWith(".pdf") || href.includes("/doc/");
    const isRecommendation =
      isPdf ||
      href.includes("/rekomendacij") ||
      href.includes("/biuleteniai/") ||
      href.includes("/patarimai");

    // Skip navigation, social, and external links
    const isNavLink =
      href === "/" ||
      href === "#" ||
      href.includes("/en/") ||
      href.includes("facebook.") ||
      href.includes("twitter.") ||
      href.includes("linkedin.");

    if (!isRecommendation || isNavLink) return;

    const url = new URL(href, BASE_NKSC).toString();

    if (!entries.some((e) => e.url === url)) {
      entries.push({ title, url, isPdf });
    }
  });

  return entries;
}

// ---------------------------------------------------------------------------
// Aktualu (current documents) page parser
// ---------------------------------------------------------------------------

interface DocumentEntry {
  title: string;
  url: string;
  category: string;
}

function parseAktualuPage(html: string): DocumentEntry[] {
  const $ = cheerio.load(html);
  const entries: DocumentEntry[] = [];

  $("a").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    const title = cleanText($a);

    if (!href || !title) return;
    if (title.length < 10) return;

    const isDocument =
      href.endsWith(".pdf") ||
      href.includes("/doc/") ||
      href.includes("/aktualu") ||
      href.includes("/ksi") ||
      href.includes("/ataskaita") ||
      href.includes("/reports");

    const isNavLink =
      href === "/" ||
      href === "#" ||
      href.includes("facebook.") ||
      href.includes("twitter.");

    if (!isDocument || isNavLink) return;

    const url = new URL(href, BASE_NKSC).toString();

    // Categorise
    let category = "document";
    const titleLower = title.toLowerCase();
    if (/ataskaita|report/i.test(titleLower)) category = "report";
    else if (/įstatymas|law|teisės aktas/i.test(titleLower)) category = "legislation";
    else if (/rekomendacij|guideline/i.test(titleLower)) category = "recommendation";
    else if (/reglamentas|reguliat/i.test(titleLower)) category = "regulation";
    else if (/NIS/i.test(titleLower)) category = "nis_directive";

    if (!entries.some((e) => e.url === url)) {
      entries.push({ title, url, category });
    }
  });

  return entries;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function existingReferences(db: Database.Database): Set<string> {
  const refs = new Set<string>();
  const gRows = db
    .prepare("SELECT reference FROM guidance")
    .all() as { reference: string }[];
  for (const r of gRows) refs.add(r.reference);

  const aRows = db
    .prepare("SELECT reference FROM advisories")
    .all() as { reference: string }[];
  for (const r of aRows) refs.add(r.reference);

  return refs;
}

function insertAdvisory(
  db: Database.Database,
  article: ParsedArticle,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO advisories
      (reference, title, date, severity, affected_products, summary, full_text, cve_references)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    article.reference,
    article.title,
    article.date,
    article.severity,
    article.affectedProducts.length > 0
      ? JSON.stringify(article.affectedProducts)
      : null,
    article.summary || null,
    article.fullText,
    article.cveIds.length > 0 ? JSON.stringify(article.cveIds) : null,
  );
}

function insertGuidance(
  db: Database.Database,
  article: ParsedArticle,
): void {
  // Determine series from content
  let series = "NKSC";
  if (article.topics.includes("NIS2")) series = "NIS2";
  else if (/RRT/.test(article.fullText)) series = "RRT";

  // Determine type from content
  let docType = "guideline";
  if (article.topics.includes("awareness")) docType = "awareness";
  else if (/rekomendacij/i.test(article.fullText)) docType = "recommendation";
  else if (/ataskaita|report/i.test(article.fullText)) docType = "report";
  else if (/analizė|analysis/i.test(article.fullText)) docType = "analysis";

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO guidance
      (reference, title, title_en, date, type, series, summary, full_text, topics, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    article.reference,
    article.title,
    null, // title_en — not available from Lithuanian-language crawl
    article.date,
    docType,
    series,
    article.summary || null,
    article.fullText,
    article.topics.length > 0 ? JSON.stringify(article.topics) : null,
    "current",
  );
}

function insertRecommendation(
  db: Database.Database,
  rec: RecommendationEntry,
): string {
  const slug = rec.title
    .replace(/[^a-zA-ZąčęėįšųūžĄČĘĖĮŠŲŪŽ0-9]/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 80);
  const reference = `NKSC-REC-${slug}`;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO guidance
      (reference, title, title_en, date, type, series, summary, full_text, topics, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const docType = rec.isPdf ? "recommendation" : "guideline";

  stmt.run(
    reference,
    rec.title,
    null,
    null, // date unknown from listing
    docType,
    "NKSC",
    `NKSC rekomendacija: ${rec.title}`,
    `Dokumentas prieinamas adresu: ${rec.url}\n\n${rec.title}`,
    JSON.stringify(["recommendation"]),
    "current",
  );

  return reference;
}

function insertDocument(
  db: Database.Database,
  doc: DocumentEntry,
): string {
  const slug = doc.title
    .replace(/[^a-zA-ZąčęėįšųūžĄČĘĖĮŠŲŪŽ0-9]/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 80);
  const reference = `NKSC-DOC-${slug}`;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO guidance
      (reference, title, title_en, date, type, series, summary, full_text, topics, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    reference,
    doc.title,
    null,
    null,
    doc.category,
    "NKSC",
    `NKSC dokumentas: ${doc.title}`,
    `Dokumentas prieinamas adresu: ${doc.url}\n\n${doc.title}`,
    JSON.stringify([doc.category]),
    "current",
  );

  return reference;
}

function updateFrameworkCounts(db: Database.Database): void {
  const seriesMapping: Record<string, string> = {
    NKSC: "nksc",
    RRT: "rrt",
    NIS2: "nis2",
  };

  for (const [series, fwId] of Object.entries(seriesMapping)) {
    const row = db
      .prepare("SELECT count(*) as cnt FROM guidance WHERE series = ?")
      .get(series) as { cnt: number } | undefined;
    const count = row?.cnt ?? 0;
    db.prepare("UPDATE frameworks SET document_count = ? WHERE id = ?").run(
      count,
      fwId,
    );
  }
}

// ---------------------------------------------------------------------------
// Crawl orchestration
// ---------------------------------------------------------------------------

interface CrawlStats {
  listingPagesFetched: number;
  articlesFetched: number;
  advisoriesInserted: number;
  guidanceInserted: number;
  recommendationsInserted: number;
  documentsInserted: number;
  skipped: number;
  errors: number;
}

async function crawlNewsStream(
  db: Database.Database | null,
  existing: Set<string>,
  stats: CrawlStats,
): Promise<void> {
  log("--- Crawling news stream from nksc.lrv.lt ---");

  // Try the LRV government portal first (cleaner pagination)
  let currentUrl: string | null = `${BASE_LRV}/lt/naujienos/`;
  let pageNum = 0;
  let useFallback = false;

  while (currentUrl) {
    pageNum++;
    if (maxPages > 0 && pageNum > maxPages) {
      log(`  Reached page limit (${maxPages}), stopping news stream`);
      break;
    }

    log(`  Fetching listing page ${pageNum}: ${currentUrl}`);
    let html: string;
    try {
      html = await fetchPage(currentUrl);
      stats.listingPagesFetched++;
    } catch (err) {
      log(
        `  Failed to fetch listing page: ${err instanceof Error ? err.message : String(err)}`,
      );
      stats.errors++;

      // On first page failure, try fallback to www.nksc.lt
      if (pageNum === 1) {
        log("  Switching to fallback: www.nksc.lt/naujienos/");
        useFallback = true;
        break;
      }
      break;
    }

    const { entries, hasNext, nextUrl } = parseNewsListingPage(html, currentUrl);
    log(`  Found ${entries.length} entries on page ${pageNum}`);

    if (entries.length === 0) {
      // If first page returns 0, try fallback
      if (pageNum === 1) {
        log("  No entries found on LRV portal, switching to www.nksc.lt fallback");
        useFallback = true;
        break;
      }
      log("  No entries found, stopping");
      break;
    }

    await processArticleEntries(db, entries, existing, stats);

    currentUrl = hasNext ? nextUrl : null;
  }

  // Fallback: crawl www.nksc.lt/naujienos/ with psl_N.html pagination
  if (useFallback) {
    let fallbackUrl: string | null = `${BASE_NKSC}/naujienos/psl_1.html`;
    let fallbackPage = 0;

    while (fallbackUrl) {
      fallbackPage++;
      if (maxPages > 0 && fallbackPage > maxPages) {
        log(`  Reached page limit (${maxPages}), stopping fallback stream`);
        break;
      }

      log(`  Fetching fallback listing page ${fallbackPage}: ${fallbackUrl}`);
      let html: string;
      try {
        html = await fetchPage(fallbackUrl);
        stats.listingPagesFetched++;
      } catch (err) {
        log(
          `  Failed to fetch fallback listing: ${err instanceof Error ? err.message : String(err)}`,
        );
        stats.errors++;
        break;
      }

      const { entries, hasNext, nextUrl } = parseNkscNewsListingPage(
        html,
        fallbackUrl,
      );
      log(`  Found ${entries.length} entries on fallback page ${fallbackPage}`);

      if (entries.length === 0) {
        log("  No entries found, stopping fallback");
        break;
      }

      await processArticleEntries(db, entries, existing, stats);

      fallbackUrl = hasNext ? nextUrl : null;
    }
  }
}

async function processArticleEntries(
  db: Database.Database | null,
  entries: ListingEntry[],
  existing: Set<string>,
  stats: CrawlStats,
): Promise<void> {
  for (const entry of entries) {
    // Build a preliminary reference for resume checks
    let prelimRef = "";
    const lrvSlug = entry.url.match(/\/lt\/naujienos\/([^/?]+)\/?$/);
    const nkscSlug = entry.url.match(/\/naujienos\/([^/?]+?)\.html$/);
    if (lrvSlug) {
      const slug = lrvSlug[1]!.substring(0, 80);
      prelimRef = `NKSC-G-${slug}`;
    } else if (nkscSlug) {
      const slug = nkscSlug[1]!.substring(0, 80);
      prelimRef = `NKSC-G-${slug}`;
    }

    // Check both advisory and guidance prefixes
    if (resume && prelimRef) {
      const advRef = prelimRef.replace("NKSC-G-", "NKSC-A-");
      if (existing.has(prelimRef) || existing.has(advRef)) {
        log(`  Skipping (already ingested): ${prelimRef}`);
        stats.skipped++;
        continue;
      }
    }

    log(`  Fetching article: ${entry.title.substring(0, 70)}...`);
    let articleHtml: string;
    try {
      articleHtml = await fetchPage(entry.url);
      stats.articlesFetched++;
    } catch (err) {
      log(
        `  Failed to fetch article ${entry.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      stats.errors++;
      continue;
    }

    let article: ParsedArticle;
    try {
      article = parseArticleDetail(articleHtml, entry.url);
    } catch (err) {
      log(
        `  Failed to parse article ${entry.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      stats.errors++;
      continue;
    }

    // Augment with listing entry data
    if (!article.date && entry.dateRaw) {
      article.date = parseLithuanianDate(entry.dateRaw);
    }
    if (!article.summary && entry.summary) {
      article.summary = entry.summary;
    }

    // Second resume check with actual reference
    if (resume && existing.has(article.reference)) {
      log(`  Skipping (already ingested): ${article.reference}`);
      stats.skipped++;
      continue;
    }

    if (dryRun) {
      log(
        `  [DRY RUN] Would insert ${article.type}: ${article.reference} — ${article.title.substring(0, 60)}`,
      );
      if (article.type === "advisory") stats.advisoriesInserted++;
      else stats.guidanceInserted++;
      continue;
    }

    if (!db) continue;

    try {
      if (article.type === "advisory") {
        insertAdvisory(db, article);
        stats.advisoriesInserted++;
        existing.add(article.reference);
        log(`  Inserted advisory: ${article.reference}`);
      } else {
        insertGuidance(db, article);
        stats.guidanceInserted++;
        existing.add(article.reference);
        log(`  Inserted guidance: ${article.reference}`);
      }
    } catch (err) {
      log(
        `  DB insert error for ${article.reference}: ${err instanceof Error ? err.message : String(err)}`,
      );
      stats.errors++;
    }
  }
}

async function crawlRecommendations(
  db: Database.Database | null,
  existing: Set<string>,
  stats: CrawlStats,
): Promise<void> {
  log("--- Crawling recommendations from www.nksc.lt/rekomendacijos.html ---");

  let html: string;
  try {
    html = await fetchPage(`${BASE_NKSC}/rekomendacijos.html`);
    stats.listingPagesFetched++;
  } catch (err) {
    log(
      `  Failed to fetch recommendations page: ${err instanceof Error ? err.message : String(err)}`,
    );
    stats.errors++;
    return;
  }

  const recommendations = parseRecommendationsPage(html);
  log(`  Found ${recommendations.length} recommendations`);

  for (const rec of recommendations) {
    const slug = rec.title
      .replace(/[^a-zA-ZąčęėįšųūžĄČĘĖĮŠŲŪŽ0-9]/g, "-")
      .replace(/-+/g, "-")
      .substring(0, 80);
    const reference = `NKSC-REC-${slug}`;

    if (resume && existing.has(reference)) {
      log(`  Skipping (already ingested): ${reference}`);
      stats.skipped++;
      continue;
    }

    if (dryRun) {
      log(
        `  [DRY RUN] Would insert recommendation: ${rec.title.substring(0, 60)}`,
      );
      stats.recommendationsInserted++;
      continue;
    }

    if (!db) continue;

    try {
      insertRecommendation(db, rec);
      stats.recommendationsInserted++;
      existing.add(reference);
      log(`  Inserted recommendation: ${rec.title.substring(0, 60)}`);
    } catch (err) {
      log(
        `  DB insert error for recommendation: ${err instanceof Error ? err.message : String(err)}`,
      );
      stats.errors++;
    }
  }
}

async function crawlDocuments(
  db: Database.Database | null,
  existing: Set<string>,
  stats: CrawlStats,
): Promise<void> {
  log("--- Crawling documents from www.nksc.lt/aktualu.html ---");

  let html: string;
  try {
    html = await fetchPage(`${BASE_NKSC}/aktualu.html`);
    stats.listingPagesFetched++;
  } catch (err) {
    log(
      `  Failed to fetch aktualu page: ${err instanceof Error ? err.message : String(err)}`,
    );
    stats.errors++;
    return;
  }

  const documents = parseAktualuPage(html);
  log(`  Found ${documents.length} documents`);

  for (const doc of documents) {
    const slug = doc.title
      .replace(/[^a-zA-ZąčęėįšųūžĄČĘĖĮŠŲŪŽ0-9]/g, "-")
      .replace(/-+/g, "-")
      .substring(0, 80);
    const reference = `NKSC-DOC-${slug}`;

    if (resume && existing.has(reference)) {
      log(`  Skipping (already ingested): ${reference}`);
      stats.skipped++;
      continue;
    }

    if (dryRun) {
      log(
        `  [DRY RUN] Would insert document: ${doc.title.substring(0, 60)}`,
      );
      stats.documentsInserted++;
      continue;
    }

    if (!db) continue;

    try {
      insertDocument(db, doc);
      stats.documentsInserted++;
      existing.add(reference);
      log(`  Inserted document: ${doc.title.substring(0, 60)}`);
    } catch (err) {
      log(
        `  DB insert error for document: ${err instanceof Error ? err.message : String(err)}`,
      );
      stats.errors++;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("NKSC / CERT-LT ingestion crawler starting");
  log(`  Database: ${DB_PATH}`);
  log(
    `  Flags: ${[dryRun && "--dry-run", resume && "--resume", force && "--force", maxPages && `--pages ${maxPages}`, streamFilter && `--stream ${streamFilter}`].filter(Boolean).join(", ") || "(none)"}`,
  );

  const db = dryRun ? null : initDb();
  if (!dryRun && db) {
    log(`Database initialised at ${DB_PATH}`);
  }

  const existing = db ? existingReferences(db) : new Set<string>();
  if (resume) {
    log(`  Resume mode: ${existing.size} existing references found`);
  }

  const stats: CrawlStats = {
    listingPagesFetched: 0,
    articlesFetched: 0,
    advisoriesInserted: 0,
    guidanceInserted: 0,
    recommendationsInserted: 0,
    documentsInserted: 0,
    skipped: 0,
    errors: 0,
  };

  // Stream 1: News / advisories
  if (!streamFilter || streamFilter === "news") {
    await crawlNewsStream(db, existing, stats);
  }

  // Stream 2: Recommendations / guidelines
  if (!streamFilter || streamFilter === "recommendations") {
    await crawlRecommendations(db, existing, stats);
  }

  // Stream 3: Current documents (aktualu)
  if (!streamFilter || streamFilter === "documents") {
    await crawlDocuments(db, existing, stats);
  }

  // Update framework document counts
  if (db && !dryRun) {
    updateFrameworkCounts(db);
    log("Updated framework document counts");
  }

  // Final summary
  const totalInserted =
    stats.advisoriesInserted +
    stats.guidanceInserted +
    stats.recommendationsInserted +
    stats.documentsInserted;

  log("\n=== Ingestion complete ===");
  log(`  Listing pages fetched:     ${stats.listingPagesFetched}`);
  log(`  Articles fetched:          ${stats.articlesFetched}`);
  log(`  Advisories inserted:       ${stats.advisoriesInserted}`);
  log(`  Guidance inserted:         ${stats.guidanceInserted}`);
  log(`  Recommendations inserted:  ${stats.recommendationsInserted}`);
  log(`  Documents inserted:        ${stats.documentsInserted}`);
  log(`  Total inserted:            ${totalInserted}`);
  log(`  Skipped (resume):          ${stats.skipped}`);
  log(`  Errors:                    ${stats.errors}`);

  if (db && !dryRun) {
    const guidanceCount = (
      db.prepare("SELECT count(*) as cnt FROM guidance").get() as {
        cnt: number;
      }
    ).cnt;
    const advisoryCount = (
      db.prepare("SELECT count(*) as cnt FROM advisories").get() as {
        cnt: number;
      }
    ).cnt;
    const frameworkCount = (
      db.prepare("SELECT count(*) as cnt FROM frameworks").get() as {
        cnt: number;
      }
    ).cnt;

    log("\nDatabase totals:");
    log(`  Frameworks:  ${frameworkCount}`);
    log(`  Guidance:    ${guidanceCount}`);
    log(`  Advisories:  ${advisoryCount}`);

    db.close();
  }

  log("\nDone.");

  if (stats.errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
