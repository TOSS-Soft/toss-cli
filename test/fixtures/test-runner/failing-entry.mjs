import assert from "node:assert/strict";
import test from "node:test";

process.stdout.write("FAILING_STDOUT_MARKER\n");
process.stderr.write("FAILING_STDERR_MARKER\n");

test("failing runner fixture",() => {
  assert.fail("intentional runner fixture failure");
});
