# CPU workload build record

`cpu.wat` is the readable source for the WASM numeric kernel. `cpu.wasm` is the committed binary
built from it. **Both are in the repo on purpose:** shipping only the binary puts an unreadable
blob in a project whose credibility rests on being auditable, and shipping only the source moves an
assembler into the measurement window.

## Build

| | |
|---|---|
| Tool | **WABT 1.0.39** (the `wabt` npm package, used as a one-off build tool) |
| Built | 2026-08-24 |
| Size | **99 bytes** |
| WAT SHA-256 | `6c2bda22cab0a01ceb6953550a4acef0fddbe1ce9c137aaac763fe8f083e13fb` |
| SHA-256 | `318dc99c40e693887c8aa66443a8e041338b3da7b5f602d08f3d94ccf0083fea` |

```text
wat2wasm src/workloads/cpu.wat -o src/workloads/cpu.wasm
```

WABT is **not** a dependency of this project and must not become one. It was installed in a scratch
directory, run once, and discarded. The repo stays dependency-free.

## After changing or rebuilding, you MUST update three constants

All three live in `cpu-wasm.js`:

1. **`CPU_WAT_SHA256`** — the hash of the readable source. The artifact test pins the auditable
   source so an edit cannot leave it silently disagreeing with the shipped binary.
2. **`CPU_WASM_SHA256`** — the hash of the new binary. It is verified **before instantiation**, so a
   stale or swapped binary **refuses to instantiate** instead of quietly measuring the wrong kernel.
   The mismatch stays structured data through the worker boundary and reaches validity.js as
   `wasm-hash-mismatch`. 🔴 **A `.wasm` that loads, runs and measures the PREVIOUS kernel is
   invisible without this**, and a stale build artefact is an easy mistake to ship.
3. **`CPU_WASM_EXPECTED_CHECKSUM`** — the value `run(CPU_WASM_ITERATIONS, CPU_WASM_SEED)` returns.

Changing the kernel also means bumping `protocolVersion`, because the protocol is versioned. A different kernel is a
different measurement, and scores across it are not comparable.

## Verified 2026-08-24

- The compiled binary instantiates and computes.
- **The binary agrees with the independently derived constant**: `run(1_250_000, 0x6d2b79f5)`
  returns `2602556586`, matching `CPU_WASM_EXPECTED_CHECKSUM` exactly. That constant had been
  derived from a JS model of the kernel *before any binary existed*, so this is the check that
  proves the model and the real WebAssembly agree.
- Count dependence holds on the real binary: `run(1000, 1)` and `run(100, 1)` differ.
