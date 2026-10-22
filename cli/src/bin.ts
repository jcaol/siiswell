// SPDX-License-Identifier: Apache-2.0
/**
 * @file Executable entry of the siiswell CLI (the single-file build starts here).
 * @module cli/bin
 */
import { run } from "./main";

run(process.argv.slice(2), { env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 1;
  },
);
