# Integrating Claude Adaptive Thinking Models (Fable 5, Opus 4.6+)

Claude Fable 5 and Opus 4.6+ use a **different API contract** than earlier Claude models. This guide covers the key differences and provides working examples for Python and Next.js/TypeScript.

---

## Which Models Use Adaptive Thinking?

The following models use the new adaptive thinking API:

| Model ID | Adaptive Thinking | Budget Thinking | Temperature | Native 1M Context |
|----------|:-:|:-:|:-:|:-:|
| `claude-fable-5` | ✅ Required | ❌ Rejected (400) | ❌ Deprecated | ✅ (no beta needed) |
| `claude-opus-4-8` | ✅ Required | ❌ Rejected (400) | ❌ Deprecated | ✅ (needs beta for tiered pricing) |
| `claude-opus-4-7` | ✅ Required | ❌ Rejected (400) | ❌ Deprecated | ✅ (needs beta for tiered pricing) |
| `claude-opus-4-6` | ✅ Supported | ✅ Also supported | ❌ Deprecated | ✅ (needs beta for tiered pricing) |
| `claude-sonnet-4-6` | ❌ | ✅ (uses budget) | ✅ | ✅ (needs beta) |
| `claude-sonnet-4-5` | ❌ | ✅ (uses budget) | ✅ | Needs beta |

> **Verified against the live API (June 2026)**: `claude-opus-4-6` is transitional — it accepts **both** `{"type": "enabled", "budget_tokens": N}` and `{"type": "adaptive"}`. Opus 4.7, 4.8, and Fable 5 **only** accept adaptive and return a 400 for budget thinking: `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.`

---

## Key Differences: Adaptive vs Budget Thinking

| Feature | Budget Models (Sonnet 4.x) | Adaptive Models (Fable 5, Opus 4.6+) |
|---------|---------------------------|---------------------------------------|
| **Temperature** | Supported (`temperature: 1.0` when thinking) | **Deprecated** — do NOT send |
| **Thinking** | `{ type: "enabled", budget_tokens: N }` | `{ type: "adaptive" }` |
| **Effort Control** | Via `thinking.budget_tokens` | Via `output_config.effort` |
| **Effort Levels** | N/A (token count) | `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| **Max Output Tokens** | Varies (8K-128K) | 128,000 |
| **Disable Reasoning** | `{ type: "disabled" }` or omit | Just omit `thinking` (do NOT send `{ type: "disabled" }`) |

### Streaming Behavior (Live-API Verified)

Adaptive thinking **does stream incrementally** — there is no buffering of the thinking block on the API side:

- A hard reasoning prompt against `claude-opus-4-6` produced **87 separate `thinking_delta` events over ~79 seconds** before the first `text_delta` arrived.
- A trivial prompt finishes thinking in under a second, often in a **single `thinking_delta`** — this can look like "thinking isn't streaming" when it's simply done instantly.
- Event order: `message_start` → `content_block_start (thinking)` → N× `thinking_delta` → `signature_delta` → `content_block_stop` → `content_block_start (text)` → N× `text_delta` → ...
- With tools, the `tool_use` block streams `input_json_delta` chunks normally after the thinking block closes.
- `signature_delta` arrives at the end of each thinking block (an opaque ~300–600 char signature). It's required if you want to round-trip thinking blocks back in multi-turn history.
- The API may also emit `redacted_thinking` content blocks (encrypted thinking, e.g. for safety-flagged content). Handle them gracefully — there is nothing displayable.

### Context Window: Native 1M

Fable 5 has **native 1M context** — no beta flag needed. Opus 4.6/4.7/4.8 also have native 1M context windows but need the `context-1m-2025-08-07` beta header for tiered pricing.

For Fable 5:
- You can send up to ~870K tokens of conversation history (after reserving space for output + buffer)
- No need to set `anthropicBeta1MContext` in Roo Code settings
- Pricing is flat across all context sizes ($10/M input, $50/M output)

---

## Python Integration

### Install the SDK

```bash
pip install anthropic>=0.50.0
```

> **Important**: You need SDK version ≥0.50.0 for `thinking.type: "adaptive"` and `output_config` support.

### Basic Usage

```python
import anthropic

client = anthropic.Anthropic(api_key="your-api-key")

