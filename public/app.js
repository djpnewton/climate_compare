import { createBackend } from "./data.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_CITIES = 6;
const PALETTE = ["#2563eb", "#e11d48", "#0d9488", "#c2410c", "#7c3aed", "#0891b2"];
const SVG_NS = "http://www.w3.org/2000/svg";

const METRICS = [
  { key: "high", label: "Avg high", short: "High", field: "high", unit: "temperature", scale: "temperature" },
  { key: "low", label: "Avg low", short: "Low", field: "low", unit: "temperature", scale: "temperature" },
  { key: "humidity", label: "Humidity", short: "Humidity", field: "humidity", unit: "percent", scale: "humidity" },
  { key: "sunny", label: "Sunshine", short: "Sun", field: "sunny", unit: "hours", scale: "sunshine" },
  { key: "rain", label: "Rain", short: "Rain", field: "rain", unit: "precipitation", scale: "rain" },
  { key: "wind", label: "Wind", short: "Wind", field: "wind", unit: "wind", scale: "wind" },
];

const METRIC_BY_KEY = Object.fromEntries(METRICS.map((metric) => [metric.key, metric]));

const state = {
  units: "metric",
  metric: "all",
  cities: [],
  colorCursor: 0,
};

const dom = {
  form: document.querySelector("#search-form"),
  input: document.querySelector("#city-input"),
  suggestions: document.querySelector("#suggestions"),
  status: document.querySelector("#status"),
  chips: document.querySelector("#chips"),
  emptyState: document.querySelector("#empty-state"),
  examples: document.querySelector("#examples"),
  compare: document.querySelector("#compare"),
  summaries: document.querySelector("#summaries"),
  charts: document.querySelector("#charts"),
  metricTabs: document.querySelector("#metric-tabs"),
  table: document.querySelector("#table"),
  footnote: document.querySelector("#footnote"),
  units: document.querySelector("#units"),
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") node.setAttribute("style", value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function unitInfo(unit) {
  const imperial = state.units === "imperial";
  switch (unit) {
    case "temperature":
      return { suffix: imperial ? "°F" : "°C", digits: 1, convert: (c) => (imperial ? (c * 9) / 5 + 32 : c) };
    case "precipitation":
      return {
        suffix: imperial ? "in" : "mm",
        digits: imperial ? 2 : 1,
        convert: (mm) => (imperial ? mm / 25.4 : mm),
      };
    case "wind":
      return {
        suffix: imperial ? "mph" : "km/h",
        digits: 1,
        convert: (kmh) => (imperial ? kmh * 0.621371 : kmh),
      };
    case "percent":
      return { suffix: "%", digits: 0, convert: (value) => value };
    default:
      return { suffix: "h", digits: 1, convert: (hours) => hours };
  }
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

function formatValue(value, unit) {
  if (!isNumber(value)) return "—";
  const info = unitInfo(unit);
  return info.convert(value).toFixed(info.digits);
}

function rangeOf(values) {
  const usable = values.filter(isNumber);
  if (!usable.length) return null;
  return { min: Math.min(...usable), max: Math.max(...usable) };
}

function normalise(value, range) {
  if (!range || !isNumber(value)) return null;
  if (range.max === range.min) return 0.5;
  return Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)));
}

function heatColor(scale, t) {
  if (t === null) return null;
  switch (scale) {
    case "temperature": {
      // Cool blue through warm red; extremes are more saturated than the middle.
      const hue = 215 - 200 * t;
      const alpha = 0.05 + 0.32 * Math.abs(t - 0.5) * 2;
      return `hsla(${hue}, 78%, 48%, ${alpha.toFixed(3)})`;
    }
    case "rain":
      return `hsla(205, 80%, 45%, ${(0.04 + 0.34 * t).toFixed(3)})`;
    case "sunshine":
      return `hsla(42, 92%, 48%, ${(0.04 + 0.34 * t).toFixed(3)})`;
    case "humidity":
      return `hsla(285, 65%, 50%, ${(0.04 + 0.3 * t).toFixed(3)})`;
    default:
      return `hsla(172, 70%, 42%, ${(0.04 + 0.28 * t).toFixed(3)})`;
  }
}

function setStatus(message, isError = false) {
  dom.status.textContent = message ?? "";
  dom.status.classList.toggle("is-error", Boolean(isError));
}

function readyCities() {
  return state.cities.filter((city) => city.status === "ready" && city.data);
}

