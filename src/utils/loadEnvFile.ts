import * as fs from 'fs';

/**
 * Minimal, dependency-free ".env" loader (no `dotenv` package: this project
 * had zero npm dependencies until `ws` was added for the chatbot's
 * WebSocket, and this is simple enough not to need one either).
 *
 * Only fills in keys that are not already set in `process.env`, so a real
 * exported environment variable (Docker Compose, CI, the boss's shell)
 * always wins over the file. Missing file is not an error — most consumers
 * (Docker) already inject env vars directly and have no `.env` on disk.
 */
export function loadEnvFile(filePath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) { continue; }
    const eq = line.indexOf('=');
    if (eq === -1) { continue; }
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) { continue; }
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
