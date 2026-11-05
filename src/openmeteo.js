const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const USER_AGENT = "climate-compare/1.0";

// A User-Agent header is forbidden in browsers, so only send it from Node.
const REQUEST_HEADERS = typeof window === "undefined" ? { "user-agent": USER_AGENT } : undefined;

/**
 * Daily ERA5 reanalysis variables. `sunshine_duration` is in seconds,
 * `wind_speed_10m_mean` is a daily mean wind speed, and
 * `relative_humidity_2m_mean` is the mean relative humidity for the day.
 */
export const DAILY_VARIABLES = [
  "temperature_2m_max",
  "temperature_2m_min",
  "relative_humidity_2m_mean",
  "precipitation_sum",
  "sunshine_duration",
  "wind_speed_10m_mean",
];

export class ClimateError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "ClimateError";
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_ATTEMPTS = 3;

/**
 * Fetches daily reanalysis for a date range. Browser-safe: it only needs fetch,
 * URL and AbortSignal, all of which exist in both Node 18+ and browsers.
 */
export async function fetchArchive({ latitude, longitude, startYear, endYear }, attempt = 1) {
  const url = new URL(ARCHIVE_URL);
  url.searchParams.set("latitude", latitude.toFixed(4));
  url.searchParams.set("longitude", longitude.toFixed(4));
  url.searchParams.set("start_date", `${startYear}-01-01`);
  url.searchParams.set("end_date", `${endYear}-12-31`);
  url.searchParams.set("daily", DAILY_VARIABLES.join(","));
  url.searchParams.set("timezone", "auto");

  let response;
  try {
    response = await fetch(url, {
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    throw new ClimateError(`Climate service is unreachable (${error.message}).`, 504);
  }

  if (response.status === 429) {
    // The free tier meters heavy multi-year queries against a per-minute budget,
    // so a burst of city loads from one visitor may briefly exceed it.
    if (attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 10;
      await sleep(Math.min(waitSeconds, 45) * 1000);
      return fetchArchive({ latitude, longitude, startYear, endYear }, attempt + 1);
    }
    throw new ClimateError(
      "The weather service is busy right now. Please try again in a minute.",
      429,
    );
  }

  if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
    await sleep(attempt * 1500);
    return fetchArchive({ latitude, longitude, startYear, endYear }, attempt + 1);
  }

  if (!response.ok) {
    throw new ClimateError(`Climate service returned status ${response.status}.`, 502);
  }

  const payload = await response.json();
  if (payload?.error) {
    throw new ClimateError(payload.reason ?? "Climate service rejected the request.", 502);
  }
  return payload;
}
