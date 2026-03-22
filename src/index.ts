#!/usr/bin/env node

/**
 * Lithuanian Cybersecurity MCP — stdio entry point.
 *
 * Provides MCP tools for querying NKSC (National Cybersecurity Centre of Lithuania)
 * guidelines, security advisories, and cybersecurity frameworks for Lithuania.
 *
 * Tool prefix: lt_cyber_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { searchGuidance, getGuidance, searchAdvisories, getAdvisory, listFrameworks } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string };
  pkgVersion = pkg.version;
} catch { /* fallback */ }

const SERVER_NAME = "lithuanian-cybersecurity-mcp";

const TOOLS = [
  {
    name: "lt_cyber_search_guidance",
    description: "Full-text search across NKSC cybersecurity guidelines, recommendations, and national standards. Covers network security, incident response, risk management, and NIS2 implementation guidance for Lithuania. Returns matching documents with reference, title, series, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'kibernetinis saugumas', 'incidentų valdymas', 'NIS2', 'tinklų sauga')" },
        type: { type: "string", enum: ["guideline", "recommendation", "standard", "policy"], description: "Filter by document type. Optional." },
        series: { type: "string", enum: ["NKSC", "RRT", "NIS2"], description: "Filter by issuing body or series. Optional." },
        status: { type: "string", enum: ["current", "superseded", "draft"], description: "Filter by document status. Optional." },
        limit: { type: "number", description: "Maximum number of results to return. Defaults to 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "lt_cyber_get_guidance",
    description: "Get a specific NKSC guidance document by reference (e.g., 'NKSC-G-2023-001', 'RRT-R-2024-01').",
    inputSchema: {
      type: "object" as const,
      properties: { reference: { type: "string", description: "NKSC document reference" } },
      required: ["reference"],
    },
  },
  {
    name: "lt_cyber_search_advisories",
    description: "Search NKSC security advisories and alerts. Returns advisories with severity, affected products, and CVE references where available.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'kritinė pažeidžiamybė', 'išpirkos reikalaujančios programos', 'sukčiavimas')" },
        severity: { type: "string", enum: ["critical", "high", "medium", "low"], description: "Filter by severity level. Optional." },
        limit: { type: "number", description: "Maximum number of results to return. Defaults to 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "lt_cyber_get_advisory",
    description: "Get a specific NKSC security advisory by reference (e.g., 'NKSC-A-2024-001').",
    inputSchema: {
      type: "object" as const,
      properties: { reference: { type: "string", description: "NKSC advisory reference" } },
      required: ["reference"],
    },
  },
  {
    name: "lt_cyber_list_frameworks",
    description: "List all cybersecurity frameworks and standard series covered in this MCP, including NKSC guidelines, RRT recommendations, and NIS2 implementation materials for Lithuania.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "lt_cyber_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

const SearchGuidanceArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["guideline", "recommendation", "standard", "policy"]).optional(),
  series: z.enum(["NKSC", "RRT", "NIS2"]).optional(),
  status: z.enum(["current", "superseded", "draft"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
const GetGuidanceArgs = z.object({ reference: z.string().min(1) });
const SearchAdvisoriesArgs = z.object({
  query: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
const GetAdvisoryArgs = z.object({ reference: z.string().min(1) });

function textContent(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }; }
function errorContent(message: string) { return { content: [{ type: "text" as const, text: message }], isError: true as const }; }

const server = new Server({ name: SERVER_NAME, version: pkgVersion }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case "lt_cyber_search_guidance": { const p = SearchGuidanceArgs.parse(args); const r = searchGuidance({ query: p.query, type: p.type, series: p.series, status: p.status, limit: p.limit }); return textContent({ results: r, count: r.length }); }
      case "lt_cyber_get_guidance": { const p = GetGuidanceArgs.parse(args); const doc = getGuidance(p.reference); return doc ? textContent(doc) : errorContent(`Guidance document not found: ${p.reference}`); }
      case "lt_cyber_search_advisories": { const p = SearchAdvisoriesArgs.parse(args); const r = searchAdvisories({ query: p.query, severity: p.severity, limit: p.limit }); return textContent({ results: r, count: r.length }); }
      case "lt_cyber_get_advisory": { const p = GetAdvisoryArgs.parse(args); const a = getAdvisory(p.reference); return a ? textContent(a) : errorContent(`Advisory not found: ${p.reference}`); }
      case "lt_cyber_list_frameworks": { const f = listFrameworks(); return textContent({ frameworks: f, count: f.length }); }
      case "lt_cyber_about": return textContent({ name: SERVER_NAME, version: pkgVersion, description: "NKSC (National Cybersecurity Centre of Lithuania) MCP server. Provides access to Lithuanian cybersecurity guidelines, security advisories, and NIS2 implementation materials.", data_source: "NKSC (https://www.nksc.lt/) and Communications Regulatory Authority — RRT (https://www.rrt.lt/)", coverage: { guidance: "NKSC guidelines, RRT recommendations, NIS2 implementation materials for Lithuania", advisories: "NKSC security advisories and alerts", frameworks: "National cybersecurity frameworks, NIS2 compliance, critical infrastructure protection" }, tools: TOOLS.map(t => ({ name: t.name, description: t.description })) });
      default: return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) { return errorContent(`Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`); }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}
main().catch(err => { process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
