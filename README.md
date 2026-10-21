# x402-tools MCP server (agent-audit + page-read)

A small, stateless remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers. It gives MCP clients four read-only web tools that are paid per call in USDC on Base via [x402](https://www.x402.org), plus free previews. There is no signup and no API key.

- **Hosted endpoint:** `https://mcp.agent-audit.workers.dev/mcp` (streamable HTTP; JSON responses; no SSE stream)
- **Docs for agents:** https://mcp.agent-audit.workers.dev/llms.txt
- **MCP Registry:** `io.github.agent-audit-x402/x402-tools`

The server is a thin front for two existing x402 HTTP APIs run by the same operator, with the same payee:
- [page-read](https://page-read.agent-audit.workers.dev/llms.txt)
- [agent-audit](https://agent-audit.agent-audit.workers.dev/llms.txt)

## Tools

| Tool | Price (USDC on Base) | What it does | Upstream HTTP endpoint |
|---|---|---|---|
| `read_page` | $0.001 | One public web page as clean markdown or text, with title, canonical URL, published time and sha256 | `GET page-read /v1/read` |
| `quote_check` | $0.005 | Is this quote really on that page right now? Verdict, similarity, context and page sha256 | `GET agent-audit /v1/quote-check` |
| `check_links` | $0.01 | Health of up to 25 URLs: status, final URL, redirects, latency and verdict | `POST agent-audit /v1/links` |
| `audit_x402_seller` | $0.02 | Read-only x402 seller and agent-readiness audit of one origin: live 402 per paid route, price vs catalogue, llms.txt, /.well-known/x402, openapi.json, dead doc links | `GET agent-audit /v1/audit` |
| `preview_page` | free, 10 per hour | Title and the first 300 characters of a page | `GET page-read /v1/preview` |
| `preview_audit` | free, 10 per hour | Audit score, grade and counts only | `GET agent-audit /v1/preview` |
| `list_services` | free | Catalogue, prices, payee and docs | n/a |

Limits:
- JavaScript is not executed.
- Private, loopback and link-local targets are refused.
- Invalid input and failed fetches are not charged; payment settles only after a 2xx result.
- Audit grades measure protocol conformance, not whether a seller is legitimate.

## How payment works (x402 over MCP)

This follows the [x402 v2 MCP transport](https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md):

1. Call a paid tool without payment. The tool result has `isError: true`, and `structuredContent` is the x402 v2 `PaymentRequired` of the upstream HTTP endpoint:
   - scheme `exact`, network `eip155:8453`;
   - asset USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, amount in atomic units (6 decimals);
   - `payTo` `0xa31bE3a1Ac1dde980dB8D18D32E7cd9Ab557360A`, `maxTimeoutSeconds` 120.

   The same JSON is in `content[0].text`, and `content[1]` has plain-language payment steps.
2. Sign an EIP-3009 `transferWithAuthorization` for exactly that amount with any x402 v2 client, for example `@x402/fetch` or `@x402/mcp` with `@x402/evm`. Then call the tool again with the same arguments and the `PaymentPayload` in `params._meta["x402/payment"]`. For clients that can't set `_meta`, put it in the `payment` argument instead, as an object or as base64 JSON.
3. The server forwards the payment unchanged to the upstream API as the `PAYMENT-SIGNATURE` header. The upstream API verifies it with the facilitator ([PayAI](https://facilitator.payai.network)), runs the call, and settles only on success. The receipt `{success, transaction, network, payer}` comes back in `result._meta["x402/payment-response"]`.

Further notes:
- The facilitator pays gas, so the buyer needs no ETH.
- If the payment status is uncertain, check USDC `authorizationState(payer, nonce)` on Base before signing a new payment.
- This server never pays, never charges by itself, holds no keys, and never returns a paid result without a settled payment.

## Try it

```sh
curl -s https://mcp.agent-audit.workers.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# unpaid paid-tool call -> x402 PaymentRequired
curl -s https://mcp.agent-audit.workers.dev/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_page","arguments":{"url":"https://example.com"}}}'

# MCP Inspector CLI
npx @modelcontextprotocol/inspector --cli https://mcp.agent-audit.workers.dev/mcp --transport http --method tools/list
```

MCP client config:

```json
{ "mcpServers": { "x402-tools": { "url": "https://mcp.agent-audit.workers.dev/mcp" } } }
```

## Self-hosting

The code has no runtime dependencies: one file, `src/index.js`. It reaches the two upstream workers through Cloudflare [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) (`AUDIT`, `READ` in `wrangler.toml`). Without bindings it falls back to plain `fetch` of the public URLs. To run your own copy:

```sh
npm install
export CLOUDFLARE_API_TOKEN=...      # your own token; never commit it
export CLOUDFLARE_ACCOUNT_ID=...     # your own account id
npx wrangler deploy
```

No secrets are needed or stored. Set `PAY_TO` in `wrangler.toml` only for display; the payee in each challenge comes from the upstream API.

## Operator

Run by the GitHub account [agent-audit-x402](https://github.com/agent-audit-x402), the shared official account for agent-audit and page-read. Contact: parafield-dev@mail.grokbot.com.

Listed in the [x402 Blockchains registry](https://github.com/X402blockchains/x402-registry/pull/14). There are no customer sales yet.

## License

MIT