/* ------------------------------------------------------------------ */
/* city state                                                          */
/* ------------------------------------------------------------------ */

function cityKey(latitude, longitude) {
  return `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
}

function addCity(candidate) {
  const key = cityKey(candidate.latitude, candidate.longitude);
  if (state.cities.some((city) => city.key === key)) {
    setStatus(`${candidate.name} is already on the chart.`);
    return;
  }
  if (state.cities.length >= MAX_CITIES) {
    setStatus(`You can compare up to ${MAX_CITIES} cities at once. Remove one to add another.`, true);
    return;
  }

  const city = {
    key,
    name: candidate.name,
    label: candidate.label ?? candidate.name,
    region: [candidate.admin1, candidate.country].filter(Boolean).join(", "),
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    // Prefer the city's own elevation; the ERA5 grid cell can sit at sea level inland.
    geocodedElevation: isNumber(candidate.elevation) ? candidate.elevation : null,
    color: PALETTE[state.colorCursor % PALETTE.length],
    status: "loading",
    error: null,
    data: null,
  };
  state.colorCursor += 1;
  state.cities.push(city);
  setStatus("");
  render();
  loadCity(city);
}

async function loadCity(city) {
  const slowTimer = setTimeout(() => {
    if (city.status === "loading") {
      setStatus(
        `Still fetching ${city.name} — the free weather service is busy, retrying automatically…`,
      );
    }
  }, 8000);

  try {
    const api = await backendPromise;
    const body = await api.loadClimate({ latitude: city.latitude, longitude: city.longitude });

    city.data = body;
    city.status = "ready";
  } catch (error) {
    city.status = "error";
    city.error = error.message;
    setStatus(`Could not load climate data for ${city.name}: ${error.message}`, true);
  } finally {
    clearTimeout(slowTimer);
  }
  render();
}

function removeCity(key) {
  state.cities = state.cities.filter((city) => city.key !== key);
  render();
}

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

let suggestions = [];
let activeSuggestion = -1;
let debounceTimer = null;
let searchSequence = 0;

function closeSuggestions() {
  dom.suggestions.hidden = true;
  dom.suggestions.replaceChildren();
  dom.input.setAttribute("aria-expanded", "false");
  suggestions = [];
  activeSuggestion = -1;
}

function renderSuggestions() {
  if (!suggestions.length) {
    closeSuggestions();
    return;
  }
  dom.suggestions.replaceChildren(
    ...suggestions.map((result, index) =>
      h(
        "li",
        {
          role: "option",
          "aria-selected": String(index === activeSuggestion),
          onmousedown: (event) => {
            event.preventDefault();
            chooseSuggestion(index);
          },
        },
        h("span", { class: "sug-name", text: result.name }),
        h("span", { class: "sug-region", text: [result.admin1, result.country].filter(Boolean).join(", ") }),
        result.countryCode ? h("span", { class: "sug-flag", text: result.countryCode }) : null,
      ),
    ),
  );
  dom.suggestions.hidden = false;
  dom.input.setAttribute("aria-expanded", "true");
}

function chooseSuggestion(index) {
  const result = suggestions[index];
  if (!result) return;
  closeSuggestions();
  dom.input.value = "";
  addCity(result);
}

async function fetchSuggestions(query) {
  const seq = ++searchSequence;
  try {
    const api = await backendPromise;
    const results = await api.searchCities(query);
    // Ignore responses that arrived after a newer keystroke.
    if (seq !== searchSequence || dom.input.value.trim() !== query) return;
    suggestions = results;
    activeSuggestion = -1;
    renderSuggestions();
  } catch (error) {
    console.warn("city search failed", error);
  }
}

dom.input.addEventListener("input", () => {
  const query = dom.input.value.trim();
  clearTimeout(debounceTimer);
  if (query.length < 2) {
    closeSuggestions();
    return;
  }
  debounceTimer = setTimeout(() => fetchSuggestions(query), 220);
});

dom.input.addEventListener("keydown", (event) => {
  if (!suggestions.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    activeSuggestion = (activeSuggestion + delta + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (event.key === "Escape") {
    closeSuggestions();
  }
});

dom.input.addEventListener("blur", () => setTimeout(closeSuggestions, 120));

dom.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (activeSuggestion >= 0) {
    chooseSuggestion(activeSuggestion);
    return;
  }
  if (suggestions.length) {
    chooseSuggestion(0);
    return;
  }
  const query = dom.input.value.trim();
  if (query.length < 2) {
    setStatus("Type at least two characters to search for a city.", true);
    return;
  }
  setStatus(`Searching for “${query}”…`);
  try {
    const api = await backendPromise;
    const results = await api.searchCities(query);
    const first = results[0];
    if (!first) {
      setStatus(`No city found matching “${query}”.`, true);
      return;
    }
    dom.input.value = "";
    closeSuggestions();
    addCity(first);
  } catch {
    setStatus("City lookup failed. Please try again.", true);
  }
});

dom.units.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-units]");
  if (!button) return;
  state.units = button.dataset.units;
  render();
});

dom.metricTabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-metric]");
  if (!button) return;
  state.metric = button.dataset.metric;
  render();
});

/* ------------------------------------------------------------------ */
/* render: chips + summaries                                           */
/* ------------------------------------------------------------------ */

function renderChips() {
  dom.chips.replaceChildren(
    ...state.cities.map((city) =>
      h(
        "span",
        {
          class: `chip${city.status === "error" ? " is-error" : ""}`,
          style: `--chip-color:${city.color}`,
          title: city.status === "error" ? city.error : city.label,
        },
        h("span", { class: "dot" }),
        h("span", { class: "chip-label", text: city.label }),
        city.status === "loading" ? h("span", { class: "spinner", "aria-label": "Loading" }) : null,
        h(
          "button",
          {
            type: "button",
            "aria-label": `Remove ${city.label}`,
            onclick: () => removeCity(city.key),
          },
          "×",
        ),
      ),
    ),
  );
}

function renderSummaries(cities) {
  dom.summaries.replaceChildren(
    ...cities.map((city) => {
      if (city.status === "error") {
        return h(
          "article",
          { class: "summary-card is-error", style: `--card-color:${city.color}` },
          h("h3", {}, h("span", { class: "dot" }), city.label),
          h("p", { class: "card-meta", text: city.error ?? "Climate data could not be loaded." }),
          h(
            "button",
            {
              type: "button",
              class: "retry",
              onclick: () => {
                city.status = "loading";
                city.error = null;
                setStatus("");
                render();
                loadCity(city);
              },
            },
            "Try again",
          ),
        );
      }

      if (city.status === "loading" || !city.data) {
        return h(
          "article",
          { class: "summary-card", style: `--card-color:${city.color}` },
          h("h3", {}, h("span", { class: "dot" }), city.label),
          h("p", { class: "card-meta", text: "Loading climate normal…" }),
          h(
            "div",
            { class: "card-skeleton" },
            ...Array.from({ length: 4 }, () => h("div", { class: "skeleton-line" })),
          ),
        );
      }

      const { annual, coverage } = city.data;
      const periodText =
        coverage.startYear && coverage.endYear
          ? `${coverage.startYear}–${coverage.endYear} · ${coverage.completeYears} complete years`
          : "Historical averages";

      const elevation = city.geocodedElevation ?? city.data.location?.elevation ?? null;
      const meta = [
        city.region || null,
        isNumber(elevation) && elevation > 0 ? `${Math.round(elevation)} m elevation` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      const stat = (label, value, unit) =>
        h(
          "div",
          {},
          h("dt", { text: label }),
          h("dd", {}, value, unit ? h("span", { text: ` ${unit}` }) : null),
        );

      const temp = unitInfo("temperature");
      const precip = unitInfo("precipitation");
      const wind = unitInfo("wind");

      return h(
        "article",
        { class: "summary-card", style: `--card-color:${city.color}` },
        h("h3", {}, h("span", { class: "dot" }), city.label),
        h("p", { class: "card-meta", text: [meta, periodText].filter(Boolean).join(" · ") }),
        h(
          "dl",
          { class: "summary-stats" },
          stat("Avg high", formatValue(annual.high, "temperature"), temp.suffix),
          stat("Avg low", formatValue(annual.low, "temperature"), temp.suffix),
          stat("Humidity", formatValue(annual.humidity, "percent"), "%"),
          stat("Rain / year", formatValue(annual.rain, "precipitation"), precip.suffix),
          stat("Sun / day", formatValue(annual.sunny, "hours"), "h"),
          stat("Avg wind", formatValue(annual.wind, "wind"), wind.suffix),
          stat("Wet days", isNumber(annual.rainyDays) ? String(Math.round(annual.rainyDays)) : "—", "/yr"),
        ),
        coverage.hasSunshine && coverage.hasWind && coverage.hasHumidity
          ? null
          : h("p", {
              class: "card-alert",
              text: "Some records are missing for this location, so a few cells may be empty.",
            }),
      );
    }),
  );
}

/* ------------------------------------------------------------------ */
/* render: charts                                                      */
/* ------------------------------------------------------------------ */

function chartUnitLabel(metric) {
  switch (metric.key) {
    case "rain":
      return `${unitInfo(metric.unit).suffix} per month`;
    case "sunny":
      return "hours per day";
    case "humidity":
      return "% (mean)";
    default:
      return unitInfo(metric.unit).suffix;
  }
}

function buildChart(metric, cities, { large = false } = {}) {
  const width = large ? 900 : 430;
  const height = large ? 330 : 225;
  const pad = { top: 14, right: 16, bottom: 26, left: 46 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const info = unitInfo(metric.unit);

  const series = cities.map((city) => ({
    city,
    values: city.data.monthly.map((month) => {
      const value = month[metric.field];
      return isNumber(value) ? info.convert(value) : null;
    }),
  }));

  const allValues = series.flatMap((line) => line.values).filter(isNumber);
  const figure = h("figure", { class: "chart-card" });

  figure.append(
    h(
      "figcaption",
      {},
      h("span", { text: metric.label }),
      h("span", { class: "chart-unit", text: chartUnitLabel(metric) }),
    ),
  );

  if (!allValues.length) {
    figure.append(h("div", { class: "chart-empty", text: "No data recorded for this metric." }));
    return figure;
  }

  let min = Math.min(...allValues);
  let max = Math.max(...allValues);
  const anchorZero = metric.key === "rain" || metric.key === "sunny" || metric.key === "wind";
  if (anchorZero) {
    min = Math.min(0, min);
    max = Math.max(max, min + 1);
  } else {
    const span = max - min || 1;
    min -= span * 0.18;
    max += span * 0.18;
  }

  const xOf = (index) => pad.left + (index * plotWidth) / 11;
  const yOf = (value) => pad.top + (1 - (value - min) / (max - min)) * plotHeight;

  const root = svg("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${metric.label} by month`,
    preserveAspectRatio: "xMidYMid meet",
  });

  const ticks = 4;
  // Keep every tick on this axis formatted the same way, chosen from the axis step.
  const step = (max - min) / ticks;
  const tickDecimals = step >= 5 ? 0 : step >= 0.5 ? 1 : 2;
  for (let i = 0; i <= ticks; i++) {
    const value = min + (max - min) * (i / ticks);
    const y = yOf(value);
    root.append(svg("line", { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: "chart-grid" }));
    const label = svg("text", {
      x: pad.left - 7,
      y: y + 3,
      "text-anchor": "end",
      class: "chart-axis-label",
    });
    label.textContent = String(Number(value.toFixed(tickDecimals)));
    root.append(label);
  }

  const labelStep = large ? 1 : 2;
  MONTHS.forEach((month, index) => {
    if (index % labelStep !== 0 && index !== MONTHS.length - 1) return;
    const label = svg("text", {
      x: xOf(index),
      y: height - 8,
      "text-anchor": "middle",
      class: "chart-axis-label",
    });
    label.textContent = month;
    root.append(label);
  });

  for (const line of series) {
    // Draw each run of consecutive months separately so gaps in the data stay visible.
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        root.append(
          svg("polyline", {
            points: run.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "),
            fill: "none",
            stroke: line.city.color,
            "stroke-width": 2.1,
            "stroke-linejoin": "round",
            "stroke-linecap": "round",
          }),
        );
      }
      run = [];
    };

    line.values.forEach((value, index) => {
      if (value === null) {
        flush();
        return;
      }
      run.push([xOf(index), yOf(value)]);
    });
    flush();

    line.values.forEach((value, index) => {
      if (value === null) return;
      const point = svg("circle", {
        cx: xOf(index),
        cy: yOf(value),
        r: large ? 3.2 : 2.7,
        fill: line.city.color,
        stroke: "var(--surface-alt)",
        "stroke-width": 1,
      });
      const title = svg("title");
      title.textContent = `${line.city.name} · ${MONTHS[index]}: ${value.toFixed(1)} ${info.suffix}`;
      point.append(title);
      root.append(point);
    });
  }

  figure.append(root);

  figure.append(
    h(
      "div",
      { class: "chart-legend" },
      ...series.map((line) =>
        h(
          "span",
          {},
          h("i", { style: `--legend-color:${line.city.color}` }),
          h("span", { text: line.city.name }),
        ),
      ),
    ),
  );

  return figure;
}

