import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CPU_WASM_EXPECTED_CHECKSUM,
  CPU_WASM_ITERATIONS,
  CPU_WASM_SEED,
  CPU_WASM_SHA256,
  CPU_WAT_SHA256,
  createCpuWasmWorkUnit,
} from "../src/workloads/cpu-wasm.js";

// 🔴 These two tests exist because of the failure mode the hash check exists for: a .wasm that
// loads, runs, and measures the PREVIOUS kernel is completely invisible. Nothing errors, the
// numbers look plausible, and the benchmark quietly reports the wrong device speed.
//
// The unit tests elsewhere check the loader's LOGIC against fabricated bytes. Only these two open
// the committed artifact.

const wasmPath = fileURLToPath(new URL("../src/workloads/cpu.wasm", import.meta.url));
const wasmBytes = readFileSync(wasmPath);
const watPath = fileURLToPath(new URL("../src/workloads/cpu.wat", import.meta.url));
const watBytes = readFileSync(watPath);

test("the committed cpu.wat matches its pinned audit-source SHA-256", () => {
  const actual = createHash("sha256").update(watBytes).digest("hex");

  assert.equal(
    actual,
    CPU_WAT_SHA256.toLowerCase(),
    "cpu.wat changed without updating CPU_WAT_SHA256. Rebuild cpu.wasm, update both artifact "
      + "hashes and review whether the kernel change requires a protocol bump.",
  );
});

test("the committed cpu.wasm matches the SHA-256 the loader will demand", () => {
  const actual = createHash("sha256").update(wasmBytes).digest("hex");

  assert.equal(
    actual,
    CPU_WASM_SHA256.toLowerCase(),
    "cpu.wasm was rebuilt without updating CPU_WASM_SHA256. "
      + "See src/workloads/README.md: both constants must move together.",
  );
});

test("the real WebAssembly agrees with the independently derived checksum", async () => {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const run = instance.exports.run;

  assert.equal(typeof run, "function");
  assert.equal(
    run(CPU_WASM_ITERATIONS, CPU_WASM_SEED) >>> 0,
    CPU_WASM_EXPECTED_CHECKSUM,
    "The compiled kernel and CPU_WASM_EXPECTED_CHECKSUM disagree. That constant was derived from "
      + "a JS model of the kernel, so this is the assertion that proves the model and the real "
      + "WebAssembly compute the same thing.",
  );

  // Count dependence, asserted on the real binary rather than the model: a shortened loop must
  // change the value, or a hoisted loop would checksum correctly while doing none of the work.
  assert.notEqual(run(1000, 1) >>> 0, run(100, 1) >>> 0);
  assert.throws(
    createCpuWasmWorkUnit((_count, seed) => run(CPU_WASM_ITERATIONS / 10, seed)),
    /CPU WASM checksum mismatch/,
    "A binary that runs one tenth of the pinned loop count must fail the work-unit assertion",
  );
});
