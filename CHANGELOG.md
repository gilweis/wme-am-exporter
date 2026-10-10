# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-10

### Added
- Initial release of WME Area Manager Exporter
- Scan GeoJSON polygon areas by auto-panning the map
- Export Area Manager polygons to GeoJSON FeatureCollection
- Resolve manager usernames from WME's legacy model
- UI options: zoom, overlap %, intersection filter, restore view/layers
- Hide other layers while scanning for performance
- Test current view button for quick validation
- Download last result button

### Known Limitations
- "Tasks" layer may remain visible during scan (not caught by basic layer hiding)