# Gea debugger

Chrome DevTools adapters for Gea applications. Inspect the actual native tree,
edit styles while the app runs, and debug compiled ESP32-S3 code through USB JTAG.

![Native Elements and editable styles](https://raw.githubusercontent.com/geastack/debugger/main/docs/screenshots/elements.png)

## Install

```sh
npm install --save-dev @geastack/debugger
```

Requires Node.js 22 or later and Chrome/Chromium. The commands below require a
Gea CLI, compiler and target runtime with debugger support. Gea CLI `0.1.97`
predates that integration; this package provides the adapters, not the toolchain.
Native release binaries must be rebuilt with debug instrumentation.

## Run from your app directory

```sh
# Build, flash and debug a registered board.
gea run --debug --board my-board --debug-fps 10

# Reconnect to matching debug firmware without flashing.
gea run --debug --attach --board my-board --debug-fps 10

# Native macOS or the browser runtime.
gea run --debug --target macos
gea run --debug --target web
```

Board debugging opens a preview and a separate Chrome DevTools window. Keep them
side by side. DevTools targets the board; inspecting the preview page itself only
inspects the browser mirror. Ctrl-C closes the relay and its owned processes.

| Option | Purpose |
| --- | --- |
| `--debug-fps 10` | Cap board rendering; accepts 1–120 FPS. |
| `--attach` | Reuse existing debug firmware and its matching build output. |
| `--no-open` | Expose the debugger without opening Chrome. |
| `--debug-port 9223` | Change the CDP and preview port. |

Default endpoints: [preview](http://127.0.0.1:9222/preview),
[discovery](http://127.0.0.1:9222/json/list), and
`ws://127.0.0.1:9222/devtools/page/gea`. The board relay owns its serial connection;
close it before using a serial monitor or device-control command.

## Inspect and edit

**Elements** shows nodes, text, attributes, native bounds and computed styles.
ESP32 also exposes live inline `style` attributes and supports editing authored
class rules as well as inline styles. Changes affect the running app and may be
overwritten by app code; they do not save to source. Native macOS supports inline edits and
highlights element bounds in its window.

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

ESP32-S3 debug builds expose original TS/TSX source maps, line/column hardware
breakpoints, Pause/Resume and Step Over/Into/Out. ESP-IDF's OpenOCD and Xtensa GDB
use built-in USB JTAG. The relay verifies that the ELF matches the running
firmware. Keep the matching build output when using `--attach`.

The chip has two hardware breakpoint slots. Stepping temporarily reserves a slot
and skips helpers without app source mappings. Scope shows generated C++ locals;
paused-frame evaluation accepts native C++ expressions such as `6 * 7`.
Original variable names, JavaScript conditional breakpoints, exception pausing,
live source replacement and macOS source stepping are not implemented. Pause
preserves the last tree snapshot; resume before editing the tree or styles.

Set `GEA_DEBUGGER_JTAG=0` for board tree/style inspection without source debugging.
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

Selection highlights follow native bounds in both previews. Physical-board
highlight overlays and preview click/touch forwarding are not implemented.

## Library and development

Exports: `@geastack/debugger` (web launcher), `/native` (macOS relay/launcher),
`/device` (serial relay/launcher), and `/cdp` (CDP client). The package includes
`native/macos.mm` for integration into debug builds. Board firmware implements
Gea's framed `GEADEV DEBUG` protocol; this package does not include firmware.

```sh
npm ci
npm run check
npm test
```

Unit tests run without hardware. Browser, native and board integration tests are
opt-in; see [CONTRIBUTING.md](CONTRIBUTING.md) for their environment variables.
Native adapters implement a subset of [CDP](https://chromedevtools.github.io/devtools-protocol/).
Other native platforms and widget trees outside Gea's retained tree are unsupported.

## License

[Apache-2.0](LICENSE). Copyright GeaStack contributors.
