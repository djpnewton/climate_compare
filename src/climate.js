import { cached } from "./cache.js";

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const USER_AGENT = "climate-compare/1.0 (local development app)";

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Daily ERA5 reanalysis variables. `sunshine_duration` is in seconds and
 * `wind_speed_10m_mean` is a daily mean wind speed, which is exactly the
 * "average" the comparison table needs.
 */
const DAILY_VARIABLES = [
  "temperature_2m_max",
  "temperature_2m_min",
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

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

const divide = (total, count) => (count > 0 ? total / count : null);

const mean = (values) => {
  const usable = values.filter((value) => value !== null);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
};

const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);

/** Most recent N complete calendar years. ERA5 lags a few days, so avoid early January. */
export function normalisePeriod(years, today = new Date()) {
  const currentYear = today.getUTCFullYear();
  const tooEarlyForLastYear = today.getUTCMonth() === 0 && today.getUTCDate() < 10;
  const endYear = tooEarlyForLastYear ? currentYear - 2 : currentYear - 1;
  return { startYear: endYear - years + 1, endYear };
}

const emptyCell = () => ({
  days: 0,
  rainyDays: 0,
  maxSum: 0,
  maxCount: 0,
  minSum: 0,
  minCount: 0,
  precipSum: 0,
  precipCount: 0,
  sunSum: 0,
  sunCount: 0,
  windSum: 0,
  windCount: 0,
});

function addInto(target, source) {
  target.days += source.days;
  target.rainyDays += source.rainyDays;
  target.maxSum += source.maxSum;
  target.maxCount += source.maxCount;
  target.minSum += source.minSum;
  target.minCount += source.minCount;
  target.precipSum += source.precipSum;
  target.precipCount += source.precipCount;
  target.sunSum += source.sunSum;
  target.sunCount += source.sunCount;
  target.windSum += source.windSum;
  target.windCount += source.windCount;
  return target;
}

/** Per-year totals are needed for rain and sunshine, which are sums rather than averages. */
function summariseMonth(cells) {
  const combined = cells.reduce((total, cell) => addInto(total, cell), emptyCell());

  // Rain and sunshine are totals, so a year with only a handful of recorded days would
  // understate them. Prefer years covering at least 25 days of that month.
  const usableFor = (countKey) => {
    const complete = cells.filter((cell) => cell[countKey] >= 25);
    return complete.length ? complete : cells;
  };

  const rainCells = usableFor("precipCount");
  const sunCells = usableFor("sunCount");

  const meanPerYear = (list, countKey, mapper) =>
    mean(list.map((cell) => (cell[countKey] > 0 ? mapper(cell) : null)));

  return {
    // Averages ignore missing days entirely, so every recorded day still contributes.
    high: round1(divide(combined.maxSum, combined.maxCount)),
    low: round1(divide(combined.minSum, combined.minCount)),
    wind: round1(divide(combined.windSum, combined.windCount)),
    rain: round1(meanPerYear(rainCells, "precipCount", (cell) => cell.precipSum)),
    sunshineHours: round1(meanPerYear(sunCells, "sunCount", (cell) => cell.sunSum / 3600)),
    sunshineHoursPerDay: round1(
      meanPerYear(sunCells, "sunCount", (cell) => cell.sunSum / 3600 / cell.sunCount),
    ),
    rainyDays: round1(meanPerYear(rainCells, "precipCount", (cell) => cell.rainyDays)),
  };
}

function bucketByMonth(daily) {
  const dates = daily?.time ?? [];
  const byMonth = Array.from({ length: 12 }, () => new Map());

  for (let i = 0; i < dates.length; i++) {
    const iso = dates[i];
    const year = Number(iso.slice(0, 4));
    const month = Number(iso.slice(5, 7));
    if (!Number.isInteger(year) || month < 1 || month > 12) continue;

    const yearMap = byMonth[month - 1];
    let cell = yearMap.get(year);
    if (!cell) {
      cell = emptyCell();
      yearMap.set(year, cell);
    }
    cell.days += 1;

    const max = num(daily.temperature_2m_max?.[i]);
    if (max !== null) {
      cell.maxSum += max;
      cell.maxCount += 1;
    }

    const min = num(daily.temperature_2m_min?.[i]);
    if (min !== null) {
      cell.minSum += min;
      cell.minCount += 1;
    }

    const rain = num(daily.precipitation_sum?.[i]);
    if (rain !== null) {
      cell.precipSum += rain;
      cell.precipCount += 1;
      if (rain >= 1) cell.rainyDays += 1;
    }

    const sun = num(daily.sunshine_duration?.[i]);
    if (sun !== null) {
      cell.sunSum += sun;
      cell.sunCount += 1;
    }

    const wind = num(daily.wind_speed_10m_mean?.[i]);
    if (wind !== null) {
      cell.windSum += wind;
      cell.windCount += 1;
    }
  }

  // Annual figures reuse the per-month cells, so every day is counted exactly once.
  const overall = byMonth
    .flatMap((yearMap) => [...yearMap.values()])
    .reduce((total, cell) => addInto(total, cell), emptyCell());

  return { byMonth, overall };
}

