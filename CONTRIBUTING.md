# Contributing

Use Node.js 22+, `npm ci`, `npm run check`, and `npm test`. Integration tests
skip unless configured. Run hardware tests one at a time against debug-enabled
firmware and keep its matching ELF/source metadata. Native edits are real edits;
use a development app and restart it afterward if necessary.

| Test | Required environment variables |
| --- | --- |
| `test/integration.test.mjs` | `GEA_DEBUGGER_TEST_APP`, `GEA_DEBUGGER_TEST_SCRIPT` (web dev-server script) |
| `test/native.integration.test.mjs` | `GEA_DEBUGGER_NATIVE_TEST_APP`, `GEA_DEBUGGER_NATIVE_TEST_EXECUTABLE`, `GEA_DEBUGGER_TEST_SELECTOR` |
| `test/frontend.integration.test.mjs` | `GEA_DEBUGGER_FRONTEND_TEST_APP`, `GEA_DEBUGGER_FRONTEND_TEST_ENDPOINT`, `GEA_DEBUGGER_TEST_SELECTOR` |
| `test/device.integration.test.mjs` | `GEA_DEBUGGER_DEVICE_TEST_ENDPOINT`, `GEA_DEBUGGER_TEST_SELECTOR` (visible, styled node) |
| `test/device-highlight.integration.test.mjs` | `GEA_DEBUGGER_DEVICE_TEST_ENDPOINT`, `GEA_DEBUGGER_TEST_SELECTOR` (visible node, current debug firmware) |
| `test/device-preview.integration.test.mjs` | `GEA_DEBUGGER_PREVIEW_TEST_APP`, `GEA_DEBUGGER_PREVIEW_TEST_ENDPOINT` |
| `test/device-source.integration.test.mjs` | `GEA_DEBUGGER_SOURCE_TEST_ENDPOINT`, `GEA_DEBUGGER_SOURCE_TEST_FILE` (original path suffix), `GEA_DEBUGGER_SOURCE_TEST_LINE` (1-based, recurring executable position) |

For the source test, `GEA_DEBUGGER_SOURCE_TEST_COLUMN` is also 1-based; optional
`GEA_DEBUGGER_SOURCE_TEST_APP` enables verification through Chrome's own Sources
model. Frontend tests default to the macOS console context; set
`GEA_DEBUGGER_FRONTEND_TEST_CONSOLE='Gea device · host console'` for boards.
Set `GEA_DEBUGGER_FRONTEND_TEST_HIGHLIGHT=1` with a visible class/id selector
to verify real Elements mouse hover and leave against current board firmware.
Screenshot output is optional in native/frontend tests through their
`GEA_DEBUGGER_*_TEST_SCREENSHOT` variables; use an existing build output path.

The host adapters live in `src/`, the debug-only AppKit bridge in `native/`.
Keep app logic and fixtures out of production code. Preserve native lifetime IDs,
framing/checksum validation, request bounds, loopback bindings and CPU resume on
shutdown. Protocol failures must be explicit; do not mask missing native features.
