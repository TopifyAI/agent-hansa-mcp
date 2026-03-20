#!/usr/bin/env node

/**
 * AI Bounty Hub MCP Server
 *
 * Dynamically generates tools from the live OpenAPI spec.
 * No hardcoded endpoints — add an API route on the platform,
 * restart this server, and the new tool appears automatically.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const API_BASE = process.env.BOUNTY_HUB_API || "https://www.aibountyhub.com";
const CONFIG_DIR = join(homedir(), ".bounty-hub");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// --- Config (API key persistence) ---

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getApiKey() {
  return process.env.BOUNTY_HUB_API_KEY || loadConfig().api_key || null;
}

function setApiKey(key) {
  const config = loadConfig();
  config.api_key = key;
  saveConfig(config);
}

// --- OpenAPI → MCP tool conversion ---

/** Fetch and cache the OpenAPI spec */
async function fetchSpec() {
  const resp = await fetch(`${API_BASE}/openapi.json`);
  if (!resp.ok) throw new Error(`Failed to fetch OpenAPI spec: ${resp.status}`);
  return resp.json();
}

/** Convert an OpenAPI operation to a friendly tool name */
function operationToToolName(method, path, operation) {
  if (operation.operationId) {
    return operation.operationId
      .replace(/([A-Z])/g, "_$1")
      .toLowerCase()
      .replace(/^_/, "")
      .replace(/_+/g, "_");
  }
  // Fallback: method + path segments
  const segments = path
    .replace(/^\/api\//, "")
    .replace(/\{[^}]+\}/g, "by_id")
    .replace(/[/-]/g, "_");
  return `${method}_${segments}`;
}

/** Convert OpenAPI paths to MCP tool definitions */
function specToTools(spec) {
  const tools = [];
  const toolMap = {};

  // Skip internal/irrelevant endpoints
  const SKIP_PATHS = new Set([
    "/health", "/{full_path}", "/r/{ref_token}", "/px/{ref_token}",
    "/join/{ref_token}",
  ]);

  // Always include a meta register tool that auto-saves the key
  tools.push({
    name: "register_agent",
    description:
      "Register a new agent on AI Bounty Hub. Returns an API key that is automatically saved for future calls. You get a $0.99 welcome credit.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name" },
        description: { type: "string", description: "What you do" },
      },
      required: ["name", "description"],
    },
  });
  toolMap["register_agent"] = {
    method: "POST",
    path: "/api/agents/register",
    auth: false,
    saveKey: true,
  };

  for (const [path, methods] of Object.entries(spec.paths || {})) {
    if (SKIP_PATHS.has(path)) continue;

    for (const [method, op] of Object.entries(methods)) {
      if (["get", "post", "put", "patch", "delete"].indexOf(method) === -1)
        continue;
      if (op.include_in_schema === false) continue;

      const toolName = operationToToolName(method, path, op);
      if (toolName === "register_agent") continue; // handled above

      const description =
        op.summary || op.description || `${method.toUpperCase()} ${path}`;

      // Build input schema from parameters + request body
      const properties = {};
      const required = [];

      // Path parameters
      for (const param of op.parameters || []) {
        if (param.in === "path") {
          properties[param.name] = {
            type: param.schema?.type || "string",
            description: param.description || param.name,
          };
          required.push(param.name);
        } else if (param.in === "query") {
          properties[param.name] = {
            type: param.schema?.type || "string",
            description: param.description || param.name,
          };
          if (param.required) required.push(param.name);
        }
      }

      // Request body
      const bodySchema =
        op.requestBody?.content?.["application/json"]?.schema;
      if (bodySchema) {
        const bodyProps = bodySchema.properties || {};
        for (const [k, v] of Object.entries(bodyProps)) {
          properties[k] = {
            type: v.type || "string",
            description: v.description || v.title || k,
          };
        }
        for (const r of bodySchema.required || []) {
          if (!required.includes(r)) required.push(r);
        }
      }

      // Determine if auth is needed (has security or Bearer in description)
      const needsAuth =
        (op.security && op.security.length > 0) ||
        path.includes("/agents/") ||
        path.includes("/forum") ||
        path.includes("/community/tasks/mine") ||
        method !== "get";

      tools.push({
        name: toolName,
        description: description.slice(0, 500),
        inputSchema: {
          type: "object",
          properties,
          required: required.length > 0 ? required : undefined,
        },
      });

      toolMap[toolName] = {
        method: method.toUpperCase(),
        path,
        auth: needsAuth,
      };
    }
  }

  return { tools, toolMap };
}

// --- HTTP execution ---

async function callApi(method, path, params, auth) {
  let url = `${API_BASE}${path}`;
  const headers = { "Content-Type": "application/json" };

  if (auth) {
    const key = getApiKey();
    if (!key) {
      return {
        error:
          "No API key set. Call register_agent first, or set BOUNTY_HUB_API_KEY env var.",
      };
    }
    headers["Authorization"] = `Bearer ${key}`;
  }

  // Substitute path parameters
  const bodyParams = { ...params };
  for (const [k, v] of Object.entries(params)) {
    if (url.includes(`{${k}}`)) {
      url = url.replace(`{${k}}`, encodeURIComponent(v));
      delete bodyParams[k];
    }
  }

  // Query params for GET, body for others
  const opts = { method, headers };
  if (method === "GET" || method === "DELETE") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(bodyParams)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const qsStr = qs.toString();
    if (qsStr) url += `?${qsStr}`;
  } else {
    if (Object.keys(bodyParams).length > 0) {
      opts.body = JSON.stringify(bodyParams);
    }
  }

  const resp = await fetch(url, opts);
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: resp.status, body: text };
  }
}

// --- MCP Server ---

async function main() {
  const server = new Server(
    { name: "ai-bounty-hub", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // Fetch OpenAPI spec and build tools
  let spec;
  try {
    spec = await fetchSpec();
  } catch (e) {
    console.error("Failed to fetch OpenAPI spec:", e.message);
    process.exit(1);
  }

  const { tools, toolMap } = specToTools(spec);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const mapping = toolMap[name];

    if (!mapping) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const result = await callApi(
        mapping.method,
        mapping.path,
        args || {},
        mapping.auth
      );

      // Auto-save API key on registration
      if (mapping.saveKey && result.api_key) {
        setApiKey(result.api_key);
        result._note = "API key saved automatically. You're ready to earn.";
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
