// x402 tools MCP server on Cloudflare Workers: a thin, stateless MCP (streamable HTTP, JSON responses) front for the
// paid agent-audit and page-read x402 APIs. It never fakes paid results and never pays anything itself:
// - paid tools without a payment return the upstream x402 PaymentRequired (MCP x402 transport: isError + structuredContent)
// - paid tools with a caller-signed payment forward it unchanged to the upstream API, which verifies and settles it
// - two free preview tools proxy the upstream free previews (rate-limited)
const VERSION = "0.1.1";
const UP = {
  audit: { origin: "https://agent-audit.agent-audit.workers.dev", binding: "AUDIT" },
  read: { origin: "https://page-read.agent-audit.workers.dev", binding: "READ" },
};
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PAYMENT_ARG = { description: "Optional. A signed x402 v2 PaymentPayload for this tool's PaymentRequired (as an object, or base64 as in the PAYMENT-SIGNATURE HTTP header). Prefer params._meta[\"x402/payment\"]. Omit it to get the exact payment requirements first.", oneOf: [{ type: "string" }, { type: "object" }] };

const TOOLS = [
  { name: "list_services", price: null, title: "List services and prices",
    description: "Free. Lists the paid tools, their USDC prices on Base, the upstream x402 HTTP endpoints, and how to pay.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "read_page", price: "0.001", up: "read", method: "GET", path: "/v1/read", title: "Read a web page as markdown",
    description: "Paid, $0.001 USDC on Base via x402 (page-read). Fetches one public web page now and returns clean markdown or text with title, canonical URL, published time and sha256. No JavaScript execution. Fetch failures and unreadable pages are not charged. Call without payment to get the x402 requirements.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "Public http(s) URL" }, format: { type: "string", enum: ["markdown", "text"] }, maxChars: { type: "integer", minimum: 500, maximum: 50000, description: "default 10000" }, links: { type: "boolean", description: "include absolute link list" }, payment: PAYMENT_ARG }, required: ["url"] } },
  { name: "audit_x402_seller", price: "0.02", up: "audit", method: "GET", path: "/v1/audit", title: "Audit an x402 seller",
    description: "Paid, $0.02 USDC on Base via x402 (agent-audit). Read-only x402 seller and agent-readiness audit of one origin: live 402 challenge per paid route, price vs catalog, llms.txt, /.well-known/x402, openapi.json, dead doc links. JSON score, findings and fixes. Grades measure protocol conformance, not legitimacy. Call without payment to get the x402 requirements.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "Origin or paid endpoint URL" }, payment: PAYMENT_ARG }, required: ["url"] } },
  { name: "check_links", price: "0.01", up: "audit", method: "POST", path: "/v1/links", title: "Check link health",
    description: "Paid, $0.01 USDC on Base via x402 (agent-audit). Checks up to 25 URLs now: status, final URL, redirects, latency, verdict ok/broken/paid(402). Call without payment to get the x402 requirements.",
    inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25 }, payment: PAYMENT_ARG }, required: ["urls"] } },
  { name: "quote_check", price: "0.005", up: "audit", method: "GET", path: "/v1/quote-check", title: "Is this quote on that page?",
    description: "Paid, $0.005 USDC on Base via x402 (agent-audit). Fetches the page now and reports whether the quote is really there: found_exact/found_near/partial/not_found/page_unavailable, similarity, context and page sha256. Call without payment to get the x402 requirements.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, quote: { type: "string", minLength: 8, maxLength: 2000 }, payment: PAYMENT_ARG }, required: ["url", "quote"] } },
  { name: "preview_page", price: null, up: "read", method: "GET", path: "/v1/preview", title: "Free page preview",
    description: "Free, rate-limited (10 per hour). Title and the first 300 characters of a public page, from page-read's free preview.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "preview_audit", price: null, up: "audit", method: "GET", path: "/v1/preview", title: "Free audit score",
    description: "Free, rate-limited (10 per hour). Audit score, grade and fail/warn counts for one origin (no findings), from agent-audit's free preview.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
];
const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const b64 = (s) => { const u = new TextEncoder().encode(s); let x = ""; for (const c of u) x += String.fromCharCode(c); return btoa(x); };
const unb64 = (s) => { const bin = atob(s); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); };
const text = (o) => ({ type: "text", text: typeof o === "string" ? o : JSON.stringify(o) });
const err = (msg, extra = {}) => ({ isError: true, content: [text({ error: msg, charged: false, ...extra })] });

