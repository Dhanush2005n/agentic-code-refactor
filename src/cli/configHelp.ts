/**
 * Extra context for a "your LLM settings are missing" error, so it explains
 * itself instead of leaving the user to guess: WHERE settings were looked for
 * (and whether each file exists), and — when the pattern is recognisable — why
 * the tool ended up on the wrong provider. Pure and injectable so it can be
 * tested without touching the real environment.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function describeConfigHelp(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): string {
  const sources = [path.join(cwd, ".env"), path.join(home, ".autorefactor", ".env")];
  const lines = ["Settings were looked for in:", ...sources.map((p) => `  - ${p}  (${fs.existsSync(p) ? "found" : "not found"})`)];

  const provider = env.LLM_PROVIDER || "anthropic";
  const providerIsDefault = !env.LLM_PROVIDER;

  if (provider === "anthropic" && !env.ANTHROPIC_API_KEY) {
    if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
      lines.push('Hint: a Google key is set, but LLM_PROVIDER is not "google", so Anthropic is being used. Add LLM_PROVIDER=google.');
    } else if (env.OPENAI_API_KEY) {
      lines.push('Hint: an OpenAI key is set, but LLM_PROVIDER is not "openai", so Anthropic is being used. Add LLM_PROVIDER=openai.');
    } else if (providerIsDefault) {
      lines.push(
        "Hint: LLM_PROVIDER is not set, so the default (anthropic) is used. To use Gemini, put these in one of the files above:",
        "  LLM_PROVIDER=google",
        "  GOOGLE_GENERATIVE_AI_API_KEY=<your key>",
        "  LLM_MODEL_CHEAP=<model id>   LLM_MODEL_CAPABLE=<model id>",
      );
    }
  }
  return lines.join("\n");
}