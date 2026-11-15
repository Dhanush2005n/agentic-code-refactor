/**
 * Demo: Using autorefactor-ai programmatically
 * Run with: node examples/demo.mjs
 */
import path from "node:path";
import dotenv from "dotenv";

// Load .env (if present)
dotenv.config();

// In an external project, you would write:
// import { formatAnalysis, runPipeline } from "autorefactor-ai";
import { formatAnalysis, runPipeline } from "../dist/src/index.js";

async function main() {
  const targetDir = path.resolve("test-target/src");

  console.log("=========================================");
  console.log("1. STATIC REFACTOR ANALYSIS (Read-only)");
  console.log("=========================================\n");

  const report = formatAnalysis(targetDir);
  console.log(report);

  console.log("\n=========================================");
  console.log("2. PROGRAMMATIC REFACTOR PIPELINE");
  console.log("=========================================\n");

  // Only run if an API key is set
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    console.log("💡 To execute the live refactoring pipeline, add your Gemini API key to .env:");
    console.log("   GEMINI_API_KEY=your_key_here\n");
    return;
  }

  console.log("Starting refactor pipeline with Gemini 2.0 Flash...\n");
  const result = await runPipeline({
    targetDir: path.resolve("test-target"),
    filePaths: [
      path.resolve("test-target/src/mathUtils.js"),
      path.resolve("test-target/src/legacyCallback.js")
    ],
    skipGit: true, // Apply verified patches directly without git branch
    onProgress: (msg) => console.log(msg),
  });

  const verified = result.taskOutcomes.filter((t) => t.passed).length;
  console.log(`\nDone! Verified fixes: ${verified}/${result.taskOutcomes.length}`);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exitCode = 1;
});

