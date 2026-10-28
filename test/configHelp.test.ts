import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeConfigHelp } from "../src/cli/configHelp.js";

let cwd: string;
let home: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-cwd-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-home-"));
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const help = (env: NodeJS.ProcessEnv) => describeConfigHelp(env, cwd, home);

describe("describeConfigHelp — where settings were looked for", () => {
  it("lists both settings files and marks each as not found when neither exists", () => {
    const text = help({});
    expect(text).toContain(`${path.join(cwd, ".env")}  (not found)`);
    expect(text).toContain(`${path.join(home, ".autorefactor", ".env")}  (not found)`);
  });

  it("marks a file as found when it exists", () => {
    fs.writeFileSync(path.join(cwd, ".env"), "LLM_PROVIDER=google\n");
    fs.mkdirSync(path.join(home, ".autorefactor"));
    fs.writeFileSync(path.join(home, ".autorefactor", ".env"), "X=1\n");
    const text = help({});
    expect(text).toContain(`${path.join(cwd, ".env")}  (found)`);
    expect(text).toContain(`${path.join(home, ".autorefactor", ".env")}  (found)`);
  });
});

describe("describeConfigHelp — explaining why the wrong provider is in use", () => {
  it("explains the default and shows the Gemini setup when nothing is configured", () => {
    const text = help({});
    expect(text).toContain("LLM_PROVIDER is not set");
    expect(text).toContain("LLM_PROVIDER=google");
    expect(text).toContain("GOOGLE_GENERATIVE_AI_API_KEY=<your key>");
  });

  it("points out a Google key that is set without LLM_PROVIDER=google", () => {
    const text = help({ GOOGLE_GENERATIVE_AI_API_KEY: "k" });
    expect(text).toContain("a Google key is set");
    expect(text).toContain("Add LLM_PROVIDER=google");
  });

  it("points out an OpenAI key that is set without LLM_PROVIDER=openai", () => {
    expect(help({ OPENAI_API_KEY: "k" })).toContain("Add LLM_PROVIDER=openai");
  });

  it("adds no provider hint when the user deliberately chose another provider", () => {
    expect(help({ LLM_PROVIDER: "google" })).not.toContain("Hint:");
  });

  it("adds no provider hint when Anthropic is chosen and its key is present", () => {
    expect(help({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" })).not.toContain("Hint:");
  });
});