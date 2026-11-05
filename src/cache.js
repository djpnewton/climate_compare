import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_MEMORY_ENTRIES = 500;

/**
 * Two-tier cache (memory + JSON files on disk) so repeat lookups do not hit
 * the upstream weather API, and survive a server restart.
 */
export function createCache({ directory, ttlMs }) {
  const memory = new Map();
  let directoryReady;

  const ensureDirectory = () => (directoryReady ??= fs.mkdir(directory, { recursive: true }));

  const fileFor = (key) =>
    path.join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);

  async function readDisk(key) {
    await ensureDirectory();
    try {
      const entry = JSON.parse(await fs.readFile(fileFor(key), "utf8"));
      if (entry?.key !== key) return null;
      return { value: entry.value, storedAt: entry.storedAt };
    } catch {
      return null;
    }
  }

  async function writeDisk(key, value, storedAt) {
    await ensureDirectory();
    const target = fileFor(key);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ key, storedAt, value }));
    await fs.rename(temporary, target);
  }

  function rememberInMemory(key, value, storedAt) {
    if (memory.size >= MAX_MEMORY_ENTRIES) {
      memory.delete(memory.keys().next().value);
    }
    memory.set(key, { value, storedAt });
  }

  return {
    /** Returns `{ value, fresh }` or `null`. Stale entries are still returned. */
    async get(key) {
      let entry = memory.get(key);
      if (!entry) {
        entry = await readDisk(key);
        if (entry) rememberInMemory(key, entry.value, entry.storedAt);
      }
      if (!entry) return null;
      return { value: entry.value, fresh: Date.now() - entry.storedAt < ttlMs };
    },

    async set(key, value) {
      const storedAt = Date.now();
      rememberInMemory(key, value, storedAt);
      await writeDisk(key, value, storedAt).catch((error) => {
        console.warn(`cache write failed for ${key}:`, error.message);
      });
    },
  };
}

/** Serve a cached value when it is fresh, otherwise load it, falling back to stale data on failure. */
export async function cached(cache, key, load) {
  const hit = await cache.get(key);
  if (hit?.fresh) return hit.value;

  try {
    const value = await load();
    await cache.set(key, value);
    return value;
  } catch (error) {
    if (hit) {
      console.warn(`serving stale cache for ${key} after error: ${error.message}`);
      return hit.value;
    }
    throw error;
  }
}
