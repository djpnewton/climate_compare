import assert from "node:assert/strict";
import test from "node:test";
import { aggregateNormal, normalisePeriod } from "../src/climate.js";

/** Builds a synthetic Open-Meteo daily payload where each value may be a constant or a function of the ISO date. */
function daily({ start, end, max, min, rain, sun, wind }) {
  const time = [];
  const series = {
    temperature_2m_max: [],
    temperature_2m_min: [],
    precipitation_sum: [],
    sunshine_duration: [],
    wind_speed_10m_mean: [],
  };

  const resolve = (value, iso) => (typeof value === "function" ? value(iso) : value);

  for (const cursor = new Date(`${start}T00:00:00Z`); cursor <= new Date(`${end}T00:00:00Z`); ) {
    const iso = cursor.toISOString().slice(0, 10);
    time.push(iso);
    series.temperature_2m_max.push(resolve(max, iso));
    series.temperature_2m_min.push(resolve(min, iso));
    series.precipitation_sum.push(resolve(rain, iso));
    series.sunshine_duration.push(resolve(sun, iso));
    series.wind_speed_10m_mean.push(resolve(wind, iso));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { time, ...series };
}

const month = (normal, label) => normal.monthly.find((entry) => entry.label === label);

test("averages constant daily values into monthly and annual figures", () => {
  const normal = aggregateNormal(
    daily({
      start: "2020-01-01",
      end: "2021-12-31",
      max: 20,
      min: 10,
      rain: 1,
      sun: 3600, // 1 hour per day
      wind: 5,
    }),
  );

  assert.equal(normal.monthly.length, 12);
  assert.equal(month(normal, "Jan").high, 20);
  assert.equal(month(normal, "Jan").low, 10);
  assert.equal(month(normal, "Jan").wind, 5);
  assert.equal(month(normal, "Jan").rain, 31, "average January rainfall is 31 days x 1 mm");
  assert.equal(month(normal, "Jan").sunny, 1, "one hour of sunshine per day");
  assert.equal(month(normal, "Jan").sunshineHours, 31);
  assert.equal(month(normal, "Jan").rainyDays, 31);

  // February 2020 had 29 days and 2021 had 28, so the average is 28.5.
  assert.equal(month(normal, "Feb").rain, 28.5);

  assert.equal(normal.annual.high, 20);
  assert.equal(normal.annual.rain, 365.5, "mean annual total: 731 mm over two years");
  assert.equal(normal.annual.sunny, 1);
  assert.equal(normal.coverage.startYear, 2020);
  assert.equal(normal.coverage.endYear, 2021);
  assert.equal(normal.coverage.completeYears, 2);
});

test("weights each year equally when values differ", () => {
  const normal = aggregateNormal(
    daily({
      start: "2020-01-01",
      end: "2021-12-31",
      max: (iso) => (iso.startsWith("2020") ? 10 : 20),
      min: 0,
      rain: (iso) => (iso.startsWith("2020") ? 2 : 4),
      sun: 0,
      wind: 0,
    }),
  );

  assert.equal(month(normal, "Jan").high, 15);
  assert.equal(month(normal, "Jan").rain, 93, "mean of 62 mm and 124 mm");
});

test("handles southern hemisphere ordering without assuming a season", () => {
  const normal = aggregateNormal(
    daily({
      start: "2020-01-01",
      end: "2020-12-31",
      max: (iso) => (iso.slice(5, 7) === "01" ? 26 : iso.slice(5, 7) === "07" ? 17 : 20),
      min: 5,
      rain: 0,
      sun: 0,
      wind: 0,
    }),
  );

  assert.equal(month(normal, "Jan").high, 26);
  assert.equal(month(normal, "Jul").high, 17);
});

test("skips missing days instead of treating them as zero", () => {
  const payload = daily({
    start: "2020-01-01",
    end: "2020-01-31",
    max: 10,
    min: 0,
    rain: 0,
    sun: 0,
    wind: 10,
  });
  payload.temperature_2m_max[0] = null;
  payload.temperature_2m_max[1] = null;
  payload.wind_speed_10m_mean[0] = null;

  const normal = aggregateNormal(payload);
  assert.equal(month(normal, "Jan").high, 10);
  assert.equal(month(normal, "Jan").wind, 10);
  assert.equal(normal.coverage.sampleDays, 31);
});

test("reports missing sunshine or wind as absent rather than zero", () => {
  const payload = daily({
    start: "2020-01-01",
    end: "2020-12-31",
    max: 15,
    min: 5,
    rain: 0,
    sun: null,
    wind: 0,
  });

  const normal = aggregateNormal(payload);
  assert.equal(normal.coverage.hasSunshine, false);
  assert.equal(normal.coverage.hasWind, true);
  assert.equal(month(normal, "Jan").sunny, null);
  assert.equal(month(normal, "Jan").sunshineHours, null);
  assert.equal(normal.annual.sunny, null);
  assert.equal(normal.annual.sunshineHours, null);
});

test("excludes stub months from monthly rainfall totals", () => {
  const payload = daily({
    start: "2020-01-01",
    end: "2021-12-31",
    max: 10,
    min: 0,
    rain: 1,
    sun: 3600,
    wind: 0,
  });

  // Only ten days of rain/sunshine recorded for January 2020: a partial month would
  // understate the monthly total, so that year is dropped from those averages.
  payload.time.forEach((iso, index) => {
    if (iso.startsWith("2020-01") && Number(iso.slice(8, 10)) > 10) {
      payload.precipitation_sum[index] = null;
      payload.sunshine_duration[index] = null;
    }
  });

  const normal = aggregateNormal(payload);
  assert.equal(month(normal, "Jan").rain, 31);
  assert.equal(month(normal, "Jan").sunshineHours, 31);
});

test("returns null when there is nothing to aggregate", () => {
  assert.equal(aggregateNormal({ time: [] }), null);
  assert.equal(aggregateNormal({}), null);
});

test("defaults to the last ten complete years, staying clear of the reanalysis lag", () => {
  assert.deepEqual(normalisePeriod(10, new Date("2026-11-05T00:00:00Z")), { startYear: 2016, endYear: 2025 });
  assert.deepEqual(normalisePeriod(10, new Date("2026-01-03T00:00:00Z")), { startYear: 2015, endYear: 2024 });
  assert.deepEqual(normalisePeriod(5, new Date("2026-06-01T00:00:00Z")), { startYear: 2021, endYear: 2025 });
});
