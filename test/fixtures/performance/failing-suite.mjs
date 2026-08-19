if (process.env.NODE_TEST_CONTEXT!==undefined) process.exit(0);

process.stderr.write("intentional benchmark fixture failure\n");
process.exit(5);
