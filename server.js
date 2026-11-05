import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCache } from "./src/cache.js";
import { searchCities } from "./src/geocode.js";
import { getClimateNormal } from "./src/climate.js";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const cacheDirectory = path.join(rootDirectory, ".cache");

const DAY = 24 * 60 * 60 * 1000;

const climateCache = createCache({
  directory: path.join(cacheDirectory, "climate"),
  ttlMs: 30 * DAY,
});

const geocodeCache = createCache({
  directory: path.join(cacheDirectory, "geocode"),
  ttlMs: 7 * DAY,
});

/** Upstream allows 600 weight-units/minute and a 10-year city query costs ~130,
 *  so queue aggressively rather than fire everything at once. */
const limitClimateRequests = createLimiter(2);
const limitGeocodeRequests = createLimiter(4);

function createLimiter(limit) {
  let active = 0;
  const queue = [];

  function runNext() {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    task()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  }

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
}

const app = express();
app.disable("x-powered-by");
app.use(express.static(path.join(rootDirectory, "public"), { extensions: ["html"] }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

app.get("/api/geocode", async (request, response) => {
  const query = String(request.query.q ?? "").trim();
  if (query.length < 2) {
    response.json({ results: [] });
    return;
  }

  const key = `geocode:v1:${query.toLowerCase()}`;
  try {
    const results = await limitGeocodeRequests(() => cachedJson(geocodeCache, key, () => searchCities(query)));
    response.json({ results });
  } catch (error) {
    console.warn(`geocode failed for "${query}":`, error.message);
    response.status(error.status ?? 502).json({ error: "City lookup failed. Please try again." });
  }
});

app.get("/api/climate", async (request, response) => {
  const latitude = Number(request.query.lat);
  const longitude = Number(request.query.lon);
  const years = clamp(Number(request.query.years) || 10, 5, 20);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    response.status(400).json({ error: "A valid lat and lon are required." });
    return;
  }

  try {
    const normal = await limitClimateRequests(() =>
      getClimateNormal({ latitude, longitude, years, cache: climateCache }),
    );
    response.json(normal);
  } catch (error) {
    const status = error.status ?? 502;
    if (status >= 500) console.error("climate lookup failed:", error);
    else console.warn(`climate lookup rejected (${status}):`, error.message);
    response.status(status).json({ error: error.message ?? "Could not load climate data." });
  }
});

app.use("/api", (_request, response) => {
  response.status(404).json({ error: "Unknown API endpoint." });
});

app.use((error, _request, response, _next) => {
  console.error("unhandled error:", error);
  response.status(500).json({ error: "Something went wrong." });
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function cachedJson(cache, key, load) {
  const hit = await cache.get(key);
  if (hit?.fresh) return hit.value;
  const value = await load();
  await cache.set(key, value);
  return value;
}

const server = app.listen(port, () => {
  console.log(`Climate Compare running at http://localhost:${port}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Set PORT to choose another one.`);
    process.exit(1);
  }
  throw error;
});
