import assert from "node:assert/strict";
import test from "node:test";

if (process.env.TOSS_TEST_RUNNER_FIXTURE_MODE==="intentional-failure") {
  process.stdout.write("FAILING_STDOUT_MARKER\n");
  process.stderr.write("FAILING_STDERR_MARKER\n");

  test("failing runner fixture",() => {
    assert.fail("intentional runner fixture failure");
  });
} else {
  test("failing runner fixture remains inert until explicitly armed",() => {});
}
