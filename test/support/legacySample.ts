/**
 * The pristine "legacy" sample project, as text. Single source of truth for:
 *  - the unit-test fixtures (regenerated before every test run), and
 *  - `npm run demo:reset`, which restores test-target/src after the CLI has
 *    patched it.
 * Generating them from here means no earlier step, stale copy, or git state
 * can leave the fixtures in a "fixed" condition the tests don't expect.
 */
import fs from "node:fs";
import path from "node:path";

export const LEGACY_SAMPLE: Record<string, string> = {
  "legacyCallback.js": `// Legacy untyped file with nested callback hell — a target for refactoring.

function fetchUserData(userId, callback) {
  getUserFromDb(userId, function (err, user) {
    if (err) {
      callback(err);
    } else {
      getOrdersForUser(user.id, function (err2, orders) {
        if (err2) {
          callback(err2);
        } else {
          getPaymentsForOrders(orders, function (err3, payments) {
            if (err3) {
              callback(err3);
            } else {
              callback(null, { user, orders, payments });
            }
          });
        }
      });
    }
  });
}

function getUserFromDb(userId, cb) {
  setTimeout(() => cb(null, { id: userId, name: "Sample User" }), 10);
}

function getOrdersForUser(userId, cb) {
  setTimeout(() => cb(null, [{ id: 1, userId }]), 10);
}

function getPaymentsForOrders(orders, cb) {
  setTimeout(() => cb(null, orders.map((o) => ({ orderId: o.id, amount: 42 }))), 10);
}

module.exports = { fetchUserData };
`,
  "mathUtils.js": `// Untyped helper file, imported by userController.js — a good candidate
// for bottom-up refactoring (utilities before consumers).

function add(a, b) {
  return a + b;
}

function average(numbers) {
  var total = 0;
  for (var i = 0; i < numbers.length; i++) {
    total += numbers[i];
  }
  return total / numbers.length;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

module.exports = { add, average, clamp };
`,
  "userController.js": `// Consumes mathUtils.js — used to verify multi-file refactor sync:
// mathUtils must be refactored before userController per the DAG.

var mathUtils = require("./mathUtils");

function getUserScoreSummary(scores) {
  var avg = mathUtils.average(scores);
  var clamped = mathUtils.clamp(avg, 0, 100);
  return {
    average: avg,
    clamped: clamped,
    total: scores.reduce(function (sum, s) {
      return mathUtils.add(sum, s);
    }, 0),
  };
}

module.exports = { getUserScoreSummary };
`,
  "__tests__/userController.test.js": `const { getUserScoreSummary } = require("../userController");

test("computes average, clamped value, and total for a set of scores", () => {
  const result = getUserScoreSummary([80, 90, 70]);
  expect(result.average).toBeCloseTo(80);
  expect(result.clamped).toBeCloseTo(80);
  expect(result.total).toBe(240);
});

test("clamps average above 100 down to 100", () => {
  const result = getUserScoreSummary([150, 200]);
  expect(result.clamped).toBe(100);
});
`,
};

/** Writes every sample file under `dir`, overwriting whatever is there. */
export function writeLegacySample(dir: string): void {
  for (const [relativePath, content] of Object.entries(LEGACY_SAMPLE)) {
    const target = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}