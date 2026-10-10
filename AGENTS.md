# AGENTS.md

Userscripts for the **Waze Map Editor (WME)**, built on the official WME SDK
(`window.getWmeSdk`). SDK docs: https://www.waze.com/editor/sdk/index.html

## What this repo is

- `wme-am-exporter.user.js` is the entire product: a single self-contained
  userscript. There is **no build, bundler, test, lint, or dependency setup** and
  no `package.json`. Edit the `.user.js` file directly.
- Nothing is runnable locally. The only real verification is loading the script
  in a browser (Tampermonkey) on https://www.waze.com/editor, opening the
  **AM Export** sidebar tab, and using **Test current view** plus the console
  logs (all prefixed `[AM Exporter]`).

## Versioning / release

- A release bumps `@version` in the userscript header **and** adds a
  `CHANGELOG.md` entry (Keep a Changelog + SemVer). These are the only two
  places carrying a version — keep them matched. Default branch is `master`.

## Conventions that are easy to break

- **`@grant none`** keeps the script in page context so `window` is the page's
  real window. If you add any other `@grant`, add `@grant unsafeWindow` too and
  use `unsafeWindow` (see `getPageWindow()`).
- **Double-injection guard** (`window.__wmeAmExporterLoaded`) is required because
  WME is an SPA and Tampermonkey re-injects on navigation. Keep this pattern.
- `SCRIPT_ID` namespaces the sidebar tab, map layers, and events. Change it when
  forking.
- The script is **read-only** — it never edits the map.

## Architecture notes (not obvious from filenames)

- AM data is **viewport-scoped**: `sdk.DataModel.ManagedAreas.getAll()` only
  returns what WME loaded for the current viewport, so the scan tiles the
  polygon's bounding box and pans the map (`scanArea` / `moveTo`), waiting for
  the `wme-map-data-loaded` event per tile. Constants `DATA_TIMEOUT_MS`,
  `SETTLE_MS`, `MAX_TILES` tune this.
- The SDK `ManagedArea` exposes only `{ id, userName, geometry }`, and
  `userName` is frequently empty. The script reads raw attributes from the
  legacy `W.model.managedAreas` / `W.model.users` (via `getPageWindow().W`) to
  resolve `userID` / `areaName` and the manager name. Caches reset once per scan;
  preserve the id-variant handling (`"1632"` vs `"1632ma"`).
- `userLevel` is resolved **per tile on purpose** (the user store is
  viewport-scoped); missing users legitimately stay `null`.

## Keep docs in sync

- `README.md` is the user-facing doc. Its **Options** and **Output format**
  tables and the "Important notes & limitations" list must match the actual UI
  and output — update them with any behavior change.
- `examples/israel.geojson` (full outline) and `examples/israel-bbox.geojson`
  (fast smoke test) are the standard test inputs.

## Gotcha

- README says "Conventions (both scripts)" but the repo currently ships a single
  script. Don't assume hidden scripts exist.
