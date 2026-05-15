#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const CACHE_DIR = path.resolve(readArg("--cache-dir", "data/.catalog-cache"));
const KINDS = ["movies", "tv", "episodes"];

async function main() {
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    pages: {},
    counts: {},
    totals: {},
    pageTotals: {},
    errors: [],
  };

  for (const kind of KINDS) {
    const pages = await listPages(kind);
    manifest.pages[kind] = pages;
    manifest.counts[kind] = 0;
    manifest.totals[kind] = 0;
    manifest.pageTotals[kind] = pages.length ? Math.max(...pages) : 0;

    for (const page of pages) {
      try {
        const data = JSON.parse(await readFile(cachePath(kind, page), "utf8"));
        manifest.counts[kind] += Array.isArray(data.items) ? data.items.length : 0;
        manifest.totals[kind] = Math.max(manifest.totals[kind], Number(data.total) || 0);
        manifest.pageTotals[kind] = Math.max(manifest.pageTotals[kind], Number(data.total_pages) || 0);
      } catch (error) {
        manifest.errors.push({
          kind,
          page,
          message: error?.message || "Could not read cached page",
        });
      }
    }
  }

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  console.log(`Wrote cache manifest for ${totalPages(manifest.pages)} cached pages.`);
}

async function listPages(kind) {
  try {
    const entries = await readdir(path.join(CACHE_DIR, kind));
    return entries
      .map((entry) => entry.match(/^(\d+)\.json$/)?.[1])
      .filter(Boolean)
      .map((page) => Number(page))
      .filter((page) => Number.isInteger(page) && page > 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function cachePath(kind, page) {
  return path.join(CACHE_DIR, kind, `${page}.json`);
}

function totalPages(pages) {
  return Object.values(pages).reduce((sum, items) => sum + items.length, 0);
}

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
