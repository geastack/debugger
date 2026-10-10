# Gea debugger

Chrome DevTools adapters for Gea applications. Inspect the actual native tree,
edit styles while the app runs, and debug compiled ESP32-S3 code through USB JTAG.

![Native Elements and editable styles](https://raw.githubusercontent.com/geastack/debugger/main/docs/screenshots/elements.png)

## Install

```sh
npm install --save-dev @geastack/debugger
```

Requires Node.js 22 or later and Chrome/Chromium. The commands below require a
Gea CLI `0.1.98` or later, plus compiler and target runtimes with debugger
support. The CLI installs this adapter package automatically. Native features
require matching runtime/toolchain instrumentation; this package does not ship
board firmware or compiler changes.
Native release binaries must be rebuilt with debug instrumentation.

## Run from your app directory

### Same app on AMOLED 2.06 and native macOS

Run both commands from the same Gea app folder, for example `bouncing-balls-jsx`
or `tic-tac-toe`. No `--app` or `--project` arguments are needed.
Register the connected Waveshare ESP32-S3 Touch AMOLED 2.06 with `gea setup`,
choosing `amoled` as its board alias.

```sh
# Build, flash and run this app on the AMOLED board with DevTools.
gea run --debug --board amoled --debug-fps 10

# Stop the board debugger with Ctrl-C, then compile and run the same app on Mac.
gea run --debug --target macos
```

The board command opens Chrome DevTools and a preview with **Device display**
and **DOM mirror** modes. Select a node in Elements, edit its styles, or use
the Console; edits reach the running board. Source breakpoints and stepping
are available with `--debug-sources` when the matching ESP32-S3 debug build and
USB JTAG tools exist.

The Mac command builds a native `.app`, launches its window and opens DevTools
against its actual Gea tree. It requires a Mac, Apple command-line tools and
`@geastack/apple` installed in the app's dependency tree. A declared macOS target
is not required for this debug build. Inspect nodes, edit inline styles and
run Console scripts. Sources shows original TS/TSX files with breakpoints and
Step Over/Into/Out through Xcode's LLDB. Mac debug builds use full symbols and
disable optimization; `--no-debug-sources` keeps only tree/style inspection.
This compiled macOS backend hosts Gea's UI in AppKit. Direct UIKit/Apple-native
widget trees are not supported by the debugger bridge.

Run these sessions one at a time: they share the app's Chrome profile and use
CDP port 9222 by default. To reconnect to the board or debug in the browser:

```sh
# Reconnect to matching debug firmware without flashing.
gea run --debug --attach --board amoled --debug-fps 10

# Run this app with browser DOM/CSS and Vite HMR.
gea run --debug --target web
```

`--attach` requires the running firmware to contain debug instrumentation; it
cannot enable debugging in a regular build. The CLI validates the device's
debugger protocol before starting JTAG tools or Chrome. Source debugging also
requires local ELF/source metadata matching the running firmware.

Board debugging opens a preview and a separate Chrome DevTools window. Keep them
side by side. DevTools targets the board; inspecting the preview page itself only
inspects the browser mirror. Ctrl-C closes the relay and its owned processes.

| Option | Purpose |
| --- | --- |
| `--debug-fps 10` | Cap board rendering; accepts 1–120 FPS. |
| `--attach` | Reuse existing debug firmware and its matching build output. |
| `--debug-sources` | Enable source debugging. Default on macOS; explicit opt-in to ESP32-S3 USB JTAG. |
| `--no-open` | Expose the debugger without opening Chrome. |
| `--debug-port 9223` | Change the CDP and preview port. |
| `--overrides edits.json` | Apply saved Gea Changes overrides once the debugger attaches (macOS and ESP32). |
| `--save-overrides edits.json` | Write the session's net edits to a file when the debugger exits. |

Default endpoints: [preview](http://127.0.0.1:9222/preview),
[discovery](http://127.0.0.1:9222/json/list), and
`ws://127.0.0.1:9222/devtools/page/gea`. The board relay owns its serial connection;
close it before using a serial monitor or device-control command.
If attach reports `already in use (PID ...)`, close that process's debugger or
serial monitor before retrying. A hidden DevTools window can still have a running relay.

## Inspect and edit

**Elements** shows nodes, text, attributes, native bounds and computed styles.
Native macOS and ESP32 support editing authored class rules and inline styles,
including individual declaration checkboxes. Changes affect the running app and
may be overwritten by app code; they do not save to source. Copy outerHTML
serializes the native subtree.

Native targets open a pinned DevTools frontend served by the relay. It adds a
**Gea Changes** panel and UI zoom (⌘+/⌘−/⌘0, Ctrl on other platforms), and it
remembers the zoom level. The first run downloads the pinned frontend into
`.build/devtools`; published packages already include it. If the download fails,
or `GEA_DEBUGGER_FRONTEND=builtin` is set, Chrome's own frontend opens without
these additions.

### Gea Changes

Style, attribute and text edits from every connected DevTools window form one
shared history. Undo and Redo work from the panel or with ⌘Z/⌘⇧Z in Elements.
"Undo this change" reverts one edit out of order. Undo refuses to overwrite a
value that app code or another edit changed afterwards. The panel shows each
edit as a declaration or value diff against its target: a rule selector, an
element id or a classed child path.

**Save overrides** downloads the net edits as `gea-overrides.json`, and **Export
CSS** writes them as a stylesheet you can copy into source. **Load overrides**
replays a saved file into the running app as a single undoable transaction. A
loaded file applies all of its edits or none: every target is resolved before
anything is written. Elements are matched by a unique `id` when they have one,
otherwise by child path and tag. Pass the same files from the CLI with
`--overrides` and `--save-overrides` to reapply your edits on every launch.

### Event Listeners

The Event Listeners sidebar lists the handlers that Gea's JSX attached to the
selected element and its ancestors. Each handler links to the TSX line that
registered it. Listeners cannot be removed or toggled from DevTools.

On macOS, `getEventListeners($0)` returns the same list in the Console. On
ESP32-S3, debug firmware records the call stack of each registration, and the
host resolves it against the matching local ELF with GDB. This works without
USB JTAG: without `--debug-sources`, Sources shows the original code read-only
and can't set breakpoints. Firmware built before listener support needs one
rebuild. Other ESP32 chips list listeners without source links.

On macOS, enable the element picker in DevTools (⌘⇧C), then click directly in the
native app window. Hover highlights the element, and a click selects it in
Elements without activating its control. Escape cancels picking. Disconnecting
DevTools restores normal app input.

On ESP32, enable the same picker, then tap an element on the board or click it
in either preview mode. The board's native hit test chooses the element; the
tap selects it without triggering app handlers. Escape in DevTools or the
preview cancels picking. Disconnecting restores input, and a short lease also
restores it if the host exits abruptly. Existing debug firmware needs rebuilding
to add picking; normal builds contain no picker.

**Console** exposes `document`, `$`, `$$`, `$0`, `getComputedStyle`, tree mutations
and compiled click handlers:

```js
$0.style.backgroundColor = 'red'
$0.setAttribute('data-debug', 'active')
getComputedStyle($0).color
```

On boards, JavaScript runs on the host against a native-tree snapshot; mutations
are acknowledged by the device before evaluation returns. There is no board VM.
Use `await document.createElement('div')` to allocate a board node. The macOS
inspector uses JavaScriptCore. Selectors support tags, classes, IDs, `body` and `*`.

## Source debugging

On macOS, `gea run --debug --target macos` enables source debugging automatically.
Open a TS/TSX file in Sources, set a line or inline breakpoint, and trigger its
action in the Mac window. DevTools pauses the compiled app and supports
Pause/Resume and Step Over/Into/Out. LLDB uses software breakpoints, without the
board's two-slot limit. Stepping skips unmapped C++ helpers; Step Out can land in
a native caller after leaving app code. Scope values can be expanded.

Add `--debug-sources` on ESP32-S3 debug builds for original TS/TSX source maps,
line/column hardware breakpoints, Pause/Resume and Step Over/Into/Out.
ESP-IDF's OpenOCD and Xtensa GDB use built-in USB JTAG. The relay verifies that the ELF matches the running
firmware. Keep the matching build output when using `--attach`.
Attach checks build folders in the app and its ancestor workspaces, selecting
the ELF whose hash matches the running firmware. A missing-file error refers
to local build output; it does not determine whether firmware supports debugging.

The chip has two hardware breakpoint slots. Stepping temporarily reserves a slot
and skips helpers without app source mappings. Scope shows generated C++ locals;
paused-frame evaluation accepts native C++ expressions such as `6 * 7`.
Both native backends show generated C++ locals, and paused evaluation accepts
native C++ expressions rather than JavaScript. Original variable names,
JavaScript conditional breakpoints, exception pausing and live source replacement
are not implemented. Pause preserves the last inspected tree; resume before
reading new UI state or editing the tree and styles. Disconnecting the last Mac
source-debugger client removes its breakpoints and resumes the app.

Tree/style inspection does not start OpenOCD/GDB by default. `--debug-sources`
or `GEA_DEBUGGER_JTAG=1` opts into USB JTAG; `--no-debug-sources` overrides the
environment. These options do not enable debugging in a regular firmware build.
`GEA_GDB_BIN`, `GEA_OPENOCD_BIN` and `GEA_CHROME_PATH` override installed tools.
`GEA_DEBUGGER_DIR` selects a debugger checkout for the Gea CLI.

## Preview modes

Choose a view from the preview's selector; the browser remembers your choice.

| Device display | DOM mirror |
| --- | --- |
| Actual framebuffer screenshots. | Browser elements using the native tree and measured bounds. |
| Modest USB refresh rate; last image stays visible while paused. | Tree updates every 750 ms; canvas regions use device pixels. |
| Faithful device pixels. | Loads local app fonts; rasterization and unsupported styles can differ. |

![Device pixels](https://raw.githubusercontent.com/geastack/debugger/main/docs/screenshots/device.png)
![Structured DOM mirror](https://raw.githubusercontent.com/geastack/debugger/main/docs/screenshots/mirror.png)

Hovering or selecting an element highlights its live bounds in both previews
and on boards with current debug firmware. The native outline leaves DOM/CSS
unchanged, follows motion and clears on hover-out or disconnect. A short device
lease also clears it after an abrupt host exit. Native highlights update after
resume when the CPU is paused. Drawing the overlay requires full repaint while
visible; use `--debug-fps 10` or `30` to leave room for inspection.
Preview clicks select elements while DevTools' picker is enabled. Forwarding
ordinary preview clicks as app input is not implemented.

## Library and development

Exports: `@geastack/debugger` (web launcher), `/native` (macOS relay/launcher),
`/device` (serial relay/launcher), and `/cdp` (CDP client). The package includes
`native/macos.mm` for integration into debug builds. Board firmware implements
Gea's framed `GEADEV DEBUG` protocol; this package does not include firmware.

```sh
npm ci
npm run build:frontend
npm run check
npm test
```

`npm run build:frontend` downloads the Chromium DevTools frontend at the
revision in `frontend/pin.json`. It checks each patched file against its pinned
hash and then applies the Gea patches. `npm pack` runs it automatically.

Unit tests run without hardware. Browser, native and board integration tests are
opt-in; see [CONTRIBUTING.md](CONTRIBUTING.md) for their environment variables.
Native adapters implement a subset of [CDP](https://chromedevtools.github.io/devtools-protocol/).
Other native platforms and widget trees outside Gea's retained tree are unsupported.

## License

[Apache-2.0](LICENSE). Copyright GeaStack contributors.
