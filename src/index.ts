// ============================================================================
//  mini-flytripvisa-template — Cloudflare Worker
//  POST /api/ai-chat  →  Muse API (SSE stream)  →  Browser (SSE)
//
//  SECURITY: The Muse API key NEVER leaves the server. The browser only
//  calls /api/ai-chat (same origin). The key is stored in env.MUSE_API_KEY
//  (set via `wrangler secret put`), never in any client-side file.
// ============================================================================

// ============================================================================
//  MUSE ADAPTER — ISOLATED SECTION
//  ----------------------------------------------------------------------------
//  If your Muse API uses a different request / response / stream format,
//  change ONLY these two functions:
//    1. buildMuseBody()
//    2. parseMuseStreamChunk()
//
//  Nothing else (SSE framing, CORS, error handling, static-asset passthrough)
//  depends on the Muse wire format.
// ============================================================================

interface Env {
  MUSE_API_URL: string;
  MUSE_API_KEY: string;
  MUSE_MODEL: string;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

interface VisaContext {
  country: string;
  type: string;
  time: string;
  badge: string;
  img: string;
}

interface ChatRequest {
  message: string;
  context?: { visa?: VisaContext } | null;
  source?: string;
}

/**
 * Build the JSON body sent to the Muse API.
 * Override this if your Muse endpoint expects a different shape.
 */
function buildMuseBody(
  message: string,
  context: ChatRequest['context'],
  model: string
): unknown {
  const systemPrompt = context?.visa
    ? `You are Fly Dragon 🐉 AI Assistant for Fly Trip Visa. The user is asking about ${context.visa.country}. Visa type: ${context.visa.type}. Processing time: ${context.visa.time}. Provide helpful, accurate visa and travel advice. Be concise and friendly.`
    : `You are Fly Dragon 🐉 AI Assistant for Fly Trip Visa. Provide helpful visa, flight, and hotel advice. Be concise and friendly.`;

  return {
    model,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ],
    max_tokens: 1024,
    temperature: 0.7,
  };
}

/**
 * Parse one SSE line coming FROM Muse.
 *
 * Default assumed format (OpenAI-compatible):
 *   data: {"choices":[{"delta":{"content":"..."}}]}
 *   data: [DONE]
 *
 * If your Muse API streams differently, change only this function.
 * Return null for frames that should be ignored.
 */
function parseMuseStreamChunk(line: string): string | null {
  const trimmed = line.trim();

  if (!trimmed) return null;
  if (trimmed === 'data: [DONE]') return null;
  if (!trimmed.startsWith('data: ')) return null;

  try {
    const json = JSON.parse(trimmed.slice(6)); // strip "data: "
    return json.choices?.[0]?.delta?.content ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
//  END MUSE ADAPTER
// ============================================================================

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // ---- CORS preflight ----
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // ---- API route (server-side proxy to Muse) ----
    if (url.pathname === '/api/ai-chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    // ---- Static assets (index.html, images, fonts, etc.) ----
    return env.ASSETS.fetch(request);
  },
};

// ----------------------------------------------------------------------------
//  Streaming chat handler
// ----------------------------------------------------------------------------
async function handleChat(request: Request, env: Env): Promise<Response> {
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (!body.message || typeof body.message !== 'string') {
    return jsonError('Missing "message" field', 400);
  }

  if (!env.MUSE_API_KEY) {
    return jsonError('MUSE_API_KEY is not configured on the server', 500);
  }

  const museBody = buildMuseBody(
    body.message,
    body.context,
    env.MUSE_MODEL || 'muse-spark-1.3'
  );

  // ---- Call Muse API (key stays server-side) ----
  let museRes: Response;
  try {
    museRes = await fetch(env.MUSE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.MUSE_API_KEY}`,
      },
      body: JSON.stringify(museBody),
    });
  } catch (err) {
    console.error('[mini-flytripvisa-template] Muse fetch error:', err);
    return jsonError('Failed to reach Muse API', 502);
  }

  if (!museRes.ok || !museRes.body) {
    const text = await museRes.text().catch(() => '');
    console.error(
      `[mini-flytripvisa-template] Muse API error ${museRes.status}:`,
      text
    );
    return jsonError(`Muse API error (${museRes.status})`, 502);
  }

  // ---- Pipe Muse SSE → Browser SSE ----
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    const reader = museRes.body!.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          await writer.write(encoder.encode('data: [DONE]\n\n'));
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          const token = parseMuseStreamChunk(line);
          if (token) {
            const frame = `data: ${JSON.stringify({ token })}\n\n`;
            await writer.write(encoder.encode(frame));
          }
        }
      }
    } catch (err) {
      console.error('[mini-flytripvisa-template] Stream error:', err);
      await writer.write(
        encoder.encode(
          `data: ${JSON.stringify({ error: 'Stream interrupted' })}\n\n`
        )
      );
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(),
    },
  });
}

// ----------------------------------------------------------------------------
//  Helpers
// ----------------------------------------------------------------------------
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(),
      },
    }
  );
}
