import path from "node:path";
import { writeLegacySample } from "./support/legacySample.js";

/** Runs once before the whole test run: rebuilds the fixtures from known-good text. */
export default function setup(): void {
  writeLegacySample(path.resolve("test/fixtures/legacy"));
}