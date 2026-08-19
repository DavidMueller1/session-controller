import { existsSync, readFileSync } from "node:fs";

/**
 * Minimal `.env` parser: `KEY=VALUE` per line, `#` comments and blank lines ignored,
 * optional `export ` prefix, and surrounding single/double quotes stripped. Good enough
 * for injecting configured env into a spawned dev server — not a full dotenv implementation
 * (no variable expansion, no multiline values).
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** parse a `.env` file if it exists, else {} */
export function readEnvFile(file: string): Record<string, string> {
  try {
    if (!existsSync(file)) return {};
    return parseEnv(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
