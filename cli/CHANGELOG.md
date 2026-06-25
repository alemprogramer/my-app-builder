# Changelog

All notable changes to the `mybuilder-cli` package will be documented in this file.

## [1.0.6] - 2026-06-25

### Added
- **Build Type Selection:** Users can now choose between building a `release` or `debug` Android APK.
- **Interactive Prompts:** Added a step to prompt users to choose the build type when executing `mybuild build android` without options.
- **Command Option:** Added `-t, --type <type>` (e.g. `mybuild build android --type debug`) to directly select the build mode and skip the interactive menu.
- **Status Metadata:** `mybuild status` and `mybuild status <build-id>` now display the active `Build Type` in the list and details view.

### Changed
- Refactored project upload payloads to submit the `buildType` parameter to the API server.
