import { cached } from "./cache.js";
import { buildNormal, normalisePeriod } from "./normals.js";
import { ClimateError, fetchArchive } from "./openmeteo.js";

export { buildNormal, normalisePeriod, MONTH_LABELS, aggregateNormal } from "./normals.js";
export { ClimateError } from "./openmeteo.js";

/** Node-side climate loader: fetches once per locality, then serves from cache. */
export async function getClimateNormal({ latitude, longitude, years = 10, cache }) {
  const period = normalisePeriod(years);
  const key =
    `climate:v2:${latitude.toFixed(2)}:${longitude.toFixed(2)}:${period.startYear}-${period.endYear}`;

  const load = async () => {
    const payload = await fetchArchive({ latitude, longitude, ...period });
    const normal = buildNormal(payload, { latitude, longitude, period });
    if (!normal) {
      throw new ClimateError("No climate records are available for this location.", 404);
    }
    return normal;
  };

  return cache ? cached(cache, key, load) : load();
}
