export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

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
  humiditySum: 0,
  humidityCount: 0,
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
  target.humiditySum += source.humiditySum;
  target.humidityCount += source.humidityCount;
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
    humidity: round1(divide(combined.humiditySum, combined.humidityCount)),
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

    const humidity = num(daily.relative_humidity_2m_mean?.[i]);
    if (humidity !== null) {
      cell.humiditySum += humidity;
      cell.humidityCount += 1;
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
      humidity: summary?.humidity ?? null,
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
    humidity: round1(divide(overall.humiditySum, overall.humidityCount)),
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
      hasHumidity: overall.humidityCount > 0,
    },
  };
}


/**
 * Shapes an archive payload into the response the UI consumes. Returns null when
 * the payload holds no usable days, so callers can raise their own error.
 */
export function buildNormal(payload, { latitude, longitude, period }) {
  const normal = aggregateNormal(payload.daily);
  if (!normal) return null;

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
    units: {
      temperature: "°C",
      precipitation: "mm",
      wind: "km/h",
      sunshine: "h",
      humidity: "%",
    },
  };
}
