import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// --- Config ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const MCP_SHARED_SECRET = process.env.MCP_SHARED_SECRET; // protects your endpoint
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY environment variables.");
  process.exit(1);
}
if (!MCP_SHARED_SECRET) {
  console.error("Missing MCP_SHARED_SECRET environment variable. Set this to any random string -- it's your endpoint's password.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

async function getEmbedding(text) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/embed-text`, {
    method: "POST",
    headers: { apikey: SUPABASE_SECRET_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to generate embedding");
  return data.embedding;
}

// --- Build the MCP server (same tools as the stdio version) ---
function createServer() {
  const server = new McpServer({ name: "supabase-vector-notes", version: "1.0.0" });

  server.tool(
    "save_note",
    "Save a note to the personal knowledge base, embedded for later semantic search.",
    { content: z.string().describe("The text content of the note to save") },
    async ({ content }) => {
      try {
        const embedding = await getEmbedding(content);
        const { data, error } = await supabase
          .from("notes")
          .insert({ content, embedding })
          .select("id, content")
          .single();
        if (error) throw error;
        return { content: [{ type: "text", text: `Saved note #${data.id}: "${data.content}"` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error saving note: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "search_similar",
    "Search saved notes by meaning, not just keywords.",
    {
      query: z.string().describe("What to search for, in natural language"),
      limit: z.number().optional().describe("Max number of results (default 5)"),
    },
    async ({ query, limit }) => {
      try {
        const queryEmbedding = await getEmbedding(query);
        const { data, error } = await supabase.rpc("match_notes", {
          query_embedding: queryEmbedding,
          match_threshold: 0.5,
          match_count: limit ?? 5,
        });
        if (error) throw error;
        if (!data || data.length === 0) {
          return { content: [{ type: "text", text: "No matching notes found." }] };
        }
        const formatted = data
          .map((n) => `#${n.id} (similarity: ${n.similarity.toFixed(2)}): ${n.content}`)
          .join("\n");
        return { content: [{ type: "text", text: formatted }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error searching notes: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

// --- Express app ---
const app = express();
app.use(express.json());

// Simple shared-secret check -- every request must include this header.
// This is what stands in for real auth on a beginner project like this one.
app.use("/mcp", (req, res, next) => {
  const provided = req.headers["x-mcp-secret"];
  if (provided !== MCP_SHARED_SECRET) {
    return res.status(401).json({ error: "Unauthorized: missing or incorrect x-mcp-secret header" });
  }
  next();
});

// Stateless mode: a fresh server + transport per request. Simple and reliable
// for a personal tool -- no session bookkeeping to worry about.
app.post("/mcp", async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/", (req, res) => {
  res.send("MCP server is running. Endpoint: POST /mcp");
});

app.listen(PORT, () => {
  console.log(`MCP HTTP server listening on port ${PORT}, endpoint: /mcp`);
});