# @weflow-leaif/weknora-connector

> WeKnora knowledge-base connector settings UI for the Weflow Console.

This package is the `entry` module declared in
`solution.manifest.json` (`apps/settings/settings.js`). The Weflow Console
loads it through the platform `ExtensionHost` to render the configuration
page for connecting the platform to the WeKnora knowledge-base service.

## What this package provides

- A mountable settings UI (`mount(container)`) for the WeKnora connector
  extension: base URL, API key, knowledge-base whitelist, request timeout.
- A health-check probe against the platform's `/api/v1/system/status`
  endpoint to surface WeKnora reachability.

## What this package does NOT provide

- The WeKnora knowledge-base frontend (hosted at `kb.leaif.com`).
- The Weflow Console itself.
- Any platform / Core code.

## Usage

The package is consumed by the Weflow Console's ExtensionHost; it is not
intended to be used directly outside the platform. The Console resolves
the `entry` field of the `weknora-connector-settings` consoleExtension
in the solution manifest to `apps/settings/settings.js` inside this
package and renders the form via `mount(container)`.

## License

UNLICENSED — internal Weflow Solutions package.
