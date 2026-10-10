# WME Area Manager Exporter

A userscript for the **Waze Map Editor (WME)**, built on the official
**WME SDK** (`window.getWmeSdk`), that exports Area Manager (AM) territory polygons to a GeoJSON file.

- SDK docs: https://www.waze.com/editor/sdk/index.html

| File | Purpose |
| --- | --- |
| `wme-am-exporter.user.js` | Scan an area and export all **Area Manager polygons** to JSON |
| `examples/israel.geojson` | Israel country outline (for the exporter) |
| `examples/israel-bbox.geojson` | Tiny Israel bounding box (fastest smoke test) |

---

## Why it pans the map

WME only loads data for the **currently visible viewport**, so the Area Manager
data set is not all present at once. The script reads
`sdk.DataModel.ManagedAreas.getAll()` for each map position, so it has to move
the map across the whole scan area and merge what it finds.

### How to use

1. Install the script (Tampermonkey) and open https://www.waze.com/editor.
2. Open the left sidebar's **Scripts** section and select the **AM Export** tab.
3. Choose a **scan area** file — GeoJSON containing a `Polygon` or
   `MultiPolygon` (a `Feature`, `FeatureCollection`, or bare geometry all work).
   Use `examples/israel.geojson` (or the tiny `examples/israel-bbox.geojson` for a
   quick smoke test) to try it.
4. Set the scan **Zoom** (default `12`) and **Overlap %** (default `30`).
5. Click **Test current view** first: it reports how many AM areas are currently
   loaded. If it says `0`, enable the **Area managers** layer in the Layers
   panel (and/or raise the zoom) until it finds some.
6. Click **Start scan**. The map will jump from tile to tile; the progress bar
   shows how many tiles are left.
7. When finished, a file named `<your-file>-area-managers.json` is downloaded.

### Options

| Option | Meaning |
| --- | --- |
| **Zoom** | Map zoom used while scanning. Lower = fewer, bigger tiles (faster, but the AM layer may not load). Higher = more tiles (slower, more reliable data). |
| **Overlap %** | How much adjacent tiles overlap. More overlap = no gaps, but more tiles. 20–40% is usually fine. |
| **Only areas intersecting the polygon** | Keep only AM polygons that actually intersect your scan polygon (default on). Turn off to keep everything found inside the bounding box. |
| **Restore map view when done** | Return the map to where it was before scanning. |
| **Hide other layers while scanning (faster)** | Turn off every WME Layers-panel layer — roads, places, cities, map problems, update requests, map comments, closures, GPS points, etc. (including satellite imagery) — leaving only **Area managers**. Uses WME's `LayerSwitcher` API, which also updates the sidebar checkboxes. On by default. |
| **Restore map layers when done** | Turn the hidden layers back on (and restore the AM layer's original state) after the scan. On by default. |

### Output format

A GeoJSON `FeatureCollection`. Each feature is one AM polygon:

```json
{
  "type": "Feature",
  "id": "1625ma",
  "properties": {
    "id": "1625ma",
    "name": "area manager nick name",
    "userName": "area manager nick name",
    "areaName": "…managed area label…",
    "userID": 123456789,
    "userLevel": 4
  },
  "geometry": { "type": "Polygon", "coordinates": [ [ [lon, lat], ... ] ] }
}
```

- **`userName`** — the manager's username (what WME labels the AM polygon with).
- **`name`** — same as `userName`, falling back to `areaName` if the username
  can't be resolved (kept for convenience).
- **`areaName`** — the managed area's own label (often a list of towns, e.g.
  `"Tel Aviv-Yafo"`).
- **`userID`** — the manager's numeric WME user id.

WME's SDK returns only `{ id, userName, geometry }` for each managed area, and
`userName` is sometimes empty even when the map shows a name. WME's raw model
(`W.model.managedAreas[...].attributes`) actually stores:

```
id, userID, name, createdOn, startTime, endTime, permissions, rank, geoJSONGeometry, geometry
```

so the script reads `userID` from there and resolves the username from WME's user
store (`W.model.users`). `name`/`areaName` come from the same raw attributes.

A top-level `metadata` object records the scan parameters (zoom, overlap, bbox,
tile counts, WME/SDK version, timestamp).

### Important notes & limitations

- **The `Area managers` layer must be enabled** for WME to load the data. The
  script tries to turn it on automatically (via `sdk.Map.setLayerVisibility`,
  with a DOM fallback); if that fails, enable it manually in the Layers panel.
- **Zoom vs. data loading:** if a scan returns 0 areas, the zoom was probably too
  low for the AM layer to load. Increase the zoom and try again. Use
  **Test current view** to find a working zoom quickly.
- **`Test current view`** is the fastest way to validate your setup.
- **Bounding-box caveat:** scan areas are processed by their bounding box, so if
  your polygon is L-shaped or has gaps, AM areas in the "empty" parts of the box
  are still scanned. The intersection filter removes AM areas that do not touch
  the polygon itself, but a full outline is always better than a bounding box.
- **Fewer exported than loaded:** with **Only areas intersecting the polygon** on,
  the exported count can be lower than the number of records the scan loaded. The
  difference is AM areas that don't overlap your outline (e.g. West Bank / Gaza /
  neighbouring countries inside the scan's bounding box). The result status now
  shows the breakdown and the excluded areas are logged to the console with their
  id, manager name and bounding box. Turn the option off to export every loaded
  record.
- **Names may need a fallback:** WME's SDK returns an empty
  `ManagedArea.userName` for some areas even though WME shows a name on the map
  (e.g. `id: "1625ma"` shows `area manager nick name` in WME but `userName: ""` via the SDK).
  The script reads the raw `userID` from WME's model and resolves the username
  from WME's user store, so `userName` is populated whenever WME knows the
  manager. The area's own label is exported as `areaName`.
- **`userLevel` may be `null`:** WME resolves an editor's rank only for users it
  has actually loaded (its user store is viewport-scoped). The script resolves
  each manager's level while their tile is on screen to maximize the hit rate,
  but managers whose user record WME never loads stay `null`.
- SDC/AI note: the SDK exposes AM areas read-only; the script never edits the map.

### Bundled example data

`examples/israel.geojson` is a merged scan outline containing:

- **Israel** — ADM0 boundary from
  [geoBoundaries](https://www.geoboundaries.org/) (release `gbOpen`, simplified
  geometry). Source: OpenStreetMap contributors, licensed under the
  [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
- **West Bank** — ADM1 boundary from the same geoBoundaries release. Source:
  geoBoundaries / Open Data Watch, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Gaza is deliberately **not** included (it is a separate geoBoundaries unit).
The file is a convenience for scanning Israel + West Bank together; replace it
with any GeoJSON polygon(s) you like.

---

## Conventions

- **`@grant none`** keeps the script in the page context so `window` is the
  page's real window. If you add any other `@grant` (e.g. `GM_setClipboard`),
  you must also add `@grant unsafeWindow` and use `unsafeWindow`. (See the SDK
  "Troubleshooting" section.)
- **Unique `SCRIPT_ID`** namespaces your sidebar tab, shortcuts, map layers and
  events. Change it when you fork.
- **Double-injection guard** (`window.__wme...Loaded`) because WME is a
  single-page app and Tampermonkey can re-inject on navigation.
