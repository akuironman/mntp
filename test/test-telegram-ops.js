import assert from "node:assert/strict";
import { pendingConfirmation, isConfirmationValid, buildStats, formatHistory } from "../telegram-ops.js";

const confirmation = pendingConfirmation("closeall", "all", 1000);
assert.equal(isConfirmationValid(confirmation, "closeall", "all"), true);
assert.equal(isConfirmationValid(confirmation, "closeall", "other"), false);
assert.match(formatHistory([]), /No performance history/);
const stats = buildStats(1);
assert.equal(typeof stats.count, "number");
console.log("Telegram ops helper tests passed");