function howToPay(pr) {
  const a = (pr && pr.accepts && pr.accepts[0]) || {};
  return `How to pay: sign an EIP-3009 transferWithAuthorization for exactly ${a.amount} atomic USDC (asset ${a.asset}, ${a.network}) to payTo ${a.payTo}, validBefore about now + ${a.maxTimeoutSeconds || 120} s, random 32-byte nonce, domain {name "${a.extra?.name}", version "${a.extra?.version}"}. ` +
    `Build an x402 v2 PaymentPayload {x402Version: 2, resource: <resource above>, accepted: <accepts[0]>, payload: {signature, authorization}} and call this tool again with the same arguments and params._meta["x402/payment"] = that object (or the "payment" argument). ` +
    `Any x402 v2 client (e.g. @x402/fetch, @x402/mcp with @x402/evm) can build it. The facilitator pays gas, so you need no ETH. Payment settles only after a 2xx result; the receipt comes back in result._meta["x402/payment-response"]. ` +
    `If the status is uncertain, check USDC authorizationState(payer, nonce) on Base before signing a new payment. You can also pay the HTTP endpoint ${pr?.resource?.url || ""} directly; details: ${UP.audit.origin}/llms.txt`;
}

function upstreamRequest(t, args, ip, paymentHeader) {
  const u = new URL(UP[t.up].origin + t.path);
  const headers = { "user-agent": `x402-tools-mcp/${VERSION}`, accept: "application/json" };
  if (ip) { headers["cf-connecting-ip"] = ip; headers["x-forwarded-for"] = ip; }
  if (paymentHeader) headers["payment-signature"] = paymentHeader;
  let body;
  if (t.method === "GET") {
    for (const [k, v] of Object.entries(args)) {
      if (k === "payment" || v === undefined || v === null) continue;
      u.searchParams.set(k, k === "links" ? (v === true || v === "1" || v === 1 ? "1" : "0") : String(v));
    }
  } else { headers["content-type"] = "application/json"; body = JSON.stringify({ urls: args.urls }); }
  return new Request(u.toString(), { method: t.method, headers, body });
}
async function callUpstream(env, t, req) {
  const svc = env[UP[t.up].binding];
  return svc ? svc.fetch(req) : fetch(req);
}
function paymentFrom(params, args) {
  const p = (params && params._meta && params._meta["x402/payment"]) ?? args.payment;
  if (p === undefined || p === null || p === "") return null;
  if (typeof p === "string") { try { JSON.parse(unb64(p)); return p; } catch { try { JSON.parse(p); return b64(p); } catch { return { bad: true }; } } }
  if (typeof p === "object") return b64(JSON.stringify(p));
  return { bad: true };
}
const decodeHeader = (h) => { if (!h) return null; try { return JSON.parse(unb64(h)); } catch { return null; } };

// best-effort per-isolate limiter, same convention as the upstream workers
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); const h = (hits.get(key) || []).filter((x) => now - x < windowMs); h.push(now); hits.set(key, h);
  if (hits.size > 5000) hits.clear();
  return h.length > max;
}

