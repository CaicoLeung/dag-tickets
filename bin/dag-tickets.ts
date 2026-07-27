#!/usr/bin/env bun
import { main } from "../src/cli.ts";

// Surface any unhandled rejection / uncaught exception with a full stack so a
// silent mid-batch exit (which Bun reports only as exit code 1) becomes
// diagnosable. Without this, an escaping promise rejection aborts the whole
// batch and leaves in-flight tickets unrecorded.
process.on("unhandledRejection", (err) => {
  process.stderr.write(`dag-tickets: unhandled rejection\n${(err as Error | null)?.stack ?? String(err)}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`dag-tickets: uncaught exception\n${(err as Error | null)?.stack ?? String(err)}\n`);
});

const code = await main(process.argv.slice(2));
process.exit(code);
