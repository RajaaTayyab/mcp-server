import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// --- Config (set these as environment variables, see README) ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY environment variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// Helper: calls our embed-text Edge Function to turn text into a vector
async function getEmbedding(text) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/embed-text`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to generate embedding");
  }
  return data.embedding;
}

const server = new McpServer({
  name: "supabase-vector-notes",
  version: "1.0.0",
});

// --- Tool 1: save_note ---
server.tool(
  "save_note",
  "Save a note to the personal knowledge base. The note's meaning is embedded so it can later be found via semantic search, even if the search words don't exactly match.",
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

      return {
        content: [
          { type: "text", text: `Saved note #${data.id}: "${data.content}"` },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error saving note: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool 2: search_similar ---
server.tool(
  "search_similar",
  "Search saved notes by meaning, not just keywords. Use this when the user asks to find, recall, or look up something they saved before.",
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
        .map(
          (n) =>
            `#${n.id} (similarity: ${n.similarity.toFixed(2)}): ${n.content}`
        )
        .join("\n");

      return { content: [{ type: "text", text: formatted }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error searching notes: ${err.message}` }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);