async function callTool(env, params, ip) {
  const t = byName[params?.name];
  if (!t) return { rpcError: { code: -32602, message: `Unknown tool: ${params?.name}` } };
  const args = (params && typeof params.arguments === "object" && params.arguments) || {};
  if (t.name === "list_services") {
    const services = TOOLS.filter((x) => x.up).map((x) => ({ tool: x.name, priceUSDC: x.price || "free", http: `${x.method} ${UP[x.up].origin}${x.path}` }));
    const out = { services, network: "eip155:8453 (Base)", asset: "USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: env.PAY_TO, facilitator: "https://facilitator.payai.network",
      payment: "Call a paid tool without payment to get its x402 PaymentRequired; retry with params._meta[\"x402/payment\"]. This server never pays and never returns a paid result without a settled payment.",
      docs: [`${UP.audit.origin}/llms.txt`, `${UP.read.origin}/llms.txt`] };
    return { result: { content: [text(out)], structuredContent: out } };
  }
  if (!t.price) {
    if (limited(`${ip || "?"}:${t.name}`, 10, 3600_000)) return { result: err("rate_limited", { retryAfterSeconds: 3600 }) };
    if (typeof args.url !== "string" || !args.url) return { result: err("url (string) is required") };
    const r = await callUpstream(env, t, upstreamRequest(t, { url: args.url }, ip));
    const body = await r.json().catch(() => ({ error: `upstream HTTP ${r.status}` }));
    return { result: r.ok ? { content: [text(body)], structuredContent: body } : { isError: true, content: [text(body)] } };
  }
  // paid tool
  if (t.name === "check_links" && !(Array.isArray(args.urls) && args.urls.length >= 1 && args.urls.length <= 25)) return { result: err("urls must be an array of 1-25 URLs") };
  if (t.name !== "check_links" && (typeof args.url !== "string" || !args.url)) return { result: err("url (string) is required") };
  const pay = paymentFrom(params, args);
  if (pay && pay.bad) return { result: err("payment must be an x402 v2 PaymentPayload object or its base64 JSON") };
  const r = await callUpstream(env, t, upstreamRequest(t, args, ip, pay));
  const settle = decodeHeader(r.headers.get("payment-response"));
  if (r.status === 402) {
    const pr = decodeHeader(r.headers.get("payment-required")) || (await r.json().catch(() => null));
    if (!pr) return { result: err(`upstream returned 402 without requirements`) };
    if (!pr.error) pr.error = pay ? "Payment was not accepted" : "Payment required to access this resource";
    return { result: { isError: true, structuredContent: pr, content: [text(pr), text(howToPay(pr))], ...(settle ? { _meta: { "x402/payment-response": settle } } : {}) } };
  }
  const body = await r.json().catch(() => ({ error: `upstream HTTP ${r.status}` }));
  if (r.ok && settle && settle.success) return { result: { content: [text(body)], structuredContent: body, _meta: { "x402/payment-response": settle } } };
  // 4xx/5xx: upstream does not settle on errors (and validates input before verifying), so nothing was charged
  return { result: { isError: true, content: [text({ upstreamStatus: r.status, charged: false, ...body })] } };
}

const SERVER_INFO = { name: "x402-tools", title: "agent-audit + page-read (x402)", version: VERSION, websiteUrl: "https://agent-audit.agent-audit.workers.dev/llms.txt" };
const INSTRUCTIONS = "Pay-per-call web tools paid in USDC on Base via x402: read_page ($0.001), quote_check ($0.005), check_links ($0.01), audit_x402_seller ($0.02). Call a paid tool without payment to get its x402 PaymentRequired, then retry with params._meta[\"x402/payment\"]. preview_page and preview_audit are free (10/hour). list_services is free.";

async function handleRpc(env, m, ip) {
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return { jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  const isNote = m.id === undefined;
  let out;
  switch (m.method) {
    case "initialize": {
      const want = m.params?.protocolVersion;
      out = { result: { protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } };
      break;
    }
    case "ping": out = { result: {} }; break;
    case "tools/list":
      out = { result: { tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...READ_ONLY } })) } };
      break;
    case "tools/call": out = await callTool(env, m.params, ip); break;
    case "resources/list": out = { result: { resources: [] } }; break;
    case "prompts/list": out = { result: { prompts: [] } }; break;
    default:
      if (m.method.startsWith("notifications/")) return null;
      out = { rpcError: { code: -32601, message: `Method not found: ${m.method}` } };
  }
  if (isNote) return null;
  return out.rpcError ? { jsonrpc: "2.0", id: m.id, error: out.rpcError } : { jsonrpc: "2.0", id: m.id, result: out.result };
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id, authorization", "access-control-expose-headers": "mcp-protocol-version" };
const json = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...CORS, ...h } });