function renderCharts(cities) {
  const shown = state.metric === "all" ? METRICS : [METRIC_BY_KEY[state.metric]];
  dom.charts.className = `charts${state.metric === "all" ? " multi" : ""}`;
  dom.charts.replaceChildren(
    ...shown.map((metric) => buildChart(metric, cities, { large: state.metric !== "all" })),
  );
}

function renderMetricTabs() {
  // Build once, then only restyle: rebuilding the buttons on every render would
  // drop keyboard focus and destroy the node the user just clicked.
  if (dom.metricTabs.childElementCount === 0) {
    const options = [
      { key: "all", label: "All metrics" },
      ...METRICS.map((metric) => ({ key: metric.key, label: metric.label })),
    ];
    dom.metricTabs.replaceChildren(
      ...options.map((option) =>
        h("button", {
          type: "button",
          role: "tab",
          "data-metric": option.key,
          text: option.label,
        }),
      ),
    );
  }

  for (const button of dom.metricTabs.querySelectorAll("button[data-metric]")) {
    const active = button.dataset.metric === state.metric;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

/* ------------------------------------------------------------------ */
/* render: table                                                       */
/* ------------------------------------------------------------------ */

function tableRanges(cities) {
  const monthly = {};
  const annual = {};
  for (const metric of METRICS) {
    monthly[metric.key] = rangeOf(cities.flatMap((city) => city.data.monthly.map((m) => m[metric.field])));
    annual[metric.key] = rangeOf(cities.map((city) => city.data.annual[metric.field]));
  }
  return { monthly, annual };
}

function valueCell(city, metric, value, range) {
  if (!isNumber(value)) return h("td", { class: "missing", text: "—" });
  const color = heatColor(metric.scale, normalise(value, range));
  const info = unitInfo(metric.unit);
  return h(
    "td",
    { style: color ? `background:${color}` : undefined },
    formatValue(value, metric.unit),
    h("span", { class: "sr-only", text: ` ${info.suffix}` }),
  );
}

function renderTable(cities) {
  const ranges = tableRanges(cities);
  const head = [];
  const body = [];

  if (state.metric === "all") {
    head.push(
      h(
        "tr",
        {},
        h("th", { rowspan: "2", scope: "col", text: "Month" }),
        ...cities.map((city) =>
          h(
            "th",
            {
              colspan: String(METRICS.length),
              scope: "colgroup",
              class: "city-head",
              style: `--city-color:${city.color}`,
            },
            h("span", { class: "dot" }),
            city.name,
          ),
        ),
      ),
      h(
        "tr",
        {},
        ...cities.flatMap(() => METRICS.map((metric) => h("th", { scope: "col", text: metric.short }))),
      ),
    );

    body.push(
      ...MONTHS.map((label, index) =>
        h(
          "tr",
          {},
          h("th", { scope: "row", text: label }),
          ...cities.flatMap((city) =>
            METRICS.map((metric) =>
              valueCell(city, metric, city.data.monthly[index][metric.field], ranges.monthly[metric.key]),
            ),
          ),
        ),
      ),
      h(
        "tr",
        { class: "annual" },
        h("th", { scope: "row", text: "Year" }),
        ...cities.flatMap((city) =>
          METRICS.map((metric) =>
            valueCell(city, metric, city.data.annual[metric.field], ranges.annual[metric.key]),
          ),
        ),
      ),
    );
  } else {
    const metric = METRIC_BY_KEY[state.metric];
    head.push(
      h(
        "tr",
        {},
        h("th", { scope: "col", text: "Month" }),
        ...cities.map((city) =>
          h(
            "th",
            { scope: "col", class: "city-head", style: `--city-color:${city.color}` },
            h("span", { class: "dot" }),
            city.name,
          ),
        ),
      ),
    );

    body.push(
      ...MONTHS.map((label, index) =>
        h(
          "tr",
          {},
          h("th", { scope: "row", text: label }),
          ...cities.map((city) =>
            valueCell(city, metric, city.data.monthly[index][metric.field], ranges.monthly[metric.key]),
          ),
        ),
      ),
      h(
        "tr",
        { class: "annual" },
        h("th", { scope: "row", text: metric.key === "rain" ? "Year total" : "Year" }),
        ...cities.map((city) =>
          valueCell(city, metric, city.data.annual[metric.field], ranges.annual[metric.key]),
        ),
      ),
    );
  }

  dom.table.replaceChildren(h("thead", {}, ...head), h("tbody", {}, ...body));
}

function renderFootnote(cities) {
  const periods = new Set(
    cities
      .map((city) => city.data?.coverage)
      .filter((coverage) => coverage?.startYear && coverage?.endYear)
      .map((coverage) => `${coverage.startYear}–${coverage.endYear}`),
  );
  const periodText = periods.size ? ` Averaged over ${[...periods].join(" / ")}.` : "";

  dom.footnote.replaceChildren(
    h(
      "span",
      {},
      "Humidity is the mean relative humidity across the day; rain is the average total for the month; sunshine is the average hours per day; wind is the mean daily wind speed.",
      periodText,
      " Sunshine is modelled from solar radiation, so it can read a little higher than ground-station records.",
    ),
    h("br"),
    h(
      "span",
      {},
      "Data: ",
      h("a", { href: "https://open-meteo.com/", target: "_blank", rel: "noreferrer noopener" }, "Open-Meteo"),
      " ERA5 reanalysis (CC BY 4.0).",
    ),
  );
}

/* ------------------------------------------------------------------ */
/* render + url state                                                  */
/* ------------------------------------------------------------------ */

function syncUrl() {
  const params = new URLSearchParams();
  if (state.units !== "metric") params.set("units", state.units);
  if (state.metric !== "all") params.set("metric", state.metric);
  for (const city of state.cities) {
    params.append("c", `${city.latitude.toFixed(2)},${city.longitude.toFixed(2)},${city.label}`);
  }
  const query = params.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

function render() {
  renderChips();
  renderMetricTabs();
  renderSummaries(state.cities);

  for (const button of dom.units.querySelectorAll("button[data-units]")) {
    button.classList.toggle("is-active", button.dataset.units === state.units);
  }

  const cities = readyCities();
  const hasCities = state.cities.length > 0;
  const hasData = cities.length > 0;

  dom.compare.hidden = !hasCities;
  dom.emptyState.hidden = hasCities;

  // Keep the panel visible for failed cities so the retry affordance stays reachable.
  dom.charts.closest(".panel").hidden = !hasData;
  dom.table.closest(".panel").hidden = !hasData;
  dom.footnote.hidden = !hasData;

  if (hasData) {
    renderCharts(cities);
    renderTable(cities);
    renderFootnote(cities);
  }

  if (!hasCities) {
    setStatus("");
  }

  syncUrl();
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

const EXAMPLE_CITIES = ["Lisbon", "Reykjavík", "Singapore", "Marrakesh", "Cusco"];

dom.examples.replaceChildren(
  ...EXAMPLE_CITIES.map((name) =>
    h("button", { type: "button", class: "example", text: name, onclick: () => addByName(name) }),
  ),
);

async function addByName(name) {
  setStatus(`Searching for “${name}”…`);
  try {
    const api = await backendPromise;
    const results = await api.searchCities(name);
    const first = results[0];
    if (!first) {
      setStatus(`No city found matching “${name}”.`, true);
      return;
    }
    addCity(first);
  } catch {
    setStatus("City lookup failed. Please try again.", true);
  }
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);

  if (params.get("units") === "imperial") state.units = "imperial";
  const metric = params.get("metric");
  if (metric && (metric === "all" || METRIC_BY_KEY[metric])) state.metric = metric;

  const entries = params.getAll("c").slice(0, MAX_CITIES);
  for (const entry of entries) {
    // Only the first two commas are separators; the label itself may contain commas.
    const firstComma = entry.indexOf(",");
    const secondComma = entry.indexOf(",", firstComma + 1);
    if (firstComma < 0 || secondComma < 0) continue;

    const latitude = Number(entry.slice(0, firstComma));
    const longitude = Number(entry.slice(firstComma + 1, secondComma));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    const label = entry.slice(secondComma + 1).trim();
    if (!label) continue;

    const [name, ...rest] = label.split(",");
    addCity({
      name: name.trim(),
      label,
      admin1: rest[0]?.trim() ?? null,
      country: rest.at(-1)?.trim() ?? null,
      latitude,
      longitude,
    });
  }
}

// The backend is either the local API or, in the static build, Open-Meteo directly.
const backendPromise = createBackend();

async function start() {
  await backendPromise;
  restoreFromUrl();
  render();
}

start();
