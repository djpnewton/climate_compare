/**
 * Data access for the UI. Two interchangeable backends:
 *
 *  - server: talks to the local Express API (`/api/*`), which caches on disk.
 *  - static: calls Open-Meteo straight from the browser (GitHub Pages build),
 *    caching in localStorage instead.
 *
 * The static modules are only loaded when the page was built for static hosting,
 * so the server build never requests files that do not exist.
 */
const CACHE_PREFIX = "climate-compare:v1:";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 40;
const YEARS = 10;

const cacheKey = (key) => CACHE_PREFIX + key;

export function createBackend() {
  return globalThis.__CLIMATE_STATIC__ ? createStaticBackend() : createServerBackend();
}

function createServerBackend() {
  async function requestJson(path) {
    let response;
    try {
      response = await fetch(path);
    } catch {
      throw new Error("Network error. Check your connection and try again.");
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
    return body;
  }

  return {
    async searchCities(query) {
      const body = await requestJson(`/api/geocode?q=${encodeURIComponent(query)}`);
      return body.results ?? [];
    },
    async loadClimate({ latitude, longitude }) {
      const params = new URLSearchParams({ lat: String(latitude), lon: String(longitude) });
      return requestJson(`/api/climate?${params}`);
    },
  };
}

async function createStaticBackend() {
  const [normals, openmeteo, geocode] = await Promise.all([
    import("./normals.js"),
    import("./openmeteo.js"),
    import("./geocode.js"),
  ]);

  const cachedNormal = (key) => {
    try {
      const entry = JSON.parse(localStorage.getItem(cacheKey(key)) ?? "null");
      if (!entry?.storedAt || !entry.value) return null;
      return { value: entry.value, fresh: Date.now() - entry.storedAt < CACHE_TTL_MS };
    } catch {
      return null;
    }
  };

  const storeNormal = (key, value) => {
    try {
      pruneCache();
      localStorage.setItem(cacheKey(key), JSON.stringify({ storedAt: Date.now(), value }));
    } catch {
      // Private mode or a full quota: the app still works, it just refetches.
    }
  };

  return {
    async searchCities(query) {
      return geocode.searchCities(query);
    },

    async loadClimate({ latitude, longitude, years = YEARS }) {
      const period = normals.normalisePeriod(years);
      const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}:${period.startYear}-${period.endYear}`;
      const hit = cachedNormal(key);
      if (hit?.fresh) return hit.value;

      try {
        const payload = await openmeteo.fetchArchive({ latitude, longitude, ...period });
        const normal = normals.buildNormal(payload, { latitude, longitude, period });
        if (!normal) throw new Error("No climate records are available for this location.");
        storeNormal(key, normal);
        return normal;
      } catch (error) {
        if (hit) return hit.value;
        throw error;
      }
    },
  };
}

/** Keeps the oldest-looked-up cities from filling up localStorage. */
function pruneCache() {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(CACHE_PREFIX)) continue;
    let storedAt = 0;
    try {
      storedAt = JSON.parse(localStorage.getItem(key))?.storedAt ?? 0;
    } catch {
      /* treat unreadable entries as oldest */
    }
    entries.push({ key, storedAt });
  }

  if (entries.length < MAX_CACHE_ENTRIES) return;
  entries
    .sort((a, b) => a.storedAt - b.storedAt)
    .slice(0, entries.length - MAX_CACHE_ENTRIES + 1)
    .forEach((entry) => localStorage.removeItem(entry.key));
}
