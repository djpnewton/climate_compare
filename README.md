# Climate Compare

Type a city name and compare its average climate with others, month by month and for the
year as a whole, across:

| Metric | What it means |
| --- | --- |
| Avg high | Mean daily maximum temperature |
| Avg low | Mean daily minimum temperature |
| Humidity | Mean relative humidity across the day |
| Sunshine | Average sunshine hours per day (monthly totals are included in the API) |
| Rain | Average total precipitation for the month, in mm |
| Wind | Mean daily wind speed |

Metric ⇄ imperial units are a click away, and every view is driven by the same underlying
data, so switching units never refetches.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

Set `PORT` to use a different port (`PORT=8080 npm start`). `npm run dev` restarts on file
changes.

## How it works

1. **City lookup** — `/api/geocode` proxies the
   [Open-Meteo geocoding API](https://open-meteo.com/en/docs/geocoding-api) and returns
   up to 10 matches ordered by relevance.
2. **Daily observations** — `/api/climate` asks the
   [Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) for daily
   ERA5 reanalysis for the most recent 10 complete calendar years: `temperature_2m_max`,
   `temperature_2m_min`, `relative_humidity_2m_mean`, `precipitation_sum`,
   `sunshine_duration`, `wind_speed_10m_mean`.
3. **Climate normals** — `src/climate.js` reduces ~3,650 daily records per city into twelve
   monthly figures plus an annual summary. Averages ignore missing days, while rainfall and
   sunshine (which are totals, not averages) only use years covering at least 25 days of that
   month, so a half-recorded month cannot understate them.
4. **Results are cached** on disk under `.cache/` for 30 days (city lookups for 7), which also
   keeps the app well inside the free API tier.

The frontend is plain HTML/CSS/JS with hand-rolled SVG charts — no build step, no framework.

## API

```text
GET /api/geocode?q=lisbon
GET /api/climate?lat=38.73&lon=-9.15[&years=10]
GET /api/health
```

`/api/climate` always returns metric units, along with a `coverage` block describing which
years were used and whether sunshine/wind records exist for that location.

## Data notes

- Source: ERA5 reanalysis via Open-Meteo, licensed CC BY 4.0.
- Values are model reanalysis on a ~9–25 km grid, not a single weather station, so coastal
  and mountain cities are approximated by their nearest grid cell.
- Sunshine is derived from solar radiation and typically reads a little higher than
  ground-station records (Lisbon measures ~3,700 h/yr here against ~2,800 h from instruments).
- The free API meters requests by weight: a 10-year city query costs ~156 of 600 units per
  minute (one unit per ~12 variable-days), so roughly three new cities per minute. The server
  queues city loads two at a time and retries automatically when the service is busy, so
  adding several cities at once may take a moment on a first visit.

## Tests

```bash
npm test
```

Covers the aggregation maths: monthly/annual averaging, leap years, missing days, partial
months, southern-hemisphere month mapping, and the year-range calculation.

## Layout

```text
server.js          Express app: static files, API routes, request queueing
src/climate.js     Fetch daily ERA5 data and reduce it to climate normals
src/geocode.js     City search proxy and result normalisation
src/cache.js       Two-tier (memory + disk) cache with stale-on-error fallback
public/            index.html, styles.css, app.js, favicon.svg + PNG app icons
test/              Aggregation unit tests
```
