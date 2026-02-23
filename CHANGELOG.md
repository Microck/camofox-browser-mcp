# Changelog

All notable changes to this project are documented in this file.

## [0.1.2] - 2026-02-23

### Fixed

- Resolved `The AbortSignal.aborted getter can only be used on instances of AbortSignal`
  failures during MCP tool calls by avoiding propagation of raw SDK call-context
  objects into request logging context.

### Added

- Regression coverage for tool/resource handler context safety when SDK/call context
  contains problematic enumerable properties.
- TypeScript declaration output in `dist/` to match published `types` entry.

## [0.1.3] - 2026-02-23

### Changed

- README npm badges now link to the npm package page and show version/downloads.

## [0.1.1] - 2026-02-23

### Added

- Full camofox-browser parity tools for wait, keypress, history navigation, refresh,
  links extraction, screenshot capture, tab stats, tab-group/session cleanup, stop,
  and YouTube transcript workflows.
- Expanded README with endpoint parity mapping, configuration details, and operational guidance.

### Changed

- Updated install docs and server metadata to include `CAMOFOX_ADMIN_KEY` and
  complete camofox runtime environment variable coverage.

## [0.1.0] - 2026-02-23

### Added

- Initial public release of `camofox-browser-mcp`.
- Tooling for tab lifecycle, page interaction via snapshot refs, and cookie import.
- Bun-based build/test workflow and stdio MCP runtime.
