import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { readPackageVersion } from "../src/cli/version.js";
import { buildProgram } from "../src/cli/commands.js";

describe("readPackageVersion", () => {
  it("returns the version in this package's own package.json", () => {
    const expected = JSON.parse(fs.readFileSync("package.json", "utf-8")).version;
    expect(readPackageVersion()).toBe(expected);
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is what the CLI reports as its version", () => {
    expect(buildProgram().version()).toBe(readPackageVersion());
  });
});