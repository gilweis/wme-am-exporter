// ==UserScript==
// @name         WME Area Manager Exporter (WME SDK)
// @namespace    https://github.com/gilweis/wme-am-exporter
// @version      0.3.1
// @description  Scans a GeoJSON area in the Waze Map Editor by auto-panning the map, collects Area Manager polygons, and exports them to a JSON file.
// @author       you
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @match        https://editor-beta.waze.com/editor*
// @match        https://editor-beta.waze.com/*/editor*
// @grant        none
// @run-at       document-idle
// @noframes
// @license      MIT
// @homepageURL  https://github.com/gilweis/wme-am-exporter
// @downloadURL  https://raw.githubusercontent.com/gilweis/wme-am-exporter/master/wme-am-exporter.user.js
// @updateURL    https://raw.githubusercontent.com/gilweis/wme-am-exporter/master/wme-am-exporter.user.js
// ==/UserScript==

/*
 * WME Area Manager Exporter
 * -------------------------
 * How it works:
 *   1. You load a GeoJSON polygon (the "scan area", e.g. a country outline).
 *   2. The script computes the polygon's bounding box and tiles it into map
 *      viewports at a chosen zoom level.
 *   3. For every tile it centers the map there, waits for WME to load the map
 *      data, then reads sdk.DataModel.ManagedAreas.getAll() and merges the
 *      results (deduplicated by managed-area id).
 *   4. Area Manager polygons that intersect the scan polygon are exported to a
 *      GeoJSON FeatureCollection and downloaded as a JSON file.
 *
 * Notes / requirements:
 *   - The native "Area managers" layer must be enabled for WME to load the AM
 *     data. The script tries to enable it automatically; if that fails, turn it
 *     on manually in the Layers panel before scanning.
 *   - While scanning, all other WME Layers-panel layers are turned off (leaving
 *     only "Area managers"), which makes panning/loading faster; they are
 *     restored when the scan finishes.
 *   - Area manager data is viewport-limited, which is why the map must be
 *     panned across the whole scan area. Pick a zoom that is low enough to keep
 *     the tile count reasonable but high enough that the AM layer still loads.
 */