message = client.messages.create(
    model="claude-fable-5",
    max_tokens=128_000,
    # DO NOT send temperature — it's deprecated for this model
    thinking={
        "type": "adaptive"
    },
    output_config={
        "effort": "high"  # "low" | "medium" | "high" | "xhigh" | "max"
    },
    messages=[
        {"role": "user", "content": "Explain quantum computing in simple terms."}
    ]
)

# Extract the response text
for block in message.content:
    if block.type == "thinking":
        print(f"[Thinking]: {block.thinking}")
    elif block.type == "text":
        print(f"[Response]: {block.text}")
```

### Streaming

```python
import anthropic

client = anthropic.Anthropic(api_key="your-api-key")

with client.messages.stream(
    model="claude-fable-5",
    max_tokens=128_000,
    thinking={"type": "adaptive"},
    output_config={"effort": "high"},
    messages=[
        {"role": "user", "content": "Write a Python web scraper."}
    ]
) as stream:
    for event in stream:
        if event.type == "content_block_start":
            if event.content_block.type == "thinking":
                print("[Thinking started]")
            elif event.content_block.type == "text":
                print("[Text started]")
        elif event.type == "content_block_delta":
            if event.delta.type == "thinking_delta":
                print(event.delta.thinking, end="", flush=True)
            elif event.delta.type == "text_delta":
                print(event.delta.text, end="", flush=True)
```

### With Prompt Caching

```python
message = client.messages.create(
    model="claude-fable-5",
    max_tokens=128_000,
    thinking={"type": "adaptive"},
    output_config={"effort": "high"},
    system=[
        {
            "type": "text",
            "text": "You are a helpful coding assistant.",
            "cache_control": {"type": "ephemeral"}
        }
    ],
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Help me refactor this code...",
                    "cache_control": {"type": "ephemeral"}
                }
            ]
        }
    ],
    extra_headers={
        "anthropic-beta": "prompt-caching-2024-07-31"
    }
)
```

### With Tool Use

```python
message = client.messages.create(
    model="claude-fable-5",
    max_tokens=128_000,
    thinking={"type": "adaptive"},
    output_config={"effort": "high"},
    tools=[
        {
            "name": "get_weather",
            "description": "Get the current weather for a location",
            "input_schema": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "City name"
                    }
                },
                "required": ["location"]
            }
        }
    ],
    messages=[
        {"role": "user", "content": "What's the weather in Berlin?"}
    ]
)
```

---

## Next.js / TypeScript Integration

### Install the SDK

```bash
npm install @anthropic-ai/sdk@latest
# or
pnpm add @anthropic-ai/sdk@latest
```

> You need SDK version ≥0.50.0 for full Fable 5 support. If using an older SDK, you'll need to cast types (see "Older SDK Workaround" below).

### API Route (App Router)

```typescript
// app/api/chat/route.ts
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export async function POST(req: NextRequest) {
  const { messages, effort = "high" } = await req.json();

  const response = await client.messages.create({
    model: "claude-fable-5",
    max_tokens: 128_000,
    // DO NOT include temperature — it's deprecated
    thinking: { type: "adaptive" } as any,
    output_config: { effort } as any,
    messages,
  } as any);

  // Separate thinking and text blocks
  const thinking = response.content
    .filter((block: any) => block.type === "thinking")
    .map((block: any) => block.thinking)
    .join("\n");

  const text = response.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n");

  return NextResponse.json({
    thinking,
    text,
    usage: response.usage,
  });
}
```

### Streaming API Route

```typescript
// app/api/chat/stream/route.ts
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export async function POST(req: NextRequest) {
  const { messages, effort = "high" } = await req.json();

  const stream = await client.messages.create({
    model: "claude-fable-5",
    max_tokens: 128_000,
    thinking: { type: "adaptive" } as any,
    output_config: { effort } as any,
    messages,
    stream: true,
  } as any);

  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      for await (const event of stream as any) {
        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "thinking") {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "thinking_start" })}\n\n`)
              );
            } else if (event.content_block.type === "text") {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "text_start" })}\n\n`)
              );
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "thinking_delta") {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "thinking", text: event.delta.thinking })}\n\n`
                )
              );
            } else if (event.delta.type === "text_delta") {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "text", text: event.delta.text })}\n\n`
                )
              );
            }
            break;

          case "message_start":
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "usage", usage: event.message.usage })}\n\n`
              )
            );
            break;

          case "message_stop":
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
            break;
        }
      }
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

### Client-Side React Component

```tsx
// components/Chat.tsx
"use client";