export function aggregateNormal(daily) {
  const { byMonth, overall } = bucketByMonth(daily);
  const populated = byMonth.filter((map) => map.size > 0);
  if (!populated.length) return null;

  const monthly = byMonth.map((map, index) => {
    const cells = [...map.values()];
    const summary = cells.length ? summariseMonth(cells) : null;
    return {
      month: index + 1,
      label: MONTH_LABELS[index],
      high: summary?.high ?? null,
      low: summary?.low ?? null,
      rain: summary?.rain ?? null,
      sunny: summary?.sunshineHoursPerDay ?? null,
      wind: summary?.wind ?? null,
      sunshineHours: summary?.sunshineHours ?? null,
      rainyDays: summary?.rainyDays ?? null,
      years: map.size,
    };
  });

  const withRain = monthly.filter((month) => month.rain !== null);
  const withSun = monthly.filter((month) => month.sunshineHours !== null);

  const annual = {
    high: round1(divide(overall.maxSum, overall.maxCount)),
    low: round1(divide(overall.minSum, overall.minCount)),
    wind: round1(divide(overall.windSum, overall.windCount)),
    rain: withRain.length ? round1(withRain.reduce((sum, month) => sum + month.rain, 0)) : null,
    sunshineHours: withSun.length
      ? round1(withSun.reduce((sum, month) => sum + month.sunshineHours, 0))
      : null,
    sunny: overall.sunCount > 0 ? round1(overall.sunSum / 3600 / overall.sunCount) : null,
    rainyDays: round1(monthly.reduce((sum, month) => sum + (month.rainyDays ?? 0), 0)),
  };

  const yearsSeen = new Set();
  for (const map of byMonth) for (const year of map.keys()) yearsSeen.add(year);
  const sortedYears = [...yearsSeen].sort((a, b) => a - b);
  const completeYears = sortedYears.filter((year) => {
    const days = byMonth.reduce((sum, map) => sum + (map.get(year)?.days ?? 0), 0);
    return days >= 300;
  });

  return {
    monthly,
    annual,
    coverage: {
      startYear: sortedYears[0] ?? null,
      endYear: sortedYears.at(-1) ?? null,
      completeYears: completeYears.length,
      sampleDays: overall.days,
      // Some coastal/ocean grid cells lack sunshine or wind records.
      hasSunshine: overall.sunCount > 0,
      hasWind: overall.windCount > 0,
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_ATTEMPTS = 3;

async function fetchArchive({ latitude, longitude, startYear, endYear }, attempt = 1) {
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
      headers: { "user-agent": USER_AGENT },
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

export async function getClimateNormal({ latitude, longitude, years = 10, cache }) {
  const period = normalisePeriod(years);
  const key =
    `climate:v1:${latitude.toFixed(2)}:${longitude.toFixed(2)}:${period.startYear}-${period.endYear}`;

  const load = async () => {
    const payload = await fetchArchive({ latitude, longitude, ...period });
    const normal = aggregateNormal(payload.daily);
    if (!normal) {
      throw new ClimateError("No climate records are available for this location.", 404);
    }
    return {
      location: {
        latitude: payload.latitude ?? latitude,
        longitude: payload.longitude ?? longitude,
        elevation: payload.elevation ?? null,
        timezone: payload.timezone ?? null,
        timezoneAbbreviation: payload.timezone_abbreviation ?? null,
      },
      requestedPeriod: period,
      ...normal,
      units: { temperature: "°C", precipitation: "mm", wind: "km/h", sunshine: "h" },
    };
  };

  return cache ? cached(cache, key, load) : load();
}
