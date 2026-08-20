import test from "node:test";

process.stdout.write("PASSING_STDOUT_MARKER\n");
process.stderr.write("PASSING_STDERR_MARKER\n");

test("passing runner fixture",() => {});
