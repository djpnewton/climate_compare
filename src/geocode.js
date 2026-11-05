const GEODATA_URL = "https://geocoding-api.open-meteo.com/v1/search";
const USER_AGENT = "climate-compare/1.0";

// A User-Agent header is forbidden in browsers, so only send it from Node.
const REQUEST_HEADERS = typeof window === "undefined" ? { "user-agent": USER_AGENT } : undefined;

export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

async function getJson(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new UpstreamError(`City search is unreachable (${error.message}).`, 504);
  }

  if (!response.ok) {
    throw new UpstreamError(`City search failed with status ${response.status}.`, 502);
  }
  return response.json();
}

function toCandidate(result) {
  const parts = [result.name, result.admin1, result.country].filter(Boolean);
  return {
    id: result.id,
    name: result.name,
    admin1: result.admin1 ?? null,
    country: result.country ?? null,
    countryCode: result.country_code ?? null,
    latitude: result.latitude,
    longitude: result.longitude,
    elevation: result.elevation ?? null,
    timezone: result.timezone ?? null,
    population: result.population ?? 0,
    label: parts.join(", "),
  };
}

export async function searchCities(query) {
  const url = new URL(GEODATA_URL);
  url.searchParams.set("name", query);
  url.searchParams.set("count", "10");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const payload = await getJson(url);
  const seen = new Set();

  // Upstream already ranks by relevance (bigger, better-known places first), so keep
  // that order and only drop duplicates that land on the same coordinates.
  return (payload?.results ?? [])
    .map(toCandidate)
    .filter((candidate) => Number.isFinite(candidate.latitude) && Number.isFinite(candidate.longitude))
    .filter((candidate) => {
      const key = `${candidate.latitude.toFixed(2)},${candidate.longitude.toFixed(2)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
