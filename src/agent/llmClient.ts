/**
 * LLM client configuration, provider-agnostic (Anthropic/OpenAI/Google).
 */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import type { AgentToolCall, RefactorObjective } from "../types/agent.types.js";
import type { ParsedNode } from "../types/ast.types.js";
import { AgentToolCallSchema } from "./toolSchemas.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompts.js";

export type LlmProvider = "anthropic" | "openai" | "google";
export type ModelTier = "cheap" | "capable";

const PROVIDER = (process.env.LLM_PROVIDER as LlmProvider | undefined) ?? "anthropic";

const ANTHROPIC_DEFAULTS: Record<ModelTier, string> = {
  cheap: "claude-haiku-4-5-20251001",
  capable: "claude-sonnet-5",
};

function resolveModelId(tier: ModelTier): string {
  const envVar = tier === "cheap" ? "LLM_MODEL_CHEAP" : "LLM_MODEL_CAPABLE";
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  if (PROVIDER === "anthropic") return ANTHROPIC_DEFAULTS[tier];
  throw new Error(
    `${envVar} is not set. There is no default model ID for provider "${PROVIDER}" — ` +
      `model naming changes too often to guess reliably. Check ${PROVIDER}'s current model ` +
      `list and set ${envVar} in your .env file.`,
  );
}

function getModel(tier: ModelTier): LanguageModel {
  const modelId = resolveModelId(tier);
  switch (PROVIDER) {
    case "openai":
      return openai(modelId);
    case "google":
      return google(modelId);
    case "anthropic":
    default:
      return anthropic(modelId);
  }
}

function requiredApiKeyEnvVar(): string {
  switch (PROVIDER) {
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_GENERATIVE_AI_API_KEY";
    case "anthropic":
    default:
      return "ANTHROPIC_API_KEY";
  }
}

/**
 * Checks the LLM configuration WITHOUT making a call, returning a
 * human-readable problem or undefined if everything needed is present. The
 * CLI runs this first so a missing key is reported before any git branch is
 * created or file touched, rather than failing on the first task.
 */
export function getLlmConfigProblem(): string | undefined {
  const validProviders: string[] = ["anthropic", "openai", "google"];
  if (!validProviders.includes(PROVIDER)) {
    return `LLM_PROVIDER must be one of ${validProviders.join(", ")} (got "${PROVIDER}").`;
  }
  const keyVar = requiredApiKeyEnvVar();
  if (!process.env[keyVar]) {
    return `${keyVar} is not set (LLM_PROVIDER="${PROVIDER}"). Add it to your .env file — see .env.example.`;
  }
  if (PROVIDER !== "anthropic") {
    for (const modelVar of ["LLM_MODEL_CHEAP", "LLM_MODEL_CAPABLE"]) {
      if (!process.env[modelVar]) {
        return `${modelVar} is not set. ${PROVIDER} has no built-in default model — set it in your .env file.`;
      }
    }
  }
  return undefined;
}

/**
 * How many times the SDK retries a failed API call (with exponential
 * backoff) before giving up. The SDK's own default is 2, which is too few
 * for a free tier: this pipeline calls the model every few seconds, which
 * is faster than free-tier per-minute quotas allow, so rate-limit (429)
 * errors are expected and must be waited out, not treated as task failures.
 * A blank or invalid LLM_API_RETRIES falls back to the default of 5.
 */
function apiRetries(): number {
  const raw = process.env.LLM_API_RETRIES;
  if (!raw) return 5;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 5;
}

/** Human-readable "provider/model" for a tier, for progress output. Never throws. */
export function describeModel(tier: ModelTier): string {
  try {
    return `${PROVIDER}/${resolveModelId(tier)}`;
  } catch {
    return PROVIDER;
  }
}

/**
 * Overall budget for one logical call, across every request, retry and wait.
 * Blank or invalid LLM_TIMEOUT_MS falls back to 240 seconds.
 */
function timeoutMs(): number {
  const raw = process.env.LLM_TIMEOUT_MS;
  if (!raw) return 240_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 240_000;
}

/**
 * Limit for ONE request. A request that goes silent is aborted and retried
 * instead of silently eating the whole overall budget — which is exactly what
 * happened against an overloaded model: three fast 503s, then one request that
 * never answered for the remaining ~160s. Defaults to 90s (a slow-but-healthy
 * reasoning model took ~52s in practice). LLM_REQUEST_TIMEOUT_MS overrides it.
 */
function requestTimeoutMs(): number {
  const raw = process.env.LLM_REQUEST_TIMEOUT_MS;
  if (!raw) return 90_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 90_000;
}

