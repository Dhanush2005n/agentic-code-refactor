#!/usr/bin/env node
/**
 * CLI entrypoint. Usage:
 *   autorefactor analyze <target>
 *   autorefactor run <target> [--no-git] [--run-tests] [--max-retries n] [--min-score n]
 *   autorefactor check-llm [cheap|capable]
 *
 * Settings come from environment variables, which may be set in the shell or
 * in a .env file. Two places are read, the first taking priority:
 *   1. ./.env                       (the directory you run the command from)
 *   2. ~/.autorefactor/.env         (one global place for your API key)
 *
 * dotenv is loaded BEFORE the commands module is imported, on purpose:
 * agent/llmClient.ts reads LLM_PROVIDER when it first loads, so the settings
 * have to be in process.env by then.
 */
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config(); // ./.env — never overrides variables that are already set
dotenv.config({ path: path.join(os.homedir(), ".autorefactor", ".env") }); // fills in anything still missing

const { buildProgram } = await import("../src/cli/commands.js");
await buildProgram().parseAsync(process.argv);