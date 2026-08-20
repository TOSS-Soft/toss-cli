import test from "node:test";

process.stdout.write("PASSING_STDOUT_MARKER\n");
process.stderr.write("PASSING_STDERR_MARKER\n");
process.stdout.write(`PASSING_EXEC_ARGV:${JSON.stringify(process.execArgv)}\n`);
process.stdout.write(`PASSING_ARGV:${JSON.stringify(process.argv.slice(1))}\n`);

test("passing runner fixture",() => {});
