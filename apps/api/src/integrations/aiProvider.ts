// AI provider — PRD §10.2 AIService, Provider layer (PRD §6: UI → Service
// → Provider → External API), same tier as webPushProvider.ts.
//
// Superseded the earlier per-vendor design (a `GeminiAIProvider` class
// selected by an `AI_PROVIDER` env var): Settings > Integrations (0011
// migration + routes/aiSettings.ts) now lets each org point at any
// OpenAI-compatible endpoint — NVIDIA NIM, or literally anything else
// that implements POST {baseUrl}/chat/completions — configured at
// runtime from the DB, not baked into a deploy. That's what
// `OpenAICompatibleProvider` below is: one class, config passed in per
// call (base URL, API key, model) rather than read from env at module
// load, because config is now per-org data, not a process-wide setting.
// Nothing above this layer (aiService.ts) needs to know or care which
// vendor is actually behind the base URL.

export interface AICompletionResult {
  text: string;
  /** Undefined when the provider doesn't report usage — StubAIProvider
   * never does (there's no real model behind it to report on), and a
   * real provider's response is trusted as-is, never estimated locally
   * (guessing a token count would be worse than admitting it's unknown —
   * same "don't fabricate" posture as PRD §13.4's error-handling rules). */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Always populated, by every implementation, including the stub —
   * wall-clock time is measurable regardless of whether the provider
   * itself reports it. */
  latencyMs: number;
}

export interface AIProvider {
  /** Raw text completion. Callers own their own prompt format and response
   * parsing (e.g. asking for JSON-only output and parsing it themselves) —
   * this layer doesn't know or care what shape the caller expects back.
   * ADMIN_BUILD_GUIDE.md §3 (Session 39): returns tokens/latency
   * alongside the text, not just text — the interface change the guide
   * requires be made and verified against every caller *before* any
   * ai_usage table exists (0018_ai_usage.sql), not concurrently with it. */
  complete(systemPrompt: string, userPrompt: string): Promise<AICompletionResult>;
}

export class AIProviderNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`AI provider is not configured (${reason}). Set it up under Settings > Integrations.`);
    this.name = 'AIProviderNotConfiguredError';
  }
}

// No network call, no API key required. Used whenever an org hasn't
// configured Settings > Integrations yet, so a feature built on
// AIService degrades gracefully instead of hard-failing.
//
// Branches on the caller's own prompt shape rather than exposing a
// second method, since AIProvider is deliberately a one-method interface
// (raw text in, raw text out) that real callers (OpenAICompatibleProvider)
// don't get to specialize either — a caller-aware stub has to infer
// intent from the prompt the same way a real model would.
// aiService.ts's buildUserPrompt() always starts goal-decomposition
// prompts with "GOAL:", so that prefix is the caller's own contract,
// not a fragile heuristic invented here.
export class StubAIProvider implements AIProvider {
  async complete(_systemPrompt: string, userPrompt: string): Promise<AICompletionResult> {
    const start = Date.now();
    let text: string;
    if (userPrompt.startsWith('GOAL:')) {
      // Every current decomposeGoal() caller asks for JSON-array output,
      // so the stub returns a small deterministic array shaped to
      // satisfy that contract, built from whatever text it was given,
      // rather than an arbitrary echo object a real caller's parser
      // would just reject. Keeps the propose→review→approve path
      // exercisable end-to-end (routes, validation, DB insert, UI)
      // without a real model.
      const subject = userPrompt.split('\n')[0]?.replace(/^GOAL:\s*/, '').trim() || 'this goal';
      text = JSON.stringify([
        { title: `Define scope and success criteria for: ${subject}`.slice(0, 100) },
        { title: `Identify who owns each step of: ${subject}`.slice(0, 100), dependsOnIndex: 0 },
        { title: `Execute the core work for: ${subject}`.slice(0, 100), dependsOnIndex: 1 },
        {
          title: `Review and close out: ${subject}`.slice(0, 100),
          reasoning: 'stub-ai-provider — no AI connection is configured for this org yet; set one up under Settings > Integrations for a real decomposition.',
          dependsOnIndex: 2,
        },
      ]);
    } else {
      // Anything else (chatService.ts's chat prompts, currently the only
      // other caller) wants plain prose back, not JSON — a chat transcript
      // ending in that JSON-array text would read as broken, not helpful.
      text = "This is a placeholder reply — no AI connection is configured for this org yet. Set one up under Settings > Integrations to get real responses from NEXUS AI.";
    }
    // No promptTokens/completionTokens/totalTokens — there's no real
    // model call to report usage on (see AICompletionResult's own doc
    // comment). latencyMs is still real: whatever this function actually
    // took, even though that's sub-millisecond in practice — logging it
    // as ~0 is honest, not a placeholder value.
    return { text, latencyMs: Date.now() - start };
  }
}

export interface OpenAICompatibleConfig {
  /** e.g. https://integrate.api.nvidia.com/v1 — no trailing slash required,
   * this class normalizes it. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Talks to any endpoint implementing the OpenAI chat-completions shape —
 * NVIDIA NIM's OpenAI-compatible API, a self-hosted vLLM/Ollama instance,
 * or actual OpenAI. Vendor-agnostic on purpose: the "AI Settings" page
 * only ever asks for a base URL + key + model name, never a vendor
 * picker, so this class is the only implementation that should ever be
 * needed here. */
export class OpenAICompatibleProvider implements AIProvider {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  async complete(systemPrompt: string, userPrompt: string): Promise<AICompletionResult> {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const start = Date.now();
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        // Callers (aiService.ts) ask for JSON-only prose output and parse
        // it themselves — low temperature keeps decomposition-style tasks
        // consistent rather than creative.
        temperature: 0.2,
      }),
      // PRD §13.4: every external call has an enforced timeout.
      signal: AbortSignal.timeout(30_000),
    });
    const latencyMs = Date.now() - start;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`AI provider error ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      // OpenAI-compatible shape — NVIDIA NIM's own endpoint returns this
      // same `usage` object, which is why this is trusted as-is (see
      // AICompletionResult's doc comment) rather than estimated: it's
      // the provider's own accounting, not a guess this layer is making.
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) {
      throw new Error('AI provider returned an empty response.');
    }
    return {
      text,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
      latencyMs,
    };
  }
}
