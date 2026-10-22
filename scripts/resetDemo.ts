/**
 * Restores test-target/src to its original, un-refactored state after the CLI
 * has patched it. Writes from known-good text rather than `git checkout`, so
 * it works even if patched files were committed.
 *
 * Usage: npm run demo:reset
 */
import path from "node:path";
import { writeLegacySample } from "../test/support/legacySample.js";

writeLegacySample(path.resolve("test-target/src"));
console.log("test-target/src restored to the original sample.");