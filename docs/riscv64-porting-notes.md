# OpenClaw RISC-V (riscv64) Porting Notes

## Overview

This document describes the adaptations required to run OpenClaw on RISC-V 64-bit Linux (riscv64). Three categories of changes are applied on top of each upstream stable release:

1. **Native dependency patches** -- pre-built riscv64 bindings for rolldown, lightningcss, matrix-sdk-crypto-nodejs, and lancedb
2. **V8 Wasm trap-handler workaround** -- avoids virtual address space exhaustion on Sv39
3. **Update path interception** -- prevents upstream (non-riscv64) builds from overwriting the installation

Base upstream version: **2026.4.9**
RISC-V version: **2026.4.9-riscv64.1**

---

## 1. Native Dependency Patches

### 1.1 Problem

Several npm packages ship platform-specific native binaries (`.node`) but lack riscv64 pre-built artifacts:

- **rolldown** (bundler) -- missing `rolldown-binding.linux-riscv64-gnu.node`
- **lightningcss** (CSS processor) -- missing `lightningcss.linux-riscv64-gnu.node`
- **@matrix-org/matrix-sdk-crypto-nodejs** (Matrix encryption SDK) -- no riscv64 native binding
- **@lancedb/lancedb** (vector database) -- no riscv64 native binding

### 1.2 Solution

#### rolldown + lightningcss: postinstall patch script

`scripts/postinstall.mjs` runs during `pnpm install` and:

1. Detects the platform; exits immediately on non-`linux`/non-`riscv64`
2. Downloads pre-built riscv64 bindings from fork packages on the npm registry (`@dengxifeng/binding-linux-riscv64-gnu@1.0.0-rc.12`, `@dengxifeng/lightningcss-linux-riscv64-gnu@1.32.0`)
3. Caches them under `node_modules/.cache/` to avoid repeated downloads
4. Copies the bindings into all rolldown/lightningcss installation directories

#### matrix-sdk-crypto-nodejs + lancedb: pnpm overrides

`package.json` uses pnpm `overrides` to redirect these packages to forks with riscv64 bindings:

```json
{
  "pnpm": {
    "overrides": {
      "@matrix-org/matrix-sdk-crypto-nodejs": "github:dengxifeng/matrix-rust-sdk-crypto-nodejs#v0.4.0-riscv",
      "@lancedb/lancedb": "npm:@dengxifeng/lancedb@^0.27.1"
    }
  }
}
```

#### .npmrc architecture declaration

```ini
supportedArchitectures.cpu=riscv64,current
supportedArchitectures.os=linux,current
```

### 1.3 Files Changed

| File                      | Change                                            |
| ------------------------- | ------------------------------------------------- |
| `.npmrc`                  | Add supportedArchitectures config                 |
| `package.json`            | Add postinstall script, pnpm overrides, devDeps   |
| `scripts/postinstall.mjs` | New file: rolldown + lightningcss riscv64 patches |

---

## 2. V8 Wasm Trap Handler Virtual Address Space Exhaustion

### 2.1 Problem

V8 reserves ~10 GB of virtual address space per WebAssembly instance for trap-handler guard regions. On x86-64 (128 TB user VA) this is fine, but RISC-V Sv39 has only 256 GB of user VA space. After ~24 Wasm instances the VA space is exhausted:

```
Out of memory: Cannot allocate Wasm memory
```

Node.js's built-in undici HTTP client uses the Wasm-based llhttp implementation, so this triggers even without application-level WebAssembly usage.

### 2.2 Solution

Pass `--disable-wasm-trap-handler` to Node.js at all startup entry points, switching V8 to explicit bounds checks instead of trap-handler guard regions.

### 2.3 Performance Impact

- Explicit bounds checks add one compare+branch per Wasm memory access (~5-15% overhead for Wasm-heavy workloads)
- OpenClaw's core logic is JS/TS and I/O; Wasm is not on the hot path, so practical impact is negligible

### 2.4 Files Changed

