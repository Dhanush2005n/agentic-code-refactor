/**
 * Reads this package's own version at runtime. Walks up from the running
 * file until it finds this package's package.json, so it works both from
 * source (src/cli/) and from the compiled build (dist/src/cli/), which sit at
 * different depths.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function readPackageVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        if (pkg.name === "autorefactor-ai") return pkg.version as string;
      } catch {
        /* unreadable package.json: keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}