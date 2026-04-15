#!/usr/bin/env node
// Downloads the rolldown riscv64 native binding from npm registry and copies it
// into every installed rolldown version.
import { copyFileSync, createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { get } from "node:https";
import { join } from "node:path";
import { arch, platform } from "node:process";
import { execSync } from "node:child_process";

if (platform !== "linux" || arch !== "riscv64") {
  process.exit(0);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = (href) => {
      get(href, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${href}`));
          return;
        }
        const file = createWriteStream(dest);
        file.on("error", reject);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      }).on("error", reject);
    };
    request(url);
  });
}

async function downloadWithRetry(url, dest, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await download(url, dest);
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      const delay = (i + 1) * 5000;
      console.log(`[postinstall] Download failed (${err.code ?? err.message}), retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

const nodeModules = join(import.meta.dirname, "..", "node_modules");

if (existsSync(nodeModules)) {
  // Find all directories matching a subpath pattern under node_modules.
  function findAll(subpath) {
    try {
      return execSync(`find "${nodeModules}" -path "*/${subpath}" -type d`, { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // Patch rolldown (dev dependency)
  const BINDING_NAME = "rolldown-binding.linux-riscv64-gnu.node";
  const CACHE_PATH = join(nodeModules, ".cache", BINDING_NAME);
  const BINDING_PKG_URL =
    "https://registry.npmjs.org/@dengxifeng/binding-linux-riscv64-gnu/-/binding-linux-riscv64-gnu-1.0.0-rc.12.tgz";

  if (!existsSync(CACHE_PATH)) {
    console.log(`[patch-rolldown-binding] Downloading from npm registry...`);
    const tarPath = join(nodeModules, ".cache", "binding-riscv64.tgz");
    mkdirSync(join(tarPath, ".."), { recursive: true });
    await downloadWithRetry(BINDING_PKG_URL, tarPath);

    const extractDir = join(nodeModules, ".cache", "binding-riscv64-extract");
    mkdirSync(extractDir, { recursive: true });
    execSync(`tar -xzf "${tarPath}" -C "${extractDir}"`, { stdio: "ignore" });

    const bindingInTar = join(extractDir, "package", BINDING_NAME);
    copyFileSync(bindingInTar, CACHE_PATH);

    rmSync(tarPath);
    rmSync(extractDir, { recursive: true });
    console.log(`[patch-rolldown-binding] Downloaded to ${CACHE_PATH}`);
  }

  let patched = 0;
  for (const sharedDir of findAll("rolldown/dist/shared")) {
    const target = join(sharedDir, BINDING_NAME);
    if (existsSync(target)) {continue;}
    copyFileSync(CACHE_PATH, target);
    patched++;
    console.log(`[patch-rolldown-binding] Patched ${sharedDir}`);
  }

  if (patched > 0) {
    console.log(`[patch-rolldown-binding] Done, patched ${patched} installation(s).`);
  }

  // Patch lightningcss (dev dependency)
  const LCSS_BINDING_NAME = "lightningcss.linux-riscv64-gnu.node";
  const LCSS_CACHE_PATH = join(nodeModules, ".cache", LCSS_BINDING_NAME);
  const LCSS_PKG_URL =
    "https://registry.npmjs.org/@dengxifeng/lightningcss-linux-riscv64-gnu/-/lightningcss-linux-riscv64-gnu-1.32.0.tgz";

  if (!existsSync(LCSS_CACHE_PATH)) {
    console.log(`[patch-lightningcss] Downloading from npm registry...`);
    const tarPath = join(nodeModules, ".cache", "lightningcss-riscv64.tgz");
    mkdirSync(join(tarPath, ".."), { recursive: true });
    await downloadWithRetry(LCSS_PKG_URL, tarPath);

    const extractDir = join(nodeModules, ".cache", "lightningcss-riscv64-extract");
    mkdirSync(extractDir, { recursive: true });
    execSync(`tar -xzf "${tarPath}" -C "${extractDir}"`, { stdio: "ignore" });

    const bindingInTar = join(extractDir, "package", LCSS_BINDING_NAME);
    copyFileSync(bindingInTar, LCSS_CACHE_PATH);

    rmSync(tarPath);
    rmSync(extractDir, { recursive: true });
    console.log(`[patch-lightningcss] Downloaded to ${LCSS_CACHE_PATH}`);
  }

  let lcssPatched = 0;
  for (const lcssDir of findAll("node_modules/lightningcss")) {
    const target = join(lcssDir, LCSS_BINDING_NAME);
    if (existsSync(target)) {continue;}
    copyFileSync(LCSS_CACHE_PATH, target);
    lcssPatched++;
    console.log(`[patch-lightningcss] Patched ${lcssDir}`);
  }

  if (lcssPatched > 0) {
    console.log(`[patch-lightningcss] Done, patched ${lcssPatched} installation(s).`);
  }
}