/** Falling back from the capable to the cheap model is on unless LLM_FALLBACK=off. */
function fallbackEnabled(): boolean {
  return (process.env.LLM_FALLBACK ?? "").trim().toLowerCase() !== "off";
}

/** Base delay for our own retry backoff (doubles each retry, capped at 60s). */
function retryBaseMs(): number {
  const n = Number(process.env.LLM_RETRY_BASE_MS);
  return process.env.LLM_RETRY_BASE_MS && Number.isFinite(n) && n >= 0 ? n : 2000;
}

export interface RetryInfo {
  attempt: number; // which retry this is (1-based)
  maxRetries: number;
  waitMs: number;
  reason: string;
}

/** Tokens the API actually billed for one successful call (not an estimate). */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * The provider could not be reached or kept failing transiently (overload,
 * server errors, network trouble, stalls) even after retries. Distinct from
 * errors that will never succeed — a bad key, an unknown model, an exhausted
 * daily quota — so callers can skip a task and carry on instead of aborting.
 */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    public readonly tier: ModelTier,
  ) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export interface FallbackInfo {
  from: ModelTier;
  to: ModelTier;
  reason: string;
}

export interface CallHooks {
  /** Called when the capable model stays unavailable and the cheap one is used instead. */
  onFallback?: (info: FallbackInfo) => void;
  /** Called after each successful call with the provider-reported token counts. */
  onUsage?: (usage: TokenUsage) => void;
  /** Called just before waiting to retry, so the caller can tell the user WHY it is waiting. */
  onRetry?: (info: RetryInfo) => void;
}

interface ApiFailure {
  retryable: boolean;
  reason: string;
  waitMs?: number;
  /** Set when retrying cannot help; the message to fail with immediately. */
  fatalMessage?: string;
}

/**
 * Decides what to do about a failed API call. Duck-typed rather than using
 * the SDK's APICallError class so it works regardless of SDK version (and
 * under test mocks). Why we do our own retries instead of the SDK's: the
 * SDK waits silently, so a rate-limited run looked frozen with no clue why.
 * Doing it here lets us print the reason and, more importantly, stop at
 * once on errors that waiting can never fix.
 */
function classifyApiError(err: unknown): ApiFailure {
  const e = err as { statusCode?: number; isRetryable?: boolean; responseBody?: string; responseHeaders?: Record<string, string>; message?: string };
  const status = e.statusCode;
  const body = e.responseBody ?? "";
  const detail = (e.message ?? "unknown error").slice(0, 200);
  // Network-level failures carry no HTTP status; undici reports them as "fetch failed" with a coded cause.
  const causeCode = (err as { cause?: { code?: string } }).cause?.code ?? "";
  const networkTrouble =
    /fetch failed/i.test(e.message ?? "") ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(causeCode);
  const retryable =
    e.isRetryable === true || networkTrouble || (status !== undefined && [408, 409, 429, 500, 502, 503, 504].includes(status));
  if (!retryable) return { retryable: false, reason: detail };

  if (status === 429 && /limit:\s*0\b/.test(body)) {
    return {
      retryable: false,
      reason: detail,
      fatalMessage: `has no free-tier quota (the API reports a quota limit of 0). Choose a different model in LLM_MODEL_CHEAP / LLM_MODEL_CAPABLE. API said: ${detail}`,
    };
  }
  if (status === 429 && /PerDay/i.test(body)) {
    return {
      retryable: false,
      reason: detail,
      fatalMessage: `daily quota is used up, so waiting won't help. Wait for it to reset, or switch model/provider. API said: ${detail}`,
    };
  }

  // Prefer the server's own instruction about how long to wait.
  let waitMs: number | undefined;
  const retryAfter = Number(e.responseHeaders?.["retry-after"]);
  if (e.responseHeaders?.["retry-after"] !== undefined && Number.isFinite(retryAfter)) waitMs = retryAfter * 1000;
  const delayMatch = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (waitMs === undefined && delayMatch) waitMs = Number(delayMatch[1]) * 1000;
  if (waitMs !== undefined) waitMs = Math.min(waitMs, 120_000);

  const label = status === 429 ? "rate limited (429)" : status === undefined ? "network error" : `server error (${status})`;
  return { retryable: true, reason: `${label}: ${detail}`, waitMs };
}

