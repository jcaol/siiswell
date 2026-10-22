/** The D1 `database_name` from wrangler.toml (the name the printed `wrangler d1 execute` lines need), else `<db-name>`. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function d1Name(root = join(import.meta.dir, "..")): string {
  try {
    return /^database_name\s*=\s*"([A-Za-z0-9._-]+)"/m.exec(readFileSync(join(root, "wrangler.toml"), "utf8"))?.[1] ?? "<db-name>";
  } catch {
    return "<db-name>";
  }
}
