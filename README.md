# Vector Notes MCP Server

A remote **MCP (Model Context Protocol) server** that gives any Claude client — Desktop, Code, or web — semantic memory: save notes and recall them by *meaning*, not keyword matching. Backed by Postgres + pgvector, deployed as a live HTTPS service.

**Live endpoint:** `https://mcp-server-aih3.onrender.com/mcp`

---

## What it does

Two tools exposed over MCP:

| Tool | Description |
|---|---|
| `save_note` | Saves a note. Text is embedded (converted to a 768-number vector representing its meaning) and stored in Postgres. |
| `search_similar` | Searches saved notes by meaning. Finds "the quarterly report is due Friday" when you search "deadlines," even though no words overlap. |

## Architecture

```
Claude Desktop / Claude Code
         │  Streamable HTTP + x-mcp-secret header
         ▼
  MCP Server (Node.js, Express, deployed on Render)
         │
         ▼
  Supabase Edge Function (embed-text)
         │  calls Gemini API
         ▼
  Supabase Postgres + pgvector
  (notes table + match_notes() similarity search function)
```

## Tech stack

- **Protocol:** Model Context Protocol (MCP), Streamable HTTP transport, JSON-RPC 2.0
- **Server:** Node.js, Express, `@modelcontextprotocol/sdk`
- **Database:** Supabase (Postgres) with the `pgvector` extension
- **Embeddings:** Google Gemini API (`gemini-embedding-001`, 768 dimensions)
- **Serverless logic:** Supabase Edge Functions (Deno)
- **Hosting:** Render (free tier)
- **Auth:** Shared-secret header (`x-mcp-secret`) — see [Known limitations](#known-limitations)

## Why it's structured this way

- **Edge Function separates the embedding call from the database layer.** The Gemini API key never touches the MCP server's environment directly exposed to clients — it's isolated in a server-side function.
- **pgvector's `match_notes()` function keeps search logic in the database**, not scattered across application code, using cosine similarity (`<=>` operator) for fast approximate nearest-neighbor search via an `ivfflat` index.
- **Streamable HTTP instead of stdio** so the server is reachable from any device, not tied to one local machine running one specific desktop app.

## Setup

Full step-by-step instructions (Supabase project, Edge Function deployment, MCP server, Render hosting) are in [`mcp-server/README.md`](./mcp-server/README.md).

Quick version:
```bash
# 1. Database
# run schema.sql in the Supabase SQL editor

# 2. Edge Function
supabase functions deploy embed-text --no-verify-jwt
supabase secrets set GEMINI_API_KEY=your-key

# 3. MCP server (local test)
cd mcp-server && npm install
SUPABASE_URL=... SUPABASE_SECRET_KEY=... MCP_SHARED_SECRET=... npm start

# 4. Connect from Claude Code
claude mcp add --transport http vector-notes https://your-deployment-url/mcp \
  --header "x-mcp-secret: your-secret"
```

## Debugging log (the actual learning)

Real problems hit and fixed during development, kept here because the debugging is the more interesting part of this project than the happy path:

- **Groq's advertised embedding model didn't exist on the account** (`model_not_found`) — confirmed by querying `/v1/models` directly rather than trusting docs, then switched providers to Gemini.
- **Supabase's new key format (`sb_secret_...`) isn't a JWT** — Edge Functions reject it under default JWT verification. Fixed by deploying with `--no-verify-jwt` and switching to the `apikey` header instead of `Authorization: Bearer`.
- **PowerShell mangles inline JSON in curl calls** — worked around by writing JSON to a file and using `-d "@file.json"` instead of inline strings.
- **claude.ai's web connector UI has no custom-header field**, despite the underlying MCP spec supporting header-based auth — routed around it using Claude Code's native `--header` flag and the `mcp-remote` bridge for Desktop.

## Known limitations

This is a learning/demo project, not production infrastructure:

- **No per-user isolation.** All notes live in one shared table — anyone with server access sees everyone's notes. RLS was deliberately not enabled since the server connects with a privileged key (see below).
- **Shared-secret auth, not OAuth.** Simple and functional, but not something you'd expose to untrusted users — the URL + secret is the entire security boundary.
- **Render free tier cold starts** (~20-30s) after inactivity.