const llms = () => `# x402-tools MCP server (agent-audit + page-read)

> Remote MCP server (streamable HTTP, stateless, JSON responses) at ${"https://mcp.agent-audit.workers.dev/mcp"}. It wraps the agent-audit and page-read x402 APIs. Paid tools are paid per call in USDC on Base via x402; this server never pays, never charges by itself, and never returns a paid result without a settled payment. No signup, no API key.

## Tools

- read_page: $0.001. One public page as markdown/text (page-read GET /v1/read).
- quote_check: $0.005. Is this quote on that page right now? (agent-audit GET /v1/quote-check)
- check_links: $0.01. Health of up to 25 URLs (agent-audit POST /v1/links).
- audit_x402_seller: $0.02. x402 seller + agent-readiness audit (agent-audit GET /v1/audit).
- preview_page, preview_audit: free, 10 per hour.
- list_services: free catalog.

## How to pay (MCP x402 transport)

1. Call a paid tool without payment. The result has isError: true and structuredContent = the x402 v2 PaymentRequired of the upstream HTTP endpoint (scheme exact, network eip155:8453, USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, payTo ${"0xa31bE3a1Ac1dde980dB8D18D32E7cd9Ab557360A"}).
2. Sign it (EIP-3009) with any x402 v2 client and call the tool again with the same arguments and params._meta["x402/payment"] = the PaymentPayload (or the "payment" argument, object or base64).
3. The upstream API verifies, runs the call, and settles only on a 2xx result. The receipt is in result._meta["x402/payment-response"] {success, transaction, network, payer}.
- Settlement is done by the PayAI facilitator; you need no ETH. If the status is uncertain, check USDC authorizationState(payer, nonce) before signing again. Full buyer guide: https://agent-audit.agent-audit.workers.dev/llms.txt

## Connect

- MCP client config: {"mcpServers": {"x402-tools": {"url": "https://mcp.agent-audit.workers.dev/mcp"}}}
- curl: curl -s https://mcp.agent-audit.workers.dev/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

## Source

MIT source: https://github.com/agent-audit-x402/x402-tools-mcp

## Operator

Operated by the GitHub account agent-audit-x402 (https://github.com/agent-audit-x402), the shared official account for agent-audit and page-read; contact parafield-dev@mail.grokbot.com. Same operator and payee as https://agent-audit.agent-audit.workers.dev and https://page-read.agent-audit.workers.dev.
`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const ip = req.headers.get("cf-connecting-ip") || "";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" || url.pathname === "/llms.txt") return new Response(llms(), { headers: { "content-type": "text/plain; charset=utf-8", ...CORS } });
    if (url.pathname === "/health") return json({ ok: true, version: VERSION, upstreams: Object.values(UP).map((u) => u.origin) });
    if (url.pathname === "/.well-known/mcp/server-card.json" || url.pathname === "/.well-known/mcp.json")
      return json({ serverInfo: SERVER_INFO, transport: { type: "streamable-http", url: `${url.origin}/mcp` }, capabilities: { tools: { listChanged: false } }, tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    if (url.pathname !== "/mcp") return json({ error: "not_found", mcp: `${url.origin}/mcp`, docs: `${url.origin}/llms.txt` }, 404);
    if (req.method === "GET") return json({ error: "This server does not offer an SSE stream; POST JSON-RPC to /mcp." }, 405, { allow: "POST, OPTIONS" });
    if (req.method === "DELETE") return new Response(null, { status: 405, headers: { allow: "POST, OPTIONS", ...CORS } });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
    if (limited(`${ip}:rpc`, 120, 60_000)) return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "rate_limited" } }, 429);
    const raw = await req.text();
    if (raw.length > 65536) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "body too large" } }, 413);
    let msg; try { msg = JSON.parse(raw); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
    const pv = { "mcp-protocol-version": PROTOCOLS.includes(req.headers.get("mcp-protocol-version")) ? req.headers.get("mcp-protocol-version") : PROTOCOLS[1] };
    if (Array.isArray(msg)) {
      if (msg.length > 10) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch too large" } }, 400);
      const outs = (await Promise.all(msg.map((m) => handleRpc(env, m, ip)))).filter(Boolean);
      return outs.length ? json(outs, 200, pv) : new Response(null, { status: 202, headers: CORS });
    }
    const out = await handleRpc(env, msg, ip);
    return out ? json(out, 200, pv) : new Response(null, { status: 202, headers: CORS });
  },
};