import { useState } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [effort, setEffort] = useState<string>("high");

  const sendMessage = async () => {
    if (!input.trim()) return;

    const userMessage: Message = { role: "user", content: input };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setThinking("");
    setStreaming(true);

    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: newMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        effort,
      }),
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let assistantText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n\n").filter(Boolean);

      for (const line of lines) {
        if (line === "data: [DONE]") continue;
        if (!line.startsWith("data: ")) continue;

        const data = JSON.parse(line.slice(6));

        if (data.type === "thinking") {
          setThinking((prev) => prev + data.text);
        } else if (data.type === "text") {
          assistantText += data.text;
          setMessages([...newMessages, { role: "assistant", content: assistantText }]);
        }
      }
    }

    setStreaming(false);
  };

  return (
    <div className="max-w-2xl mx-auto p-4">
      <div className="mb-4">
        <label className="block text-sm font-medium mb-1">Effort Level</label>
        <select
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
          className="border rounded px-3 py-1"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="xhigh">Extra High</option>
          <option value="max">Max</option>
        </select>
      </div>

      <div className="space-y-4 mb-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`p-3 rounded ${
              msg.role === "user" ? "bg-blue-100" : "bg-gray-100"
            }`}
          >
            <strong>{msg.role === "user" ? "You" : "Fable"}:</strong>
            <p className="whitespace-pre-wrap">{msg.content}</p>
          </div>
        ))}
      </div>

      {thinking && (
        <details className="mb-4 bg-yellow-50 p-3 rounded">
          <summary className="cursor-pointer font-medium">
            💭 Thinking...
          </summary>
          <pre className="whitespace-pre-wrap text-sm mt-2">{thinking}</pre>
        </details>
      )}

      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
          placeholder="Type a message..."
          className="flex-1 border rounded px-3 py-2"
          disabled={streaming}
        />
        <button
          onClick={sendMessage}
          disabled={streaming}
          className="bg-blue-500 text-white px-4 py-2 rounded disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

---

## Raw HTTP (cURL) — For Any Language

If you're not using an official SDK, here's the raw HTTP request:

```bash
curl https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: prompt-caching-2024-07-31" \
  -d '{
    "model": "claude-fable-5",
    "max_tokens": 128000,
    "thinking": {
      "type": "adaptive"
    },
    "output_config": {
      "effort": "high"
    },
    "messages": [
      {"role": "user", "content": "Hello, Fable!"}
    ]
  }'