| File                         | Role                    | Approach                                                         |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `openclaw.mjs`               | CLI main entry          | Detect riscv64, re-exec with flag via `child_process.spawn`      |
| `scripts/run-node.mjs`       | Dev/script launcher     | `riscvNodeFlags()` injects flag into spawn args                  |
| `src/daemon/program-args.ts` | Daemon argument builder | `platformNodeFlags()` injects flag into programArguments (Node only) |

### 2.5 Implementation Details

`openclaw.mjs` uses a re-exec pattern (detects riscv64 + missing flag in `execArgv`, then spawns a child with the flag and awaits exit) because it is executed directly by Node.js and cannot inject V8 flags before startup.

`run-node.mjs` and `program-args.ts` insert the flag into spawn arguments between the Node.js executable path and the script path. `program-args.ts` additionally checks the runtime type, only injecting the flag for Node.js (not Bun).

---

## 3. Update Path Interception

### 3.1 Problem

The riscv64 build uses a version suffix (`2026.4.9-riscv64.1`), but the public npm registry's `openclaw` package only provides x86-64/arm64 builds. Running `openclaw update` would pull an incompatible upstream version.

### 3.2 Solution

`isCompatibleArchUpdate()` in `src/infra/update-check.ts` checks semver prerelease tags:

- If current version contains `riscv64` in prerelease, the target must also contain `riscv64`
- Non-riscv64 versions are unaffected

Interception points:

| File                                       | Update Path                          |
| ------------------------------------------ | ------------------------------------ |
| `src/cli/update-cli/update-command.ts`     | CLI `openclaw update` command        |
| `src/infra/update-startup.ts`              | Gateway startup auto-update check    |
| `src/infra/update-runner.ts`               | Global package manager update runner |

---

## 4. Build Script Adaptation

`scripts/bundle-a2ui.mjs` adds a hoisted `node_modules/rolldown` fallback path so the bundler can be found in pnpm's hoisted layout on riscv64.

---

## 5. Startup Performance Fixes (Slow CPU Mitigation)

RISC-V hardware is significantly slower than x86-64/arm64 at single-core workloads. Two startup hot paths were identified as causing ~18s regressions and patched to avoid expensive plugin loading on the critical path.

### 5.1 Banner tagline mode (`src/cli/banner-config-lite.ts`)

**Problem:** `readCliBannerTaglineMode()` called `createConfigIO().loadConfig()`, which internally invokes `validateConfigObjectWithPlugins()`. This triggers full plugin loading (Jiti + AJV schema validation) just to read one leaf value (`cli.banner.taglineMode`).

**Fix:** Replace with a lightweight raw read path:
1. Resolve the config file path via `resolveConfigPath(env)`
2. Read and parse the raw JSON5 with `parseConfigJson5()` — no plugin validation
3. Extract `cli.banner.taglineMode` directly from the parsed object

This avoids plugin loading entirely for banner rendering.

### 5.2 Auth choice CLI help string (`src/commands/auth-choice-options.ts`)

**Problem:** `formatAuthChoiceChoicesForCli()` called `resolveProviderSetupFlowContributions()`, which triggers the full runtime plugin load (Jiti + AJV) to enumerate provider auth choices — used only for generating a static `--help` string.

**Fix:** Replace with `resolveManifestProviderAuthChoices()`, which reads JSON manifests only (no Jiti/AJV). Filter by `onboardingScopes` matching `"text-inference"` and map to `choiceId`. The interactive wizard (`buildAuthChoiceOptions`) retains the full runtime path for correctness.

### 5.3 Files Changed

| File                                  | Change                                                        |
| ------------------------------------- | ------------------------------------------------------------- |
| `src/cli/banner-config-lite.ts`       | Raw JSON5 read instead of full `createConfigIO().loadConfig()` |
| `src/commands/auth-choice-options.ts` | Manifest-only auth choices instead of full plugin load        |

---

## 6. Known Limitations

- **oxlint/tsgolint**: pre-commit hook lint tools lack riscv64 native packages; lint steps may fail but do not block commits
- **Dependency fork maintenance**: riscv64 support for rolldown, lightningcss, matrix-sdk-crypto-nodejs, and lancedb depends on third-party forks; track upstream merge progress and remove overrides/patches when native support lands

