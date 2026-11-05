#!/usr/bin/env node
/**
 * Assembles a static build in dist/ for GitHub Pages.
 *
 * The app normally talks to the Express API. For static hosting the same
 * aggregation code runs in the browser, so the pure modules are copied next to
 * the frontend and the page sets a flag telling data.js to call Open-Meteo directly.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist");

/** Modules the browser can run as-is; kept in sync with what data.js imports. */
const SHARED_MODULES = ["normals.js", "openmeteo.js", "geocode.js"];

const STATIC_FLAG = "  <script>globalThis.__CLIMATE_STATIC__ = true;</script>\n";

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await cp(path.join(root, "public"), out, { recursive: true });

for (const module of SHARED_MODULES) {
  await cp(path.join(root, "src", module), path.join(out, module));
}

const indexPath = path.join(out, "index.html");
let html = await readFile(indexPath, "utf8");

if (!html.includes("</head>")) throw new Error("index.html has no </head> to inject into");
html = html.replace("</head>", `${STATIC_FLAG}</head>`);
await writeFile(indexPath, html);

// GitHub Pages runs Jekyll unless told otherwise, which would skip anything
// starting with an underscore.
await writeFile(path.join(out, ".nojekyll"), "");

console.log(`Static build written to ${path.relative(root, out)}/`);