```

---

## Understanding `max_tokens` vs Context Window

The Anthropic API enforces: **input_tokens + max_tokens ≤ context_window (1M)**

| Parameter | Value | Meaning |
|-----------|-------|---------|
| `context_window` | 1,000,000 | Maximum total tokens (input + output combined) |
| `max_tokens` | Up to 128,000 | Maximum **output** tokens the model can generate |

So if you set `max_tokens: 128_000`, you can send up to **872,000 tokens** of input (messages + system prompt + tools). If you only need short responses, use a smaller `max_tokens` (e.g., 16,384) to leave more room for input context.

> **Tip**: For most use cases, `max_tokens: 16_384` or `max_tokens: 32_768` is sufficient. Only use `128_000` if you need very long outputs (e.g., generating entire files).

---

## Pricing

| Input | Output | Cache Writes | Cache Reads |
|-------|--------|-------------|-------------|
| $10/M tokens | $50/M tokens | $12.50/M tokens | $1.00/M tokens |

> Pricing is flat across all context sizes (unlike Sonnet/Opus which have tiered pricing for >200K context).

---

## Common Pitfalls

1. **Don't send `temperature`** — The API will return a 400 error: `"temperature" is deprecated for this model.`

2. **Don't use `thinking.type: "enabled"`** — On Opus 4.7/4.8 and Fable 5 the API will return: `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.` (Opus 4.6 still accepts both forms.)

3. **SDK version matters** — If using `@anthropic-ai/sdk` < 0.50.0 or `anthropic` (Python) < 0.50.0, you'll need to cast types or use raw HTTP requests since the SDK types won't include `adaptive` or `output_config`.

4. **Thinking is always adaptive** — Unlike previous models where you could disable thinking entirely, Fable 5 always uses adaptive thinking. Control the depth via `output_config.effort`. To turn thinking off entirely, **omit the `thinking` field** — do NOT send `{"type": "disabled"}`.

5. **1M context is native** — No beta flag needed for 1M context (unlike Sonnet 4.5/4.6 which require `anthropic-beta: context-1m-2025-08-07`). However, if you want to use prompt caching, you still need the `prompt-caching-2024-07-31` beta header.

6. **Forced tool use is incompatible with thinking** — When thinking is enabled (budget or adaptive), do NOT send `tool_choice: {"type": "any"}` or `{"type": "tool", ...}`. The API rejects forced tool use with thinking. Either omit `tool_choice` or use `{"type": "auto"}`.

7. **`max_tokens` must cover thinking + answer** — Adaptive models interleave thinking into the output budget. If you clamp `max_tokens` low (e.g. 8192), deep reasoning can exhaust the budget before any visible text is produced. Use a generous budget (16K–128K) for adaptive models.

8. **Short prompts ≠ broken streaming** — Adaptive thinking streams incrementally, but easy prompts finish thinking in one delta in <1s. Don't mistake this for buffered/non-streaming behavior (see "Streaming Behavior" above).

---

## How Roo Code Integrates These Models

This section documents the Roo Code implementation (updated June 2026) so future model additions follow the same pattern.

### Detection

[`isAdaptiveThinkingModel()`](../src/api/transform/reasoning.ts) matches `claude-fable-5` and `claude-opus-4-6/4-7/4-8` (both `4-6` and `4.6` spellings). This mirrors Cline's `isClaudeOpusAdaptiveThinkingModel()`.

### Default-On Reasoning

Adaptive thinking models reason **by default** in Roo Code. In [`AnthropicHandler.createMessage()`](../src/api/providers/anthropic.ts):

- If the user has NOT explicitly disabled reasoning, the request includes `thinking: { type: "adaptive" }` and `output_config: { effort: <selected effort, default "high"> }`, and `max_tokens` is restored to the model's full output budget (the generic `getModelMaxOutputTokens()` clamps to 8192 when the "Enable reasoning" checkbox is off — that clamp is overridden for adaptive models).
- If the user explicitly disables reasoning (`enableReasoningEffort === false` in provider settings), the `thinking` field is **omitted entirely** (never `{ type: "disabled" }`, which these models reject).

This was previously opt-in (reasoning only when the checkbox was checked), which made it look like "reasoning is disabled for Opus and Fable."

### Request Shape Rules

- **No `temperature`** for adaptive models — `supportsTemperature: false` in [`packages/types/src/providers/anthropic.ts`](../packages/types/src/providers/anthropic.ts) keeps it out of the request.
- **`tool_choice` guard** — when thinking is active, forced tool choices (`any` / `tool`) are converted to `undefined` (model decides), since Anthropic rejects forced tool use with thinking.
- **Model ID switches** — both switch statements in the handler (request branch + prompt-caching betas) must list every model ID explicitly. `claude-opus-4-7`, `claude-opus-4-8`, and `claude-sonnet-4-5-20250929` were once missing and silently fell into the no-caching/no-thinking default branch. When adding a model, update **both** switches.

### Stream Handling

- `thinking` / `thinking_delta` chunks → yielded as `{ type: "reasoning", text }` API stream chunks.
- `redacted_thinking` blocks → handled explicitly as a no-op (nothing displayable).
- `signature_delta` → currently not persisted (thinking blocks are stripped from outgoing history by `filterNonAnthropicBlocks`); a future improvement is round-tripping signed thinking blocks for cross-turn reasoning continuity.
- In [`Task.ts`](../src/core/task/Task.ts), empty reasoning chunks (the `""` from `content_block_start`) are skipped so the UI never shows an empty "Thinking" row.
- In [`ReasoningBlock.tsx`](../webview-ui/src/components/chat/ReasoningBlock.tsx), the elapsed timer is anchored to the message timestamp (survives component remounts), and empty reasoning blocks are hidden once streaming ends.

### Known Limitations / Follow-Ups

1. **No signature round-trip** — thinking blocks (and their signatures) are not sent back in multi-turn conversation history. Works fine, but the model loses access to its prior-turn reasoning.
2. **Effort hardcoded to "high" fallback** — the settings UI uses the budget-token slider for these models; `output_config.effort` falls back to `"high"` unless a `reasoningEffort` is set. Exposing the full effort range (`low`–`max`, incl. `xhigh`) in the UI is a planned follow-up.

---

## Environment Variables

```env
# .env.local (Next.js) or .env (Python)
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Make sure to add `.env.local` to your `.gitignore`.
