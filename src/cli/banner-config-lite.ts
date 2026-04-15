import fs from "node:fs";
import { parseConfigJson5 } from "../config/config.js";
import { resolveConfigPath } from "../config/paths.js";
import type { TaglineMode } from "./tagline.js";

export function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === "random" || value === "default" || value === "off") {
    return value;
  }
  return undefined;
}

export function readCliBannerTaglineMode(
  env: NodeJS.ProcessEnv = process.env,
): TaglineMode | undefined {
  try {
    // Use a raw lightweight read to avoid triggering plugin loading via
    // createConfigIO().loadConfig() which calls validateConfigObjectWithPlugins().
    // We only need one leaf value (cli.banner.taglineMode) so full validation
    // is unnecessary and would cause a ~18s startup regression on slow CPUs.
    const configPath = resolveConfigPath(env);
    if (!fs.existsSync(configPath)) return undefined;
    const raw = fs.readFileSync(configPath, "utf-8");
    const result = parseConfigJson5(raw);
    if (!result.ok) return undefined;
    const parsed = result.parsed as {
      cli?: { banner?: { taglineMode?: unknown } };
    };
    return parseTaglineMode(parsed.cli?.banner?.taglineMode);
  } catch {
    return undefined;
  }
}