/** A sleep that ends early, by rejecting, if the call's overall time limit passes. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const MULTI_ISSUE_THRESHOLD = 2;

export function pickModelTier(node: Pick<ParsedNode, "complexity" | "smells">): ModelTier {
  const needsDeepReasoning = node.smells.some((s) => s.type === "high-complexity" || s.type === "callback-hell");
  const isMultiIssue = node.smells.length >= MULTI_ISSUE_THRESHOLD;
  return needsDeepReasoning || isMultiIssue ? "capable" : "cheap";
}

export interface ConversationTurn {
  role: "assistant" | "user";
  content: string;
}

export async function generateRefactorPatch(
  objective: RefactorObjective,
  tier: ModelTier,
  priorTurns: ConversationTurn[] = [],
  hooks: CallHooks = {},
): Promise<AgentToolCall> {
  const apiKeyVar = requiredApiKeyEnvVar();
  if (!process.env[apiKeyVar]) {
    throw new Error(`${apiKeyVar} is not set — required for LLM_PROVIDER="${PROVIDER}". See .env.example.`);
  }

  const systemMessage =
    PROVIDER === "anthropic"
      ? { role: "system" as const, content: SYSTEM_PROMPT, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } } }
      : { role: "system" as const, content: SYSTEM_PROMPT };

  const userMessage =
    PROVIDER === "anthropic"
      ? { role: "user" as const, content: buildUserMessage(objective), providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } } }
      : { role: "user" as const, content: buildUserMessage(objective) };

  const messages = [systemMessage, userMessage, ...priorTurns];
  try {
    return await callWithRetries(tier, messages, hooks);
  } catch (err) {
    const canFallBack = err instanceof LlmUnavailableError && tier === "capable" && fallbackEnabled() && hasDistinctCheapModel();
    if (!canFallBack) throw err;
    hooks.onFallback?.({ from: "capable", to: "cheap", reason: err.message });
    return callWithRetries("cheap", messages, hooks);
  }
}

function hasDistinctCheapModel(): boolean {
  try {
    return resolveModelId("cheap") !== resolveModelId("capable");
  } catch {
    return false;
  }
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;

/**
 * One logical call with our own retry loop (so retries can be reported).
 * Every request has its own time limit; the whole thing has an overall budget.
 */
async function callWithRetries(
  tier: ModelTier,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string; providerOptions?: unknown }>,
  hooks: CallHooks,
): Promise<AgentToolCall> {
  const overallMs = timeoutMs();
  const requestMs = Math.min(requestTimeoutMs(), overallMs);
  const overall = AbortSignal.timeout(overallMs);
  const maxRetries = apiRetries();
  let lastProblem = "none yet";

  const ranOutOfTime = () =>
    new LlmUnavailableError(
      `${describeModel(tier)} did not finish within ${seconds(overallMs)} (last problem: ${lastProblem}). ` +
        `If the provider is just slow, raise LLM_TIMEOUT_MS in your .env file.`,
      tier,
    );

  for (let retry = 0; ; retry++) {
    if (overall.aborted) throw ranOutOfTime();

    // This request stops if it stalls OR if the overall budget runs out.
    const controller = new AbortController();
    const onOverallAbort = () => controller.abort();
    overall.addEventListener("abort", onOverallAbort, { once: true });
    let stalled = false;
    const stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, requestMs);

    try {
      const { object, usage } = await generateObject({
        model: getModel(tier),
        schema: AgentToolCallSchema,
        maxRetries: 0, // retries are handled here, where they can be reported
        abortSignal: controller.signal,
        messages: messages as never,
      });
      // Providers that don't report usage give NaN or nothing — skip rather than count garbage.
      if (usage && Number.isFinite(usage.promptTokens) && Number.isFinite(usage.completionTokens)) {
        hooks.onUsage?.({ promptTokens: usage.promptTokens, completionTokens: usage.completionTokens });
      }
      return object;
    } catch (err) {
      if (overall.aborted) throw ranOutOfTime();

      const failure: { retryable: boolean; reason: string; waitMs?: number; fatalMessage?: string } = stalled
        ? { retryable: true, reason: `no response after ${seconds(requestMs)}` }
        : classifyApiError(err);

      if (failure.fatalMessage) throw new Error(`${describeModel(tier)} ${failure.fatalMessage}`);
      if (!failure.retryable) throw err;

      lastProblem = failure.reason;
      if (retry >= maxRetries) {
        throw new LlmUnavailableError(`${describeModel(tier)} is unavailable after ${maxRetries} retries (last problem: ${failure.reason})`, tier);
      }

      const waitMs = failure.waitMs ?? Math.min(2 ** retry * retryBaseMs(), 60_000);
      hooks.onRetry?.({ attempt: retry + 1, maxRetries, waitMs, reason: failure.reason });
      try {
        await sleep(waitMs, overall);
      } catch {
        throw ranOutOfTime();
      }
    } finally {
      clearTimeout(stallTimer);
      overall.removeEventListener("abort", onOverallAbort);
    }
  }
}