(function () {
    "use strict";

    const SCRIPT_ID = "wme-am-exporter";
    const SCRIPT_NAME = "AM Exporter";
    const LOG_PREFIX = `[${SCRIPT_NAME}]`;

    const AM_LAYER_NAME = "area_managers";
    const DATA_TIMEOUT_MS = 8000; // max wait for "wme-map-data-loaded" per tile
    const SETTLE_MS = 350;        // extra settle time after data loaded
    const MAX_TILES = 5000;       // safety cap

    if (window.__wmeAmExporterLoaded) {
        return;
    }
    window.__wmeAmExporterLoaded = true;

    /** @type {import("wme-sdk-typings").WmeSDK | null} */
    let sdk = null;

    const log = (...args) => console.log(LOG_PREFIX, ...args);
    const warn = (...args) => console.warn(LOG_PREFIX, ...args);
    const err = (...args) => console.error(LOG_PREFIX, ...args);

    // --- Runtime state -------------------------------------------------------
    const state = {
        scanning: false,
        cancelled: false,
        lastResult: null,
        lastResultName: "",
        amLayerWasVisible: null,
        amLayerTouched: false,
        hiddenLayers: [],
        hiddenDomIds: [],
    };

    // --- Bootstrap -----------------------------------------------------------

    function waitForSdk(timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            if (window.SDK_INITIALIZED) {
                window.SDK_INITIALIZED.then(resolve, reject);
                return;
            }
            const startedAt = Date.now();
            const timer = setInterval(() => {
                if (window.SDK_INITIALIZED) {
                    clearInterval(timer);
                    window.SDK_INITIALIZED.then(resolve, reject);
                } else if (Date.now() - startedAt > timeoutMs) {
                    clearInterval(timer);
                    reject(new Error("Timed out waiting for window.SDK_INITIALIZED"));
                }
            }, 200);
        });
    }

    function whenDomReady(callback) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", callback, { once: true });
        } else {
            callback();
        }
    }

    whenDomReady(async () => {
        try {
            await waitForSdk();
            sdk = window.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
            log(`SDK v${sdk.getSDKVersion()} ready (WME ${sdk.getWMEVersion()})`);
            await registerSidebarTab();
        } catch (e) {
            err("Initialization failed:", e);
        }
    });

    // --- Sidebar UI ----------------------------------------------------------

    async function registerSidebarTab() {
        const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
        tabLabel.innerText = "AM Export";
        tabLabel.title = SCRIPT_NAME;

        injectStyles();
        tabPane.innerHTML = `
            <div class="wme-amex-panel">
                <h3>Area Manager Exporter</h3>

                <label class="wme-amex-field">
                    <span>Scan area (.json / .geojson)</span>
                    <input type="file" id="wme-amex-file" accept=".json,.geojson,application/json">
                </label>

                <div class="wme-amex-grid">
                    <label>Zoom
                        <input type="number" id="wme-amex-zoom" min="4" max="22" value="12">
                    </label>
                    <label>Overlap&nbsp;%
                        <input type="number" id="wme-amex-overlap" min="0" max="80" value="30">
                    </label>
                </div>

                <label class="wme-amex-check">
                    <input type="checkbox" id="wme-amex-intersect" checked>
                    Only areas intersecting the polygon
                </label>
                <label class="wme-amex-check">
                    <input type="checkbox" id="wme-amex-restore-view" checked>
                    Restore map view when done
                </label>
                <label class="wme-amex-check">
                    <input type="checkbox" id="wme-amex-hide-layers" checked>
                    Hide other layers while scanning (faster)
                </label>
                <label class="wme-amex-check">
                    <input type="checkbox" id="wme-amex-restore-layer" checked>
                    Restore map layers when done
                </label>

                <div class="wme-amex-actions">
                    <button type="button" id="wme-amex-test">Test current view</button>
                    <button type="button" id="wme-amex-start" disabled>Start scan</button>
                    <button type="button" id="wme-amex-cancel" disabled>Cancel</button>
                    <button type="button" id="wme-amex-download" disabled>Download last result</button>
                </div>

                <progress id="wme-amex-progress" value="0" max="1"></progress>
                <div class="wme-amex-status" id="wme-amex-status">Idle.</div>
            </div>
        `;

        q("#wme-amex-test").addEventListener("click", testCurrentView);
        q("#wme-amex-start").addEventListener("click", runScan);
        q("#wme-amex-cancel").addEventListener("click", cancelScan);
        q("#wme-amex-download").addEventListener("click", () => {
            if (state.lastResult) {
                downloadJson(state.lastResult, state.lastResultName);
            }
        });

        // Enable/disable Start scan button based on file selection
        q("#wme-amex-file").addEventListener("change", () => {
            const hasFile = q("#wme-amex-file").files.length > 0;
            q("#wme-amex-start").disabled = !hasFile || state.scanning;
        });
    }

    const q = (selector) => document.querySelector(selector);

    function injectStyles() {
        if (document.getElementById(`${SCRIPT_ID}-styles`)) {
            return;
        }
        const style = document.createElement("style");
        style.id = `${SCRIPT_ID}-styles`;
        style.textContent = `
            .wme-amex-panel { padding: 10px; font-size: 12px; line-height: 1.45; }
            .wme-amex-panel h3 { margin: 0 0 8px; font-size: 13px; }
            .wme-amex-field { display: block; margin-bottom: 8px; }
            .wme-amex-field span { display: block; margin-bottom: 3px; opacity: 0.75; }
            .wme-amex-field input[type="file"] { width: 100%; font-size: 11px; }
            .wme-amex-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
            .wme-amex-grid label { display: flex; flex-direction: column; gap: 3px; opacity: 0.9; }
            .wme-amex-grid input { width: 100%; box-sizing: border-box; }
            .wme-amex-check { display: flex; align-items: flex-start; gap: 6px; margin: 6px 0; }
            .wme-amex-actions { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
            .wme-amex-actions button {
                padding: 6px 10px; border: 1px solid rgba(128,128,128,0.5);
                border-radius: 4px; background: transparent; color: inherit;
                cursor: pointer; font: inherit;
            }
            .wme-amex-actions button:hover:not(:disabled) { background: rgba(128,128,128,0.15); }
            .wme-amex-actions button:disabled { opacity: 0.45; cursor: default; }
            #wme-amex-progress { width: 100%; height: 8px; margin-bottom: 8px; }
            .wme-amex-status {
                padding-top: 8px; border-top: 1px solid rgba(128,128,128,0.3);
                white-space: pre-wrap; word-break: break-word;
            }
        `;
        document.head.appendChild(style);
    }

    function setStatus(message) {
        const el = q("#wme-amex-status");
        if (el) {
            el.textContent = message;
        }
    }

    function setUiRunning(running) {
        const hasFile = q("#wme-amex-file").files.length > 0;
        q("#wme-amex-start").disabled = running || !hasFile;
        q("#wme-amex-test").disabled = running;
        q("#wme-amex-cancel").disabled = !running;
        q("#wme-amex-download").disabled = !state.lastResult;
    }

    function updateProgress(done, total, count) {
        const bar = q("#wme-amex-progress");
        if (bar) {
            bar.max = Math.max(total, 1);
            bar.value = done;
        }
        const pct = total ? Math.round((done / total) * 100) : 0;
        setStatus(`Scanning tile ${done}/${total} (${pct}%) — ${count} area(s) found.`);
    }

    // --- Quick sanity check --------------------------------------------------

    function testCurrentView() {
        try {
            ensureAmLayer();
            const areas = sdk.DataModel.ManagedAreas.getAll();
            const names = [...new Set(areas.map((a) => resolveAmName(a)).filter(Boolean))];
            const blanks = areas.filter((a) => !resolveAmName(a));
            log("Managed areas at current view:", areas);
            log(`Unresolved names: ${blanks.length}`, blanks.map((a) => a.id));
            setStatus(
                `Current view: ${areas.length} area(s), ${names.length} name(s).\n` +
                (areas.length === 0
                    ? "Nothing loaded. Enable the 'Area managers' layer and/or zoom in."
                    : names.slice(0, 30).join(", ") +
                      (blanks.length ? `\n${blanks.length} area(s) with no name (see console).` : ""))
            );
        } catch (e) {
            err(e);
            setStatus(`Test failed: ${e.message}`);
        }
    }

    // --- Scan ----------------------------------------------------------------

    function cancelScan() {
        if (state.scanning) {
            state.cancelled = true;
            setStatus("Cancelling…");
        }
    }

    async function runScan() {
        if (state.scanning) {
            return;
        }

        const fileInput = q("#wme-amex-file");
        const file = fileInput && fileInput.files && fileInput.files[0];
        if (!file) {
            setStatus("Choose a scan-area file first.");
            return;
        }

        let data;
        try {
            data = JSON.parse(await file.text());
        } catch (e) {
            setStatus(`Invalid JSON: ${e.message}`);
            return;
        }

        const scanPolys = parseGeoJsonToPolygons(data);
        if (scanPolys.length === 0) {
            setStatus("No polygon found. The file must contain a GeoJSON Polygon or MultiPolygon.");
            return;
        }

        const zoom = clamp(parseInt(q("#wme-amex-zoom").value, 10) || 12, 4, 22);
        const overlap = clamp((parseInt(q("#wme-amex-overlap").value, 10) || 0) / 100, 0, 0.8);
        const onlyIntersect = q("#wme-amex-intersect").checked;
        const restoreView = q("#wme-amex-restore-view").checked;
        const restoreLayer = q("#wme-amex-restore-layer").checked;
        const hideLayers = q("#wme-amex-hide-layers").checked;

        const baseName = file.name.replace(/\.[^.]+$/, "") || "scan";
        const outputName = `${baseName}-area-managers.json`;

        // Remember the original map view / layer state.
        const originCenter = sdk.Map.getMapCenter();
        const originZoom = sdk.Map.getZoomLevel();

        state.scanning = true;
        state.cancelled = false;
        setUiRunning(true);
        q("#wme-amex-progress").value = 0;
        levelCache.clear();
        resetLegacyCaches();
        ensureAmLayer(restoreLayer);
        if (hideLayers) {
            hideOtherLayers();
        }

        try {
            const { results, tileCount, total } = await scanArea(
                scanPolys,
                { zoom, overlap },
                updateProgress
            );

            const collected = [...results.values()]; // [{ ma, level }]

            let finalAreas = collected;
            let excludedByIntersection = 0;
            if (onlyIntersect) {
                const dropped = [];
                finalAreas = collected.filter((entry) => {
                    const hit = maIntersectsScan(entry.ma, scanPolys);
                    if (!hit) {
                        dropped.push(entry);
                    }
                    return hit;
                });
                excludedByIntersection = dropped.length;
                if (excludedByIntersection > 0) {
                    log(
                        `${excludedByIntersection} managed area(s) excluded by the intersection filter:`,
                        dropped.map((entry) => ({
                            id: entry.ma.id,
                            userName: entry.userName,
                            areaName: entry.areaName,
                            userID: entry.userID,
                            bbox: bboxOfRings(entry.ma.geometry.coordinates).map((n) => +n.toFixed(5)),
                        }))
                    );
                }
            }

            const featureCollection = buildFeatureCollection(finalAreas, {
                generatedAt: new Date().toISOString(),
                script: SCRIPT_NAME,
                sdkVersion: sdk.getSDKVersion(),
                wmeVersion: sdk.getWMEVersion(),
                scanZoom: zoom,
                overlap,
                onlyIntersecting: onlyIntersect,
                loadedCount: collected.length,
                excludedByIntersection,
                scanBbox: computeBbox(scanPolys),
                tilesScanned: tileCount,
                tilesPlanned: total,
                cancelled: state.cancelled,
                areaCount: finalAreas.length,
            });

            state.lastResult = featureCollection;
            state.lastResultName = outputName;

            const breakdown =
                `Loaded ${collected.length}; ${excludedByIntersection} excluded by the ` +
                `intersection filter.`;

            if (!state.cancelled) {
                downloadJson(featureCollection, outputName);
                setStatus(
                    `Done. ${finalAreas.length} Area Manager polygon(s) exported to ${outputName}.\n` +
                    breakdown
                );
            } else {
                downloadJson(featureCollection, outputName);
                setStatus(
                    `Cancelled. Exported partial result: ${finalAreas.length} polygon(s) ` +
                    `from ${tileCount}/${total} tiles.\n` + breakdown
                );
            }
        } catch (e) {
            err("Scan failed:", e);
            setStatus(`Scan failed: ${e.message}`);
        } finally {
            if (restoreView) {
                try {
                    sdk.Map.setMapCenter({ lonLat: originCenter, zoomLevel: originZoom });
                } catch (e) {
                    warn("Could not restore map view:", e);
                }
            }
            if (restoreLayer) {
                restoreOtherLayers();
                restoreAmLayer();
            }
            state.scanning = false;
            setUiRunning(false);
        }
    }

    /**
     * Tile the scan polygon's bounding box and collect managed areas per tile.
     * Returns { results: Map<id, ManagedArea>, tileCount, total }.
     */
    async function scanArea(scanPolys, opts, onProgress) {
        const bbox = computeBbox(scanPolys); // [left, bottom, right, top]
        const results = new Map();
        let tileCount = 0;

        // Measure one viewport at the chosen zoom (at the bbox center).
        const midLon = (bbox[0] + bbox[2]) / 2;
        const midLat = (bbox[1] + bbox[3]) / 2;
        await moveTo(midLon, midLat, opts.zoom);

        const ext = sdk.Map.getMapExtent();
        const baseW = Math.max(ext[2] - ext[0], 1e-6);
        const baseH = Math.max(ext[3] - ext[1], 1e-6);
        const stepLon = baseW * (1 - opts.overlap);
        const stepLat = baseH * (1 - opts.overlap);

        const lonCols = Math.max(1, Math.ceil((bbox[2] - bbox[0]) / stepLon) + 1);
        const latRows = Math.max(1, Math.ceil((bbox[3] - bbox[1]) / stepLat) + 1);
        const total = lonCols * latRows;

        log(`Scanning ${lonCols} x ${latRows} = ${total} tiles at zoom ${opts.zoom}`);

        if (total > MAX_TILES) {
            throw new Error(
                `Scan would need ${total} tiles (limit ${MAX_TILES}). ` +
                `Use a lower zoom level or a smaller scan area.`
            );
        }

        for (let r = 0; r < latRows; r++) {
            if (state.cancelled) {
                break;
            }
            const lat = Math.max(bbox[3] - r * stepLat, bbox[1]);
            for (let c = 0; c < lonCols; c++) {
                if (state.cancelled) {
                    break;
                }
                const lon = Math.min(bbox[0] + c * stepLon, bbox[2]);
                await moveTo(lon, lat, opts.zoom);
                collectAreas(results);
                tileCount++;
                onProgress(tileCount, total, results.size);
            }
        }

        return { results, tileCount, total };
    }

    /** Center the map and wait for WME to load the data for that viewport. */
    async function moveTo(lon, lat, zoom) {
        const dataLoaded = sdk.Events
            .once({ eventName: "wme-map-data-loaded" })
            .catch(() => null);
        try {
            sdk.Map.setMapCenter({ lonLat: { lon, lat }, zoomLevel: zoom });
        } catch (e) {
            warn("setMapCenter failed:", e);
        }
        await Promise.race([dataLoaded, delay(DATA_TIMEOUT_MS)]);
        await delay(SETTLE_MS);
    }

    function collectAreas(target) {
        let list;
        try {
            list = sdk.DataModel.ManagedAreas.getAll();
        } catch (e) {
            return;
        }
        for (const ma of list) {
            if (!ma || ma.id == null) {
                continue;
            }
            // Resolve the manager name + area label from the SDK object and, when
            // needed, WME's legacy model (see resolveAmInfo).
            const info = resolveAmInfo(ma);
            // Resolve the level now, while this viewport's user data is loaded.
            // WME's user store is viewport-scoped, so resolving after the whole
            // scan returns null for areas collected on earlier tiles.
            const level = getUserLevel(info.userName);
            const existing = target.get(ma.id);
            if (!existing) {
                target.set(ma.id, { ma, level, ...info });
            } else {
                if (existing.level == null && level != null) {
                    existing.level = level;
                }
                if (!existing.userName && info.userName) {
                    existing.userName = info.userName;
                }
                if (!existing.areaName && info.areaName) {
                    existing.areaName = info.areaName;
                }
                if (existing.userID == null && info.userID != null) {
                    existing.userID = info.userID;
                }
            }
        }
    }

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // --- Area Manager layer handling -----------------------------------------

    function ensureAmLayer(trackForRestore) {
        let visible = null;
        try {
            visible = sdk.Map.isLayerVisible({ layerName: AM_LAYER_NAME });
        } catch (e) {
            visible = null;
        }

        if (trackForRestore) {
            state.amLayerWasVisible = visible;
        }

        if (visible === true) {
            return;
        }

        // Try the SDK first.
        let enabled = false;
        try {
            sdk.Map.setLayerVisibility({ layerName: AM_LAYER_NAME, visibility: true });
            enabled = true;
        } catch (e) {
            warn("Could not enable AM layer via SDK:", e.message);
        }

        // Fallback: click the "Area Managers" checkbox in the Layers panel.
        if (!enabled) {
            enabled = enableAmLayerViaDom();
        }

        if (enabled) {
            state.amLayerTouched = true;
            // Make sure opacity is not left at 0 by another script (e.g. URO+).
            try {
                sdk.Map.setLayerOpacity({ layerName: AM_LAYER_NAME, opacity: 1 });
            } catch (e) {
                /* ignore */
            }
        } else {
            warn("Enable the 'Area managers' layer manually in the Layers panel.");
        }
    }

    function restoreAmLayer() {
        if (!state.amLayerTouched) {
            return;
        }
        if (state.amLayerWasVisible === false) {
            try {
                sdk.Map.setLayerVisibility({ layerName: AM_LAYER_NAME, visibility: false });
            } catch (e) {
                /* ignore */
            }
        }
    }

    // The layers WME exposes through its own Layer Switcher (SDK.LayerSwitcher).
    // These are the stable names from SDK.WmeLayerName. "Area managers" is NOT in
    // this set, so hiding all of them never turns off the layer we need.
    const WME_SWITCHER_LAYER_NAMES = [
        "cities", "closures", "editSuggestions", "gpsPoints", "houseNumbers",
        "junctionBoxes", "mapComments", "mapProblems", "paths", "permanentHazards",
        "places", "roads", "satelliteImagery", "updateRequests",
    ];

    // Layers-panel labels mapped to the SDK names above, so the DOM fallback does
    // not toggle a layer a second time after the SDK already handled it.
    const LAYER_LABEL_TO_NAME = {
        "cities": "cities",
        "closures": "closures",
        "edit suggestions": "editSuggestions",
        "gps points": "gpsPoints",
        "house numbers": "houseNumbers",
        "junction boxes": "junctionBoxes",
        "map comments": "mapComments",
        "map problems": "mapProblems",
        "paths": "paths",
        "permanent hazards": "permanentHazards",
        "places": "places",
        "roads": "roads",
        "satellite imagery": "satelliteImagery",
        "update requests": "updateRequests",
    };

    function hasLayerSwitcherApi() {
        return !!(sdk && sdk.LayerSwitcher &&
            typeof sdk.LayerSwitcher.setWMELayerVisibility === "function" &&
            typeof sdk.LayerSwitcher.getWMELayerVisibility === "function");
    }

    function getLayerSwitcherBoxes() {
        const region = document.getElementById("layer-switcher-region");
        if (!region) {
            return [];
        }
        // Only real layer checkboxes (not the group collapse switches).
        return Array.from(region.querySelectorAll("wz-checkbox, input[type=checkbox]"));
    }

    function domBoxLabel(box) {
        return (box.textContent || box.getAttribute("aria-label") || box.title || "").trim();
    }

    function domBoxChecked(box) {
        if (typeof box.checked === "boolean") {
            return box.checked;
        }
        const input = box.shadowRoot &&
            box.shadowRoot.querySelector('input[type="checkbox"], input[type="radio"]');
        return !!(input && input.checked);
    }

    function isAreaManagerLabel(label) {
        return /area\s*manager/i.test(String(label));
    }

    // Hide every WME layer except "Area managers" so the map has far less to
    // load/render while panning. Uses WME's own Layer Switcher API (which also
    // updates the sidebar checkbox); falls back to clicking the panel's
    // checkboxes for anything the SDK does not expose (e.g. "Additional imagery").
    function hideOtherLayers() {
        state.hiddenLayers = [];
        state.hiddenDomIds = [];

        if (hasLayerSwitcherApi()) {
            for (const layerName of WME_SWITCHER_LAYER_NAMES) {
                let visible = null;
                try {
                    visible = sdk.LayerSwitcher.getWMELayerVisibility({ layerName });
                } catch (e) {
                    continue; // layer not known to this SDK version
                }
                if (visible !== true) {
                    continue;
                }
                try {
                    sdk.LayerSwitcher.setWMELayerVisibility({ layerName, isVisible: false });
                    state.hiddenLayers.push(layerName);
                } catch (e) {
                    /* ignore */
                }
            }
        } else {
            warn("SDK LayerSwitcher API unavailable; using the Layers panel checkboxes instead.");
        }

        // Fallback for panel layers the SDK does not expose (e.g. "Additional
        // imagery"). Never touches "Area managers", and skips layers already
        // handled above so nothing gets toggled twice.
        for (const box of getLayerSwitcherBoxes()) {
            const label = domBoxLabel(box);
            if (!label || isAreaManagerLabel(label)) {
                continue;
            }
            const mapped = LAYER_LABEL_TO_NAME[label.toLowerCase()];
            if (mapped && state.hiddenLayers.includes(mapped)) {
                continue; // already hidden through the SDK
            }
            if (domBoxChecked(box) !== true) {
                continue;
            }
            try {
                box.click();
                if (box.id) {
                    state.hiddenDomIds.push(box.id);
                }
            } catch (e) {
                /* ignore */
            }
        }

        const total = state.hiddenLayers.length + state.hiddenDomIds.length;
        if (total > 0) {
            log(
                `Hid ${total} layer(s) for the scan ` +
                `(SDK: ${state.hiddenLayers.length}, panel: ${state.hiddenDomIds.length}).`
            );
        } else {
            warn("No other layers were hidden (Layers panel / LayerSwitcher API not found).");
        }
    }

    function restoreOtherLayers() {
        if (hasLayerSwitcherApi()) {
            for (const layerName of state.hiddenLayers) {
                try {
                    sdk.LayerSwitcher.setWMELayerVisibility({ layerName, isVisible: true });
                } catch (e) {
                    /* ignore */
                }
            }
        }
        state.hiddenLayers = [];
        for (const id of state.hiddenDomIds) {
            const box = document.getElementById(id);
            if (box && domBoxChecked(box) !== true) {
                try {
                    box.click();
                } catch (e) {
                    /* ignore */
                }
            }
        }
        state.hiddenDomIds = [];
    }

    function enableAmLayerViaDom() {
        // Modern WME: layer checkboxes are <wz-checkbox> web components inside the
        // Layers panel (their real <input> lives in the element's shadow DOM).
        for (const box of getLayerSwitcherBoxes()) {
            const label = domBoxLabel(box);
            if (label && isAreaManagerLabel(label)) {
                if (domBoxChecked(box) !== true) {
                    box.click();
                }
                return true;
            }
        }
        // Legacy WME: plain checkboxes.
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        for (const cb of checkboxes) {
            let text = "";
            const label = cb.closest("label") || document.querySelector(`label[for="${cb.id}"]`);
            if (label) {
                text = label.textContent || "";
            }
            if (!text) {
                text = cb.getAttribute("aria-label") || cb.title || "";
            }
            if (isAreaManagerLabel(text)) {
                if (!cb.checked) {
                    cb.click();
                }
                return true;
            }
        }
        return false;
    }

    // --- Geometry helpers ----------------------------------------------------

    /** Accepts GeoJSON (FeatureCollection/Feature/geometry) and returns an array of polygons (each = array of rings). */
    function parseGeoJsonToPolygons(data) {
        const polys = [];
        const walk = (geom) => {
            if (!geom || !geom.type) {
                return;
            }
            if (geom.type === "Polygon") {
                polys.push(geom.coordinates);
            } else if (geom.type === "MultiPolygon") {
                for (const p of geom.coordinates) {
                    polys.push(p);
                }
            } else if (geom.type === "GeometryCollection" && Array.isArray(geom.geometries)) {
                for (const g of geom.geometries) {
                    walk(g);
                }
            }
        };

        if (data.type === "FeatureCollection" && Array.isArray(data.features)) {
            for (const f of data.features) {
                walk(f && f.geometry);
            }
        } else if (data.type === "Feature") {
            walk(data.geometry);
        } else if (data.type) {
            walk(data);
        }
        return polys;
    }

    function computeBbox(polys) {
        let left = Infinity;
        let bottom = Infinity;
        let right = -Infinity;
        let top = -Infinity;
        for (const poly of polys) {
            for (const ring of poly) {
                for (const pt of ring) {
                    if (pt[0] < left) left = pt[0];
                    if (pt[0] > right) right = pt[0];
                    if (pt[1] < bottom) bottom = pt[1];
                    if (pt[1] > top) top = pt[1];
                }
            }
        }
        return [left, bottom, right, top];
    }

    function bboxOfRings(rings) {
        let left = Infinity;
        let bottom = Infinity;
        let right = -Infinity;
        let top = -Infinity;
        for (const ring of rings) {
            for (const pt of ring) {
                if (pt[0] < left) left = pt[0];
                if (pt[0] > right) right = pt[0];
                if (pt[1] < bottom) bottom = pt[1];
                if (pt[1] > top) top = pt[1];
            }
        }
        return [left, bottom, right, top];
    }

    function bboxOverlap(a, b) {
        return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
    }

    function pointInRing(pt, ring) {
        const x = pt[0];
        const y = pt[1];
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0];
            const yi = ring[i][1];
            const xj = ring[j][0];
            const yj = ring[j][1];
            const intersects = (yi > y) !== (yj > y) &&
                x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
            if (intersects) {
                inside = !inside;
            }
        }
        return inside;
    }

    function pointInPolygon(pt, rings) {
        if (rings.length === 0 || !pointInRing(pt, rings[0])) {
            return false;
        }
        for (let i = 1; i < rings.length; i++) {
            if (pointInRing(pt, rings[i])) {
                return false; // inside a hole
            }
        }
        return true;
    }

    function cross(a, b, c) {
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    }

    function onSegment(a, b, c) {
        return Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) &&
            Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]) &&
            Math.abs(cross(a, b, c)) < 1e-12;
    }

    function segmentsIntersect(p1, p2, p3, p4) {
        const d1 = cross(p3, p4, p1);
        const d2 = cross(p3, p4, p2);
        const d3 = cross(p1, p2, p3);
        const d4 = cross(p1, p2, p4);
        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
            ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
            return true;
        }
        if (Math.abs(d1) < 1e-12 && onSegment(p3, p4, p1)) return true;
        if (Math.abs(d2) < 1e-12 && onSegment(p3, p4, p2)) return true;
        if (Math.abs(d3) < 1e-12 && onSegment(p1, p2, p3)) return true;
        if (Math.abs(d4) < 1e-12 && onSegment(p1, p2, p4)) return true;
        return false;
    }

    function ringsIntersect(ra, rb) {
        for (let i = 0; i < ra.length; i++) {
            const a1 = ra[i];
            const a2 = ra[(i + 1) % ra.length];
            for (let j = 0; j < rb.length; j++) {
                const b1 = rb[j];
                const b2 = rb[(j + 1) % rb.length];
                if (segmentsIntersect(a1, a2, b1, b2)) {
                    return true;
                }
            }
        }
        return false;
    }

    function polygonsIntersect(ringsA, ringsB) {
        if (ringsA.length === 0 || ringsB.length === 0) {
            return false;
        }
        if (!bboxOverlap(bboxOfRings(ringsA), bboxOfRings(ringsB))) {
            return false;
        }
        for (const ra of ringsA) {
            for (const rb of ringsB) {
                if (ringsIntersect(ra, rb)) {
                    return true;
                }
            }
        }
        if (pointInPolygon(ringsA[0][0], ringsB)) return true;
        if (pointInPolygon(ringsB[0][0], ringsA)) return true;
        return false;
    }

    function maIntersectsScan(ma, scanPolys) {
        const maRings = ma.geometry && ma.geometry.coordinates;
        if (!maRings) {
            return false;
        }
        for (const sp of scanPolys) {
            if (polygonsIntersect(maRings, sp)) {
                return true;
            }
        }
        return false;
    }

    // --- Output --------------------------------------------------------------

    const levelCache = new Map();
    function getUserLevel(userName) {
        if (levelCache.has(userName)) {
            return levelCache.get(userName);
        }
        let level = null;
        try {
            const user = sdk.DataModel.Users.getByUserName({ userName });
            if (user && typeof user.rank === "number") {
                level = user.rank + 1;
            }
        } catch (e) {
            /* ignore */
        }
        // Only cache successful lookups: a miss now may succeed later once WME
        // has loaded that user for a different viewport.
        if (level != null) {
            levelCache.set(userName, level);
        }
        return level;
    }

    function getPageWindow() {
        return typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    }

    // --- Legacy W.model access ----------------------------------------------
    // The SDK's ManagedArea only exposes { id, userName, geometry }, and userName
    // is sometimes empty because WME resolves it lazily from a viewport-scoped
    // user store. W.model.managedAreas keeps the raw attributes:
    //   { id, userID, name, createdOn, ..., geoJSONGeometry }
    // where `name` is the area label and `userID` identifies the manager. We build
    // id -> { name, userID } from there and resolve userID -> userName from the
    // legacy users store, so the manager name is available even when the SDK's is
    // not. Caches are reset once per scan.

    let legacyAreas = null;
    let legacyUsers = null;

    function resetLegacyCaches() {
        legacyAreas = null;
        legacyUsers = null;
    }

    function legacyCollection(name) {
        const W = getPageWindow().W;
        return W && W.model ? W.model[name] : null;
    }

    // Resolve one object by id using the collection's own API when available,
    // trying id variants ("1632ma" vs "1632") so SDK and legacy ids both match,
    // and always reading freshly loaded data (no stale cache).
    function legacyObjById(coll, id) {
        if (!coll || id == null) {
            return null;
        }
        for (const v of idVariants(id)) {
            try {
                if (typeof coll.getObjectById === "function") {
                    const o = coll.getObjectById(v);
                    if (o) {
                        return o;
                    }
                }
            } catch (e) {
                /* ignore */
            }
            try {
                if (coll.objects && coll.objects[v]) {
                    return coll.objects[v];
                }
            } catch (e) {
                /* ignore */
            }
        }
        return null;
    }

    function collectionToArray(coll) {
        if (!coll) {
            return [];
        }
        try {
            if (typeof coll.getObjectArray === "function") {
                return coll.getObjectArray() || [];
            }
            if (coll.objects) {
                return Object.values(coll.objects);
            }
        } catch (e) {
            /* ignore */
        }
        return [];
    }

    function attrsOf(obj) {
        return (obj && obj.attributes) || obj || {};
    }

    function addIdVariants(map, rawId, value) {
        const s = String(rawId);
        map.set(s, value);
        const digits = s.replace(/\D/g, "");
        if (digits && digits !== s) {
            map.set(digits, value);
        }
        if (s.endsWith("ma")) {
            map.set(s.slice(0, -2), value);
        }
    }

    function idVariants(id) {
        const s = String(id);
        const out = [s];
        const digits = s.replace(/\D/g, "");
        if (digits && digits !== s) {
            out.push(digits);
        }
        if (s.endsWith("ma")) {
            out.push(s.slice(0, -2));
        } else {
            out.push(s + "ma");
        }
        return out;
    }

    function mapLookup(map, id) {
        if (id == null) {
            return undefined;
        }
        for (const v of idVariants(id)) {
            const hit = map.get(v);
            if (hit !== undefined) {
                return hit;
            }
        }
        return undefined;
    }

    function getLegacyAreas() {
        if (legacyAreas && legacyAreas.size > 0) {
            return legacyAreas;
        }
        const map = new Map();
        const W = getPageWindow().W;
        const coll = W && W.model ? W.model.managedAreas : null;
        for (const o of collectionToArray(coll)) {
            const a = attrsOf(o);
            const id = a.id != null ? a.id : o && o.id;
            if (id == null) {
                continue;
            }
            addIdVariants(map, id, { name: a.name, userID: a.userID });
        }
        legacyAreas = map;
        return map;
    }

    function getLegacyUsers() {
        if (legacyUsers && legacyUsers.size > 0) {
            return legacyUsers;
        }
        const map = new Map();
        const W = getPageWindow().W;
        const coll = W && W.model ? W.model.users : null;
        for (const u of collectionToArray(coll)) {
            const a = attrsOf(u);
            const uname = a.userName || a.username;
            const id = a.id != null ? a.id : u && u.id;
            if (id != null && typeof uname === "string" && uname.trim() !== "") {
                addIdVariants(map, id, uname);
            }
        }
        legacyUsers = map;
        return map;
    }

    function legacyAreaFor(ma) {
        if (!ma || ma.id == null) {
            return undefined;
        }
        // Prefer the collection's O(1) lookup so we always see freshly loaded data.
        const o = legacyObjById(legacyCollection("managedAreas"), ma.id);
        if (o) {
            const a = attrsOf(o);
            return { name: a.name, userID: a.userID };
        }
        // Fallback: a map built from the whole collection.
        return mapLookup(getLegacyAreas(), ma.id);
    }

    function firstNonEmpty(...vals) {
        for (const v of vals) {
            if (typeof v === "string" && v.trim() !== "") {
                return v;
            }
        }
        return "";
    }

    /**
     * Resolve everything we can about a managed area:
     *   userName - the manager's username (what WME labels the polygon with)
     *   areaName - the managed area's own name/label (e.g. the towns it covers)
     *   userID   - the manager's numeric WME id
     */
    function resolveAmInfo(ma) {
        const attrs = attrsOf(ma);
        const legacy = legacyAreaFor(ma) || {};
        const userID = attrs.userID != null ? attrs.userID : legacy.userID;
        const userName = firstNonEmpty(legacyUserNameFor(userID), ma && ma.userName, attrs.userName);
        const areaName = firstNonEmpty(legacy.name, ma && ma.name, attrs.name, ma && ma.areaName, attrs.areaName);
        return {
            userName: userName || "",
            areaName: areaName || "",
            userID: userID != null ? userID : null,
        };
    }

    function legacyUserNameFor(userID) {
        if (userID == null) {
            return undefined;
        }
        const o = legacyObjById(legacyCollection("users"), userID);
        if (o) {
            const a = attrsOf(o);
            const n = a.userName || a.username;
            if (typeof n === "string" && n.trim() !== "") {
                return n;
            }
        }
        return mapLookup(getLegacyUsers(), userID);
    }

    // Manager name first, then the area label. Used for the level lookup and the
    // "Test current view" summary.
    function resolveAmName(ma) {
        const info = resolveAmInfo(ma);
        return info.userName || info.areaName || "";
    }

    function buildFeatureCollection(entries, metadata) {
        return {
            type: "FeatureCollection",
            metadata,
            features: entries.map((entry) => {
                const ma = entry.ma;
                const info = resolveAmInfo(ma);
                const userName = entry.userName || info.userName || "";
                const areaName = entry.areaName || info.areaName || "";
                const userID = entry.userID != null ? entry.userID : info.userID;
                return {
                    type: "Feature",
                    id: ma.id,
                    properties: {
                        id: ma.id,
                        name: userName || areaName,
                        userName,
                        areaName,
                        userID,
                        userLevel: entry.level != null ? entry.level : getUserLevel(userName),
                    },
                    geometry: ma.geometry,
                };
            }),
        };
    }

    function downloadJson(obj, filename) {
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    // --- Misc ----------------------------------------------------------------

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }
})();
