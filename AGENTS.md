# AGENTS.md

This file is the project's instructions for coding agents and its living architecture doc: read it before making changes. Oarlock reads a project's `AGENTS.md` from the workspace root as the project's instructions once the user allows it in the project trust prompt; Codex reads it too, and Claude Code through `CLAUDE.md`, which imports it.

## Project

**Oarlock**: open-source AI-native terminal emulator. Tauri 2 + Rust (`portable-pty`) backend, React 19 + TypeScript + libghostty-vt WASM client (WebGPU, Oarlock WebGL fallback), BYOK AI via Vercel AI SDK v7.

- Bundle id: `consulting.quantumops.oarlock`
- Package manager and runtime: **Bun** (`bun install`, `bun run <script>`). `bunfig.toml` runs scripts and their tools on Bun rather than Node, keeps a three-day minimum release age, and uses the isolated linker so undeclared dependencies fail
- Platforms: macOS, Linux, Windows
- Frontend checks: `bun run lint`, `bun run check-types`, `bun run test`
- Rust checks: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo nextest run --locked` (local fallback: `cargo test --locked`)

## Quality bar

Production-grade or it does not ship. Every change is judged against all of these, not just "it works":

- **Correctness**: edge cases, failure modes, concurrent access. No "works for now".
- **Performance**: ultra-lightweight is the product: every dependency justified, heavy code loaded lazily, size budgets enforced in CI, and a high-performance terminal. For every change ask: how much RAM it costs, whether it adds IPC round-trips or redundant requests, whether it triggers extra re-renders or wasted work, whether it pulls a heavy dependency. Unused features consume zero resources.
- **Security**: no critical security holes. Validate at every boundary (IPC, fs, network, AI tool surface). The secret-path deny-list applies on both read and write and is never bypassed.
- **UI/UX**: polished, professional, premium. Every state and detail considered.
- **Architecture**: new or changed logic lives in pure, dependency-light functions (functional core); tauri commands and React components stay thin (imperative shell). Keeps it testable without a later rewrite.

Verify before claiming done:

- Frontend: `bun run lint`, `bun run check-types`, `bun run test`
- Rust: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo nextest run --locked` (or `cargo test --locked`)

A change to a core subsystem (terminal/shell spawn, workspace auth, git, fs, IPC or AI tool surface) needs a test that locks the invariant.

## Terminal migration status

libghostty-vt is the only terminal model. WebGPU is the default renderer and
Oarlock WebGL is the compatibility fallback. Each leaf owns one persistent model
in its own WebAssembly instance (the module is compiled once and shared), so
closing a leaf drops its linear memory and scrollback instead of leaving a
high-water mark; nothing may retain a view into a disposed model's memory.
Scrollback summed over all leaves is capped by a budget (192 MiB, scaled fairly
between leaves, never pruning history already held). Presentation resources are
shared, bounded, and released for hidden leaves.
All visible WebGPU panes of a window draw into one canvas that covers the
terminal area (`gpu/WebGpuWindowCanvas.ts`; the `[data-terminal-area]` layer of
`TerminalStack`, behind the tab layers). Each pane renders into its device-pixel
snapped rectangle (`gpu/PaneRects.ts`, measured on layout changes only) with
`setViewport` and `setScissorRect`, which keeps glyph overhang out of the
neighbour; the shader takes viewport size and origin from the uniform, so a
pane's pixels equal what a canvas of its own showed (verified byte for byte,
`scripts/terminal-visual/grid.html`). Canvas textures are not preserved between
frames, so a window frame clears the canvas and encodes every visible pane in one
pass (cell buffers stay resident on the GPU, no per-cell work). Per-pane dirty
tracking still decides whether a frame is needed: an unchanged window acquires
no texture (`windowFrameNeeded`). `SurfaceFramePacer` decides which panes prepare
in a frame; a pane whose rectangle moved always does. Pane DOM is transparent
once the canvas has shown the pane's first frame (until then it paints the theme
colour, so a tab switch never flashes the card behind); translucent terminals
leave default-background cells transparent and the page paints the background
(see Translucent terminals); scrollbars, selection,
IME, block overlays and cursor styles stay per-pane DOM above the canvas.
A presented WebGPU canvas is never destroyed, unconfigured, shrunk or
dropped while the runtime lives: WebKit (macOS 26) keeps the swapchain of such a
canvas in the WebContent process for good (three buffers, about 30 MiB for a
2000x1300 canvas, whatever the teardown order and garbage collection), and keeps
every swapchain a resizing canvas retires until JavaScriptCore collects its
wrappers (minutes), so every teardown or resize leaks. A tab switch, a split or a
divider drag therefore only changes viewports: zero canvas allocations. The
canvas is reallocated only when the terminal area itself changes size, at most
twice per window drag (below). With no visible pane (an editor tab is active) or
an occluded window it is paused (hidden after a short delay when empty), never released. A replaced or
recovered GPU device reconfigures the same element, and a remounted area takes
over the old one's canvas. Only disposing the runtime tears it down. The WebGL
fallback stays per pane (its own canvas and opaque background inside the pane
root): a WebGPU failure in one pane falls that pane back, and a failure of the
shared runtime falls every pane back.
Every submitted window frame is mirrored to JavaScriptCore (`gpu/GcPressure.ts`):
the wrappers of a frame (texture, view, encoder, pass, command buffer) pin about
13 KiB of WebKit malloc that JavaScriptCore does not count, so without help it
collects them after minutes (20 MiB a minute for a streaming agent). Allocating and
dropping a 126 KiB `ArrayBuffer` per frame (ten times the native cost; measured:
unfinalized canvas textures after 120 s 2,626 without, 195 with it, no change in
instructions per second) makes young-generation collections run steadily. At most
4 MiB a second is mirrored, so display-rate frames allocate no more than a 25 fps agent.
Resizing applies one synchronized model + PTY resize per gesture. Every SIGWINCH
makes zsh/fish and Ink-based agents redraw, and redraws that do not line up with a
reflowed grid leave duplicates in scrollback, so during a resize gesture (native
macOS live resize via `NSWindowWillStart/DidEndLiveResize`, forwarded as
`liveResize` in `oarlock:window-presentation`; a pane divider drag via
`terminalResizeInteraction`; elsewhere a burst of size changes less than 150 ms
apart, `lib/terminalResizeGesture.ts`) neither the model nor the PTY changes. The
pane follows the pointer at display rate (`SurfaceFramePacer` gesture mode) and
draws its existing grid: shifted up (`shift_y`) so the cursor row stays visible
when the pane is shorter, clipped on the right or padded with the background
otherwise. At release `TerminalResizeSync` resizes the model and tells the PTY in
one call, model first. Ghostty clears the prompt on that resize and relies on the
shell's redraw, so the pane holds its previous frame until the redraw ends or
70 ms pass (`core/ResizePromptHold.ts`; only at an OSC 133 prompt, never in the
alternate screen). Resizes outside a gesture (sidebar, font, ratio, first fit,
showing a hidden pane) apply at once. During a gesture the window canvas's backing
store is grow-only: it keeps its allocation while the area shrinks and, when the
area outgrows it, allocates once to the largest size it can reach
(`gpu/GestureBacking.ts`: the area plus the screen room left when the window
itself is dragged, else the window; capped by the device limit), then compacts at
release, so a drag costs at most one growth and one compaction. The WebGL
fallback defers the same way per pane (top-anchored).

The WebGPU path (renderer v2, `docs/architecture/terminal-renderer-v2.md`) runs
no per-cell JavaScript. Ghostty encodes 16-byte cell records natively and
reports only rows whose bytes changed. The surface uploads those ranges straight
from WASM memory (`consumeGpuFrame`) into a storage buffer, and nothing may call
the model between that frame and the upload because the view is borrowed. It
never touches the structure-of-arrays APIs, which would flip the model's format;
only the WebGL fallback uses them. A background pass derives each cell from its
pixel (background, search, selection, cursor, decorations) and an instanced
glyph pass draws integer-pixel quads with unfiltered `textureLoad`. Selection and
cursor are uniforms and the search highlight is a mask buffer that exists only
while something is highlighted, so none of them rewrites cell records.
Geometry is pixel exact. Fonts are measured at size times ratio and cells are
whole device pixels (`TerminalFontMetrics.deviceCell*`). `cellWidth` and
`cellHeight` are the CSS size, device divided by ratio, and are what fit,
hit-testing, selection, links and block overlays use. The fit leaves the
scrollbar strip on a pane's right edge (11 px, `TERMINAL_SCROLLBAR_WIDTH`) out of
the grid, so the last column is never under the strip, which takes the pointer
there, and text keeps a gutter from the pane's edge. A pane's rectangle in the
window canvas holds at least cols by rows device cells (slack is background, the
scissor clips the rest) and the canvas origin is translated onto the device
pixel grid when the observer, ratio or window size changes. A ratio change
re-measures the font and rebuilds atlas and buffers.
Each terminal maps Ghostty glyph ids to a glyph atlas shared per font and ratio.
The atlas grows (coverage 1024 to 2048 to 4096, colour 512 to 2048) before it
flushes into a new epoch; after a flush each surface rescans its visible cells and
re-rasterizes only what it shows. Rasterization is limited to about two
milliseconds per frame across surfaces, leftover glyphs draw on follow-up frames,
and a backlog from scrolled-away output keeps only visible glyphs queued.
Grayscale text gets a DirectWrite-style contrast curve when the ratio is below 2
or on Windows and Linux (`localStorage["oarlock:terminal-text-contrast"]` is
`off`, `on` or a strength); macOS Retina is unchanged.
Box drawing, block elements, braille, powerline separators, git branch drawing
(U+F5D0-F60D) and legacy computing shapes including the supplement (octants,
separated sextants and quadrants, sixteenths, circle pieces) are drawn
procedurally at exactly the cell size, not from the font, with Ghostty's sprite
geometry (`gpu/BuiltinGlyphs.ts`, pure, shared by the WebGPU and WebGL atlases;
every code point Ghostty's sprite font draws, checked against its reference
images), so borders and bars join seamlessly at every size and ratio. They
ignore bold and italic and skip the text contrast curve. Font glyphs that are
not plain text are fitted to their cells with Ghostty's constraint maths
(`gpu/glyphConstraint.ts`): Nerd Font icons get Ghostty's per-icon size and
alignment (`gpu/nerdFontConstraints.ts`, generated by
`scripts/nerd-font-constraints/build.ts` from the pinned Ghostty's table), other
symbols shrink to fit, and emoji fill their cells. A glyph gets two cells by
Ghostty's cell rule: a wide cell, or a symbol followed by a free cell or a
space that neither ends the row nor follows another symbol (the core marks it
with `GPU_GLYPH_TWO_CELLS` for WebGPU; WebGL applies `constraintCells`). Text is never
transformed. One rasterizer (`gpu/GlyphRasterizer.ts`) serves both atlases.
Glyphs are drawn in white; one with coloured pixels is drawn again in black and
is a colour glyph (drawn with its own colours, not the cell's) only if it
keeps them, since subpixel antialiasing (WebKitGTK on an LCD-rendering desktop)
fringes plain text with colour (`gpu/glyphColor.ts`).
Font ligatures (Settings, "Font ligatures", on by default, off while letter
spacing is set) use runs of 2 to 16 adjacent narrow ASCII punctuation cells
drawn alike (`gpu/ligatureRuns.ts`; the core interns each cell as the whole run
plus its index, `GPU_GLYPH_LIGATURE`, and WebGL applies the same rule): every
cell's glyph is the run drawn with that cell's character on its pen origin, cut
to the cell, so `->` or `!=` joins while each cell keeps its own pixels.
Runs break at the visible cursor, as in Ghostty, so the text under it reads as
typed; the rows the break moves between are re-encoded.
Font features (Settings, "Font features": `zero, ss01, -calt`, Ghostty's
`font-feature` syntax; `terminal/lib/fontFeatures.ts`) ride on the font faces,
since canvas text has no `font-feature-settings`: each `@font-face` family of
the terminal stack is declared again under a derived name through `FontFace`
with `featureSettings`, and the stack (grid and block editor) names that
instead. Installed fonts (Nerd Fonts) ahead of the bundled one are declared
again from their face files: `system_font_faces` (`fontdb`, rescanned at most
every 10 s when a family is missing) lists a family's faces and grants their files to
the asset protocol, and each loads through it the first time it is drawn
(`local()` cannot name faces reliably). Collection members past the first are skipped. Until the
lookup answers the font draws as named, then the panes measure again. On macOS
installed families take this path with no features too: WKWebView's canvas
does not see fonts the user installed and draws a fallback, so a configured
Nerd Font never reached the grid; macOS's own fonts (under `/System`) still
draw by name.
Letters, digits and spaces never form runs and keep the ASCII fast path.
Kitty graphics draw in both renderers in Ghostty's three layers (under cell
backgrounds, between backgrounds and text, above text; `gpu/imageLayer.ts`,
pure and shared). The image code loads the first time a pane shows an image
(`WebGpuImageLayer.ts`, `webgl/WebGlImageLayer.ts`). Each image is one RGBA
texture keyed by id and re-uploaded only when its generation changes; a pane
holds at most 64 MiB and 256 textures, an image off screen keeps its texture
for 60 updates, eviction takes the least recently shown off-screen images
first, and everything is freed when the pane hides or loses its device.
Animations tick right before a frame reads the model with one timer armed for
the next frame change, and none while the pane cannot be seen
(`gpu/imageAnimation.ts`). The hovered link (OSC 8 or detected) gets an
underline overlay in the text colour; cell data is never rewritten for it
(`gpu/linkUnderline.ts`).
A custom shader (Settings, General, Terminal; Ghostty's and Shadertoy's
`mainImage` contract with Ghostty's uniform names, `iChannel0` the finished
frame, `iCurrentCursor`/`iPreviousCursor`/`iTimeCursorChange` for trail shaders)
runs on the WebGL renderer, which terminals use while one is set
(`webgl/customShader.ts`, loaded on first use): the frame is drawn into a texture
and the shader draws the canvas from it, as WebGL2 GLSL (Shadertoy's dialect).
Settings compiles a chosen file before saving it and shows compiler errors by
line; it animates only while the window has focus.
Native cell, grapheme and hyperlink presentation buffers allocate on first use
and return to the WASM allocator when a pane is hidden. Hidden parsing does not
rebuild them. Window pauses (occlusion, sleep) retain them and the uploaded cell
data.
Unchanged frames do not acquire presentation textures or draw; cursor-only
updates upload only the uniform. WebGL background and decoration geometry uses
row range uploads while rectangle counts are stable; structural changes rebuild
the compact stream. Scrollbar synchronization never reads the DOM on presented
frames; moving the thumb under a bottom-pinned view costs at most ten position
writes and four ARIA updates a second. Blink timers stop in unfocused windows,
and native cursor hiding stops cursor timers. Selection is a uniform and needs no
row damage; streaming search invalidations coalesce instead of rebuilding per
output chunk.
WebGL surface and renderer code load only when selected, needed for fallback,
or explicitly requested by diagnostics. On Linux a WebGL context keeps its
drawing buffer (`webGlContextAttributes`): WebKitGTK without hardware
acceleration (NVIDIA on Ubuntu) paints the canvas from the buffer it just
swapped out, so every frame, the last keystroke included, showed one late. Delayed imports cannot install into a
closed, restarted, or replaced session.
xterm, its addons, CSS, snapshots, session pool, and dormant byte ring are removed.
Unsupported graphics produce a visible error with retry instead of changing models.

Command blocks use parser-time Ghostty tracked pins, including endpoint columns,
so command ranges survive reflow and exclude following prompts and commands.
The native marker ring is capped at 2,048 pins; JavaScript history is capped at
1,000 blocks and 512 KiB of estimated UTF-16 command/cwd text. Block implementation
and UI load only for block sessions, and hidden/occluded block presentation stops.
Block search yields after 128 rows or four milliseconds, retains at most 500
matches, and cancels obsolete queries. Block copy, search, sticky headers, navigation, Ask AI, rerun, shared shell input,
and selection all use the same persistent Ghostty model.
Block chrome commits with its matching renderer frame; it is recomputed only when
the viewport origin, scrollback, size, cell height, block mode or block set
(`GhosttyBlocks.revision`) changed, so frames that only repaint cells cost no
block work and no React commit. The per-frame path reads cached cell metrics, never
layout, and the shell/prompt input switch runs on block-mode changes, not per PTY
chunk. Command-editor focus does
not lower active-pane cadence. Divider padding is presentation-only and does not
change copied command boundaries. Scrollbars preserve native fractional positions
and ignore delayed programmatic scroll events. Hidden output does no surface DOM
or search-mask work until presentation resumes.

Terminal clipboard shortcuts use native version-checked text/image snapshots.
Unverifiable captures fail rather than combining contents from different copies. The keys are one pure decision (`terminalClipboardAction` in
`terminal/lib/keymap.ts`): Cmd+C/V on macOS; Ctrl+Shift+C/V, Ctrl+Insert and
Shift+Insert elsewhere; and on Windows, like Windows Terminal unless Settings
turns it off (`terminalBehavior.smartCopyPaste`), Ctrl+C copies and clears a
selection (interrupting without one) and Ctrl+V pastes text, or reaches the
program when the clipboard holds no text so agents can read an image. Linux
keeps plain Ctrl+C/V for the program. When the clipboard holds only an image,
the other paste keys (Cmd+V, Ctrl+Shift+V, Shift+Insert) send the program
Ctrl+V in its keyboard mode, so agents such as Claude Code and Codex read the
image themselves; a program that set mode 5522 gets the Kitty paste event
listing `image/png` instead. A copy key with nothing selected goes on
to the program. Context clicks expose the selected text through the input element to
restore the webview's native text menu; no persistent DOM scrollback is maintained.
On macOS the input `<textarea>` always holds one selected placeholder character
(`TerminalInputProxy`; elsewhere it stays empty, a selection could take X11 PRIMARY): a focused editable with a collapsed selection keeps
WebKit's caret animation (a display link at display rate) running at ~3 % CPU and
~250 wakeups/s while idle, a non-collapsed selection paints no caret (0.2 %, ~10/s).
It re-arms after input, key release and focus, never during IME composition, and
native Copy/Cut without terminal text must not copy the placeholder.
Unclaimed macOS Command shortcuts reach the native menu after explicit clipboard,
block-editor, and readline bindings, including when Kitty keyboard mode is active.
The block prompt retains an enabled terminal input proxy for native menus and
routes editing keys, composed text and paste back to its command editor.
Character drags retain a native selection pin from pointerdown, including before
the first pointermove. Unmoved clicks and lost captures discard provisional pins.
A drag whose release never arrived ends at the first move without the
primary button, where the pointer last was.
Key encoding supplies the base character required by Kitty keyboard mode; plain
keys and key releases also use Ghostty encoding when the application requests it.
Shift that picked a key's typed character is passed as consumed, as Ghostty's
own apprts do, so Kitty modes below report-all send the text (Shift+; is `:`)
and report-all names the unshifted key with Shift. Shift+Enter is ESC CR (what
agents read as a newline) unless the program set Kitty keyboard flags or
modifyOtherKeys 2, which get Ghostty's encoding (`CSI 13;2u`). On Windows a
program cannot turn on Kitty report-events or report-alternates
(`supportedKittyKeyboardFlags`, applied by the core to every push and set, so
queries report what is in force): the inbox ConPTY drops any input CSI with a
`:` sub-parameter, which those flags put in arrows, releases and shifted keys.
Caps Lock and Num Lock are reported with every key, as Ghostty and Kitty do;
programs speaking the protocol mask them.
Keydowns an input method owns (during a composition, dead keys, keyCode 229
on character keys) are left to the webview, whose input and composition
events carry the text (`isInputMethodKeyDown`); arrows, Home, End, Page keys,
Backspace and Delete stamped 229 (WKWebView's Option keys) are still keys.
Text one keystroke delivers twice by different events (a prevented keydown
and a stray `beforeinput`, `compositionend` and `insertText`) is typed once;
the pairing ends at the next keydown, so a fast double letter always types.
Terminal text uses the configured font, an installed Nerd Font when detected,
or bundled JetBrains Mono: the official variable fonts, upright and italic, with
every glyph, weight (100-800) and OpenType feature, split by Unicode range into
WOFF2 segments (`src/styles/jetbrains-mono.css`, regenerated by
`scripts/jetbrains-mono/build.ts`); `ensureMonoFontsLoaded` loads the Latin
segment of each style before a terminal starts and the rest load on first use.
Engines never fall back to unnamed fonts for Private
Use Area codepoints, so every stack ends its chosen fonts with "Oarlock Symbols":
Symbols Nerd Font split into one WOFF2 per icon set (`src/styles/symbols.css`,
regenerated by `scripts/symbols-font/build.ts`). Its faces cover only the
Private Use Area, so a segment downloads the first time one of its icons is
drawn and ordinary text never touches it; an installed Nerd Font earlier in the
stack still draws its own icons. Glyph atlases must not cache a glyph drawn
before its font arrived: `GlyphFontGate` defers every non-ASCII glyph (icons,
and text in a JetBrains Mono segment not loaded yet) until `document.fonts`
reports its fonts loaded (a failed load also settles), the
WebGPU glyph map parks them outside the raster queue and the WebGL renderer
redraws in full when the load settles. Icons, like procedural glyphs, ignore
bold and italic. Native color emoji remain on the system fallback path. Rerun requires the complete command
submitted through Oarlock; truncated shell labels are never executed.
Primary-screen full erase, scrollback erase, and terminal reset invalidate block
pins at parse time and clear block chrome, selection, and search. Commands after
an erase in the same output chunk retain their new pins. Alternate-screen erases
preserve primary block history. Block scrollbar status dots are removed along
with their timers and history scans.

The shared command bar activates after shell integration confirms prompt input.
Its completion list moves with the arrows or Ctrl+N / Ctrl+P and accepts with
Tab or Ctrl+Y while it shows; with no list those keys do what they did before
(`completionKeys.ts`), and off macOS the list claims the three Ctrl chords from
the app's shortcuts (Ctrl+P is the palette) only while it shows.
Bare shells keep direct terminal input. Bash before 4.4 reports
`OSC 133;B;oarlock_blocks=0` and keeps its native prompt because it lacks PS0.

Settings offer Automatic or WebGL for new terminals, plus opt-in screen reader
output. The wheel in a full-screen program that does not track the mouse sends
cursor keys (alternate scroll, mode 1007) unless "Scroll wheel sends arrow keys"
is off (`terminalBehavior.alternateScroll`). The setting is the mode's reset
value in the core (`restty_set_mode_default`, Ghostty's `mode_default`), so a
program that sets the mode itself still decides, and a change reaches every
terminal whose program left the mode alone. Accessible text is limited to 256 rows / 64 KiB and refreshes at most four
times per second while visible. Ordinary URL detection runs on pointer demand;
OSC 8 links take precedence. A clicked link opens in the browser (URLs), the
editor (files, at their line) or the system file manager (local folders); a
file:// link counts as local with no host, `localhost` or this machine's name,
which `ls --hyperlink` and eza write (`terminalLinkOpen.ts`). OSC 52 side effects retain one in-flight write and
only the latest pending value across the window. Program writes reserve native
clipboard ordering before delayed conversion; text and image commits share the
app-wide coordinator, separately from Linux PRIMARY. Each write owns a page token
and exact ticket, with terminal-generation cancellation. Close/restart/reload
revoke uncommitted writes, while shell exit retains final writes until the pane
closes. Explicit Copy buttons share ordering; native browser/menu Copy and Cut
announce a barrier without replacing native formats. An OS commit already started
cannot be undone, and copies from other applications are outside this ordering. OSC 52 writes carry up to
6 MiB of text (about the 8 MiB of base64 Ghostty takes per OSC) and reads are
answered with up to 8 MiB. Terminal replies have a PTY budget of their own,
apart from what the user types: one larger reply (up to 64 MiB, a clipboard
answer) is taken while no backlog beyond it is queued.

Kitty clipboard reads (OSC 5522) follow the clipboard-read setting: denied ones
the core refuses itself, others are held in the core until the user answers
the same prompt OSC 52 uses (naming the program as it names itself) and then
answered with the clipboard text under each requested text type and the
clipboard image as `image/png` (32 MiB at most per answer, all types
together); a listing of the types on offer is served unasked, as Kitty does.
The image is read and encoded only when asked for or listed, and reads within
a second share one. A program that sets mode 5522 is told of a paste from a
clipboard (shortcut, menu, middle click) by a Kitty paste event instead of the
text, listing `image/png` too when the clipboard holds an image (a clipboard
holding only an image is pasted this way alone), and its follow-up read,
covered by the event's one-time password, is served without the prompt.
Writes are allowed like OSC 52 writes and share its latest-value queue (the
primary selection, text only, where asked); a write with an image puts the
image on the clipboard (types other than PNG converted through a canvas), its
text written instead should the image not decode. Files dragged over a pane whose program registered for drops (Kitty
OSC 72) go to the program as a copy, offered as `text/uri-list` and
`text/plain`; elsewhere a drop pastes shell-quoted paths as before.

The adapted Ghostty revision is pinned in `packages/ghostty-core/adapted/UPSTREAM.md`.
Both SIMD and scalar artifacts are shipped; the loader fetches only the variant
the webview supports. Scalar validation explicitly disables SIMD instructions
and types. This avoids changing OS minimums solely for the WASM SIMD requirement;
actual older WKWebView and WebKitGTK compatibility still needs platform tests.

PTY output is one multiplexed pull stream per window (`docs/architecture/pty-transport-v2.md`),
not a channel per terminal. The async `oarlock-pty` URI scheme (`pty/protocol.rs`) has two POST
endpoints: `poll`, kept outstanding exactly once per webview, and `ack`. One process-wide hub
thread (`pty/hub.rs`, scheduler in plain data driven by explicit time) holds the poll's responder
and answers with framed binary data (`pty/wire.rs`: `[u32 id][u8 kind][u32 len]`, kinds data, exit,
failed, sync; data frames carry their stream offset; responses are capped at 1 MiB) for every
terminal whose coalescing deadline is due. A terminal's presentation class picks its deadline:
focused 4 ms (16 ms sustained), visible 16 ms, hidden 100 ms, window occluded or asleep 250 ms;
256 KiB pending is always due, and terminals due within 4 ms ride in the same response (one
terminal contributes at most 512 KiB per response, so floods pipeline and share). The
frontend reports classes only on change (`pty_set_presentation`, from `lib/ptyPresentation.ts`);
each report carries a growing sequence number and a terminal keeps the newest one that named it,
because async commands can be applied out of order. macOS occlusion and sleep reach the hub natively
from `window_presentation.rs`, per window (each app window's own occlusion and live resize, sleep
for all of them). The stream token from `pty_stream_open` is the credential: any frame
can reach the scheme but only the page can invoke, so every request is admitted (`pty/gate.rs`) on
the handler's thread before it may wake the hub: the `Origin` must be the app's own
(`tauri://localhost`, `http(s)://tauri.localhost` on Windows, the dev server in dev builds; a request
without `Origin` is token-only), the body at most 3084 bytes (413) and well framed (400), and the
token the live one for the requesting webview (403; the hub publishes label to token, compared in
constant time). Responses echo the allowed origin with `Vary: Origin`, never `*`. Tokens come from OS
entropy only: if it fails, `pty_stream_open` fails instead of falling back to the clock. A terminal's
output is held until its receiver announces itself, and reload or window
destruction drops the held responder, kills the token and detaches that window's terminals.
Frontend `PtyOutputHub` owns the loop: it re-polls on a response before parsing and demultiplexes
to the `PtyOutputReceiver`s, whose cumulative parsed offsets ride on the next poll. An ack-only
request goes out only for new receivers, for more than 512 KiB of unsent progress, or when native
sends `sync` because it waits on that terminal (credit blocked or exiting).

Receivers parse in at most 32 KiB slices with a four-millisecond work budget on a shared FIFO
MessageChannel task queue, which closes its ports when idle. Only fully parsed original chunks
earn credit. Credit is bytes: at most 1 MiB in flight (128 chunks) and 2 MiB pending plus in
flight per terminal. Acknowledgments are cumulative offsets validated against delivered chunk
boundaries, so duplicates and retries cannot grant credit; a bad boundary or stream gap fails only
that terminal visibly. Parser failures stop delivery without acknowledging unconsumed bytes.
Transport failures retry with capped backoff and surface as one stalled/failed toast per
terminal. Exit waits for the reader drain and the final acknowledgments; the `exit` frame always
follows that terminal's last data frame. Unix readers sleep on PTY readiness plus an explicit
shutdown signal without a polling timer. After shell exit they consume ready output, bounded to
2 MiB / 30 seconds, rather than wait indefinitely for an inherited slave descriptor to close.
Exceeding this drain bound reports a reader failure and exit status -1. After shell exit,
30 seconds without acknowledgment progress closes a stalled queue with a logged delivery failure
and exit status -1. The deadline is armed before ConPTY close and thread joins; it does not run
during live-shell backpressure. Close wakes blocked queue workers and the Unix reader; Windows
keeps draining the pipe while ConPTY closes. Per-read costs stay low: the agent and DA filters
scan with `memchr` and copy runs, the reader checks an atomic `closed` flag and reuses its
buffers, input goes through one bounded queue to a per-session writer thread, worker threads use
128-256 KiB stacks, and `pty_has_foreground_process` lists children with `proc_listchildpids` or
`/proc/<pid>/task/*/children` instead of forking `pgrep`.

Enable release diagnostics with `localStorage.setItem("oarlock:terminal-diagnostics", "1")`
and reload. `window.__oarlockTerm()` reads frontend counters;
`await window.__oarlockTermSnapshot()` adds native queue counters and explicitly
labeled host RSS. Host RSS
excludes WebContent and GPU processes and is not total application memory.

Ghostty presentation uses shared native macOS occlusion/sleep and DOM visibility
tracking. Every renderer pauses immediately. The WebGPU renderer does nothing
more: frames and timers stop, while the window canvas (configured, at full size), cell
buffers, glyph maps and atlas textures stay resident, so coming back from a
Space switch, minimize or sleep costs one redraw and no allocation. Releasing
them is worse than keeping them (see the window canvas above). The WebGL fallback
still reclaims its renderer after two seconds of continuous occlusion, and at
once on sleep, because its dropped canvases are garbage collected (measured:
transient, no growth). Hidden tabs release their buffers and atlas lease immediately and
leave the window canvas (its size is kept). Per-pane pacing prevents focused output from
raising background pane cadence. Panes that are neither focused nor being
interacted with snap to one shared tick (30 Hz, 15 Hz in an unfocused window):
a pane that turns dirty waits for the end of its tick and presents with every
other pane of that tick in one encoder, submission and commit, at most once per
tick. The planner asks for an animation frame only for the vsync that can serve
the next deadline (the refresh interval and phase are learned from callback
timestamps), sleeping on a timer otherwise, so a 120 Hz display does not pay a
callback per vsync. A timer sleeping for a later tick is re-planned when a pane
that is due sooner turns dirty, so the focused pane never waits behind it.
WebGPU permits at most two outstanding frame submissions and keeps one
`onSubmittedWorkDone` wait outstanding at a time: frames submitted while it is
pending ride the next wait, which starts when it resolves (waiting only every
second frame was tried and cut a 32 Hz producer to 23 presented frames a second).
User wheel, drag, and keyboard interaction gives only its pane 150 ms of focused
cadence, including in an unfocused visible window. It starts no idle timer or
frame loop.
`window.__oarlockTermTrace()` explicitly starts a bounded ten-minute resource trace;
it is never started automatically. `bun run soak:ghostty` exercises real WASM models
without launching the application. `bun run profile:ghostty` compares allocation
and parsing workloads in a fresh process per artifact and optional baseline.
`bun run profile:renderer:macos` exercises the real renderer in an isolated native
WKWebView, including optional four-pane layouts and live visual inspection.
`scripts/terminal-visual` draws a fixed pattern through any source tree and reads
the canvas back as exact pixels for comparison.
`bun run test:ipc:macos` verifies binary AI streaming, cancellation, and conversation
storage in a separate Tauri profile with synthetic local HTTP responses.
Resource evidence and limitations live in
`docs/architecture/ghostty-resource-efficiency.md`.

The release gates and current verification evidence are in
`docs/architecture/ghostty-release-readiness.md`. Automated checks alone do not
establish production readiness, platform parity, or multi-day resource stability.

## Conventions

- **Comments**: default to none, the code should explain itself. If genuinely needed, 1-2 lines on *why*, never *what*. No AI-generic filler.
- **No em-dash** anywhere: code, comments, commits, docs.
- **No emojis** anywhere.
- **Encoding**: text files are UTF-8 without a byte-order mark. Write control characters as escapes (`\x00`), never as raw bytes: one raw byte makes git and ripgrep treat the whole file as binary. `src/app/source-encoding.test.ts` enforces both.
- **Imports**: always `@/...` on the frontend, never relative across modules.
- **Bun only**, never npm/npx/pnpm/yarn. Invoke package binaries through `bun run <bin>` (`bun x` does not apply `bunfig.toml`'s `[run]` settings and falls back to Node).

## Architecture

### Two-process model

**Rust (`src-tauri/`)** owns all OS access. The webview never touches the FS, processes, or shells directly - everything goes through `invoke()` calls to commands registered in `src-tauri/src/lib.rs`:

- `pty::pty_*` - long-lived interactive PTY sessions (portable-pty ↔ Ghostty), managed by `PtyState` (`RwLock<HashMap<id, Session>>`). Output streams over the `oarlock-pty` multiplexed pull stream (hub thread, `pty_stream_open`, `pty_set_presentation`); input goes through a per-session writer thread.
- `fs::tree::*` (`fs_read_dir`, `list_subdirs`), `fs::file::*` (`fs_read_file`, `fs_write_file`, `fs_stat`, `fs_canonicalize`, `fs_open_default`, `fs_host_path`: the host path a WSL file is read through, for asset URLs), `fs::mutate::*` (`fs_create_file`, `fs_create_dir`, `fs_rename`, `fs_move`, `fs_delete`, `fs_delete_batch`), `fs::copy::fs_copy`, `fs::clipboard::fs_clipboard_paths`: file explorer + editor IO. `fs_write_file` replaces a file atomically (temp file in its folder, then rename) and writes through a symbolic link to its target, keeping the link and the target's permissions; a dangling link is an error, never a new file. `fs_write_file`, `fs_create_file` and `fs_create_dir` keep the project trust (`project_trust::keeping_trust`): when the change lands in an item of a project a window has open (its `AGENTS.md` or `.mcp.json` written or created, or a file or folder made inside its `.claude/skills` or `.oarlock/skills`) and the user allowed what the item held (or it held nothing), the item as the change leaves it is allowed too, so Oarlock's own edits (the editor's save and autosave, New File and New Folder, the AI's approved or auto-approved writes and folders, plan mode's Apply, `/init`) do not ask again; no other command does this. Every file command that takes a path from the page reads, writes, lists, stats, searches and watches only inside the folders the workspace registry authorizes (or anywhere while its caller's "access all folders" switch is on, see `workspace::*`), judged on the real path (links followed, `..` resolved, a WSL path by its host path), through the registry's gates: `authorized_existing` (read, list, stat, search roots, `fs_canonicalize`, `fs_host_path` for WSL), `authorized_write_target` (`fs_write_file`: a link is followed to its file, a dangling one is an error), `authorized_new` (create: the nearest existing ancestor is authorized and every name below it is plain, so neither a link nor `..` leads out) and `authorized_entry` (rename, delete, move, copy sources: the entry itself, in an authorized folder, never `..` or a root). A missing path outside reads as outside, so a refusal never tells whether it exists; relative paths are refused. Watched files need an authorized folder; `lsp_resolve_root` looks for plain-named markers in authorized folders only. `fs_open_default` (Open in Default App in the explorer, its search and the editor's placeholder for files it cannot show) hands the OS only an existing file whose real path lies in an authorized workspace. A document opens at once; for a file the OS would run as a program (`fs::launch`, judged on the real path per OS: Windows by extension, such as `.exe`, `.bat`, `.ps1`, `.js`, `.lnk` or `.reg`; macOS by the execute bit, a Mach-O header, `.app`, `.command`, `.pkg` and the like; Linux by the execute bit, an ELF header, `.desktop`, `.AppImage` or `.sh`; Windows programs everywhere, for Wine) the backend first shows the OS's own dialog (`fs::run_prompt`: a warning naming the file and saying it runs as a program, Cancel and Run, attached to the calling window: an `NSAlert` sheet on macOS, `TaskDialogIndirect` on Windows, a `GtkMessageDialog` on Linux), awaited without holding the main thread or a worker, one at a time; Return presses Cancel on every platform (and Escape or closing cancels), so running takes a deliberate click on Run, and the file opens only on Run, so nothing in a page can approve it. tauri-plugin-dialog cannot choose the default button, and swapping its labels is unsafe (it reports a dialog closed any other way as its second button), hence the native dialogs. The command answers `opened` or `cancelled`. File paste captures the workspace and root before clipboard IPC. AppKit and GTK clipboard requests run on the main thread; Windows clipboard retries and filesystem copies run on blocking workers. `fs_copy` requires an authorized root, stages each item and publishes with a no-replace rename, and returns `{ created, failed }` with paths in the caller’s workspace representation. Conflict renaming uses `name copy N` siblings. Symbolic links are preserved without traversing them; copying a folder into itself is rejected. Explorer refresh and pasted selection ignore completions from an obsolete workspace.
- `fs::search::*` (`fs_search`, `fs_list_files`), `fs::grep::*` (`fs_grep`, `fs_grep_interactive`, `fs_glob`): fuzzy file finder + content search (powered by `ignore` + `grep-*` crates). File lists are cached per root in `fs::index` (packed buffer, at most two roots, 45 s TTL) and dropped by watcher events and our own mutations, so a keystroke ranks the cached list instead of re-walking the tree (a change reported during a cold walk marks that walk stale: its result is returned but not cached). Interactive searches bump a `fs::supersede` generation when the command is dispatched, so the walk of an older query stops while a newer one starts; `fs_grep_interactive` keeps one generation per caller (`GrepChannel`: the palette, the sidebar's Search view), so one never cuts the other's results short. Every command that touches the disk is `async` and runs on the blocking pool (`fs::blocking`): Tauri runs a plain command on the main thread, and the async runtime has two workers (`modules/runtime.rs`), so nothing blocking may run inline in an `async fn` either.
- `git::commands::*`: full source-control surface (`git_status`, `git_diff`, `git_diff_content`, `git_file_base`, `git_stage`, `git_unstage`, `git_discard`, `git_commit`, `git_undo_commit`, `git_commit_on_remote`, `git_fetch`, `git_pull_ff_only`, `git_push`, `git_log`, `git_show_commit`, `git_commit_files`, `git_commit_file_diff`, `git_panel_snapshot`, `git_resolve_repo`, `git_remote_url`, `git_list_branches`, `git_checkout_branch`, `git_worktree_add`, `git_worktree_remove`, `git_discover_repos`). All gated through the workspace authorization registry. Switching branches uses `git switch`, never `git checkout <name>`, which restores a file of that name (discarding its changes) when the branch has gone. Every branch name a command takes passes one rule (`utils::validate_branch_name`: git's `check-ref-format --branch`, which refuses a leading `-`, and never `@`). Worktrees (`git/worktree.rs`): `git_list_branches` returns the local branches, each with the other worktree that has it checked out, and `git worktree list` (main first, the current one, locked and missing ones marked). `git_worktree_add` checks out a new branch (from HEAD or a chosen commit) or a local branch no worktree has, in a full path whose parent exists and that is absent or an empty folder, never a link (default `<repository folder>-<branch>` beside the main worktree, the branch made folder-safe); git gets the folder and commit after `--`, and the new folder is authorized in the registry. `git_worktree_remove` never removes the main worktree, the one it runs in or a locked one; unforced, it counts uncommitted and untracked entries and returns them instead of removing; then it runs `git worktree prune` (a folder deleted by hand is only pruned). Both use the 180 s timeout (checkout hooks and LFS filters; deleting ignored folders). The repository lookup (`git_panel_snapshot`, `git_resolve_repo`) reads `rev-parse --show-toplevel --absolute-git-dir --git-common-dir` in one run and reports `linkedWorktree` (its folder and repository names) when the git directory is `<common dir>/worktrees/<id>`. `git_status` asks git for `--untracked-files=normal` (one `dir/` entry per untracked directory) and expands small untracked directories back into files with a bounded `git ls-files --others` (500 files and 16 directories per refresh, listing abandoned at a 256 KiB cap); a directory over budget stays collapsed as `dir/`, which stage and discard handle natively. Stage, unstage and discard hand git their paths in batches that fit one command line (16 KB of paths on Windows, whose command lines stop at 32,767 characters; 256 KB elsewhere), so Stage All on a large deleted folder still runs. Git runs with a 30 s timeout (network commands 120 s; `git_commit` 180 s, since commit hooks and signing run inside it). On Unix each git leads its own process group, and a timeout sends the group SIGTERM, then SIGKILL after 2 s (`proc::capture::OnTimeout::TerminateGroup`), so git removes its lock files (`index.lock`) and the hooks it started stop with it; Windows still kills git alone.
- `shell::shell_run_command`: one-shot subshell exec used by AI tools (bounded `proc::capture`: two short reader threads, no wait on pipes a backgrounded grandchild keeps open). Distinct from PTY sessions; not the user's interactive terminal. On Windows via the configured shell (PowerShell `-NoProfile -Command` or `cmd /C`), in WSL via `sh -lc`, on Unix via `/bin/sh -c`. Shared helper `build_oneshot_command`. On Unix the command leads its own process group, and a timeout sends the group SIGTERM, then SIGKILL after 2 s (`OnTimeout::TerminateGroup`, as for git), so what it started stops with it.
- `shell::shell_session_*`: persistent agent shell with state across calls. `shell::shell_bg_*` (`spawn`, `logs`, `kill`, `list`): long-running background processes (dev servers etc.) with bounded ring-buffer log capture. Kill stops the managed group/job (programs must remain in foreground mode), so a dev server does not outlive its shell and keep its port: on Unix each process leads its own group (SIGTERM, then SIGKILL after 2 s), on Windows it gets a `proc::job::ProcessJob`. All are killed on `RunEvent::Exit`.
- `workspace::*`: `workspace_authorize` / `workspace_current_dir` (the authorization registry behind every file command, spawn cwd, git and the AI tools; `watch_roots` reports each new root, which `asset_scope` grants to the asset protocol) plus the WSL bridge (`wsl_list_distros`, `wsl_default_distro`, `wsl_home`). `workspace_authorize` makes a folder a root (a terminal's cwd, Open Folder, a restored space), or with `opened` (`folder` or `file`) lets the file commands reach what the user opened: the folder, or the folder a file is really in, unless an authorized folder already covers it (no new root, so no new asset grant). The page authorizes only what the user chose (`src/modules/workspace/authorize.ts`: opening a file from the explorer, its search, the content search, a terminal link, LSP navigation or the New File dialog; expanding a folder in the explorer; dropping or pasting files into it, their folders as host paths; restoring a window's spaces), and a read, listing or watch of that exact path waits for an authorization in flight (`authorizationSettled`), as does a git command on it (`gitOnPath` in `native.ts`: the folder a terminal just moved to, an open file). Never a path a terminal program or an AI reply named on its own: the AI tools are refused outside the authorized folders, and `oarlock open` already requires an authorized file. Launch arguments, a later launch and macOS Open With authorize each file's folder in the backend (`second_launch::authorize_launch`). A terminal's cwd from OSC 7 is authorized as a root only through `pty::pty_authorize_cwd`: on Linux and macOS the reported folder, resolved, must be exactly the folder the OS reports for the pane's shell (`/proc/<pid>/cwd`, `proc_pidinfo` `PROC_PIDVNODEPATHINFO`) or for its foreground process group leader (a nested shell), or nothing is authorized (`pty/cwd.rs`); Windows (WSL panes included) cannot read another process's folder cheaply and authorizes the report as before. The page takes a report as the terminal's folder only when that call says so (`terminal/lib/terminalCwdReports.ts`: one check at a time per terminal, the latest of a burst, no request for the folder already taken), so an unmatched report, such as one `cat` of a crafted file prints or a remote shell sends, changes neither the tab's folder nor anything that would authorize it later (a new tab or restart there, a restored window). Native revisioned preferences hold the two Settings switches (General, Folder access; both off, "At your own risk"): "Allow the app to access all folders" opens the app's own file features (explorer, editor open and save, previews, search, watching, block path completion, Open in Default App) and "Allow AI tools to access all folders" the AI tools, each alone. Commands both use take an `origin` (`app` when left out; `ai/lib/native.ts` sends `ai` on every file and shell call of the AI tools) and take their gates once (`registry.gates(origin)`); a switch authorizes no root, so git, language servers, terminal folders, `oarlock open` and the other side keep the authorized folders. The native preferences owner initializes and updates both gates from committed values; `workspace/allFolders.ts` only mirrors them for UI subscribers. No page command can independently set a gate. While the app's switch is on, previews load through the `oarlock-asset` scheme (`asset_all_folders.rs`), which asks the switch on every request and never serves a dot name; the asset protocol's grants are never widened (`docs/architecture/security-model.md`).
- `lsp::*` (`lsp_detect`, `lsp_host_pid`, `lsp_resolve_root`, `lsp_spawn`, `lsp_send`, `lsp_kill`): language server process host. Dumb JSON-RPC pipe: Content-Length framing + process lifecycle in Rust (`lsp/framing.rs`, pure + tested), protocol intelligence on the frontend. Spawn cwd gated through the workspace registry; binaries resolve via the env of the shell new terminals run, interactive and login: the shell set in Settings (an enumerated one, as for the terminal) else the user's login shell, captured once per shell (`lsp/env.rs`: GUI apps get a bare PATH on macOS, and PATH set in an interactive rc file such as nvm's exists only there; the shell runs in its own session with `OARLOCK_RESOLVING_ENVIRONMENT=1`, `env -0` is read between markers, a login-only capture is the fallback, and a configured shell that yields nothing falls back to the login shell). A relative command (a path separator or a leading `.`, such as a custom server's `./node_modules/.bin/x`) is the project's: it resolves in the root the server runs in (`env::is_relative_path`, `resolve_binary`), never in Oarlock's own working folder, and `lsp_detect`, which has no project, reports it as written. Changing the shell forgets every binary lookup and lets enabled servers without a session try again (`resetDetections`); running servers keep their environment. Windows inherits the full user environment and captures nothing; root detection walks up to markers but never to or above `$HOME`. Servers run in their own process group on Unix and are group-killed (cargo check / proc-macro children die with the server); Windows children get a `proc::job::ProcessJob` (kill-on-close, shared with pty). All sessions killed on `RunEvent::Exit`.
- `mcp::*` (`mcp_spawn`, `mcp_send`, `mcp_kill`, `mcp_http_open`, `mcp_http_close`, `mcp_http_stream`, `mcp_http_cancel`, `mcp_http_ack`, `mcp_logs`, `mcp_logs_clear`, `mcp_log_note`, `mcp_status_report`, `mcp_status_list`, `mcp_secret_set`, `mcp_secret_delete`, `mcp_secret_status`, `mcp_oauth_status`, `mcp_oauth_probe`, `mcp_oauth_sign_in`, `mcp_oauth_cancel`, `mcp_oauth_sign_out`, `mcp_import_scan`, `mcp_import_secrets`, `mcp_project_servers`, `mcp_project_spawn`, `mcp_project_http_open`): MCP servers' process host and network gate; the protocol lives in the page (`src/modules/mcp/`). Local (stdio) servers, modelled on the LSP host: newline-delimited JSON-RPC (`mcp/framing.rs`: one message per line, 16 MiB at most, a longer one stops the server with that reason, a line that is not JSON goes to the log), stderr into a bounded log per server id (`mcp/logs.rs`: 2,000 lines, 512 KiB, 64 servers, lines cut at 2 KiB and stripped of control characters; it outlives the process so Settings can show why it died), exit reported with code, signal and the stderr tail. A server leads its own process group on Unix and stopping it closes stdin, then sends SIGTERM to the group after 1 s and SIGKILL after 2 more (the MCP stdio shutdown); Windows holds the tree in a `ProcessJob`. Binaries resolve through the shell environment the language servers get (`lsp::env`, the terminal shell set in Settings), so `npx`, `uvx` and `docker` are found from a GUI launch; the capture marker is removed and `workspace::child_env_overrides` applied. A relative command (`./serve.sh`, `bin/serve`: a path separator or a leading `.`) is found in the server's working folder (a project server's project folder; `stdio::resolve_program`), never in Oarlock's own; a Settings server without a working folder refuses one with an error saying to set it. Remote servers (Streamable HTTP, legacy SSE): `mcp_http_open` resolves the configured URL once (http or https, no user info, no metadata host) and allows private addresses only when that host is local or private, so a public host can never be moved onto the user's network by DNS; each request (`mcp_http_stream`, the AI proxy's packets and credit, its own budget of 128 requests) must stay within that origin (`mcp/http.rs` `within_origin`: same scheme, host and port, or the https form of an http URL on default ports), goes through `net.rs` classification and DNS pinning (client profile `Mcp`, never following redirects: the SDK follows only those within the origin, each a new checked request), and a response that is not an event stream is capped at 32 MiB. Secret values (environment variables and headers marked secret) live in the keychain under the service `oarlock-mcp` (`<server>/env/<NAME>`, `<server>/header/<name>`), written by Settings (`mcp_secret_set`, the settings window only) and read only here, when a server starts or a session opens: `secrets_get` and `secrets_get_all` refuse that service, so no page reads them back. Sessions belong to the window that opened them (spawn and requests from app windows only) and end when it reloads or closes; every server is stopped within a bounded time on `RunEvent::Exit`. Servers run with the user's rights and outside the workspace registry: a working folder is any existing absolute path (home by default). OAuth sign-in (`mcp/oauth/`, MCP authorization revision 2026-07-28) runs here, never in the page: a server is "sign in required" after a 401 with a `Bearer` challenge (or a refused token the backend could not refresh, which it marks with `x-oarlock-sign-in: required` so the client waits instead of reconnecting) or when it publishes protected resource metadata (Settings probes enabled remote servers once); `mcp_oauth_sign_in` (settings window only, as are cancel and sign-out) discovers the protected resource metadata (challenge URL, else RFC 9728 well-known path then root; `resource` must name the server) and the authorization server's RFC 8414 / OpenID Connect metadata (issuer checked, S256 PKCE required), uses the client the user configured or registers one (RFC 7591, public native client, kept per issuer and redirect URI), opens the system browser (opener plugin) at the authorization URL (PKCE S256, `state`, RFC 8707 `resource`, scopes from the challenge, the metadata or the configuration, plus `offline_access` when offered) and waits up to five minutes on a one-shot `127.0.0.1` listener at `/callback` (RFC 8252; only the request with its `state` is taken; the RFC 9207 `iss` is checked), then exchanges the code. Every sign-in request goes through `oauth/fetch.rs` (https only, loopback http only for a loopback http server, `net.rs` classification and pinning, same-origin redirects on GETs only, 1 MiB, 30 s) to URLs the metadata names. Tokens and registrations live in the keychain (`<server>/oauth/tokens`, `<server>/oauth/client`, one JSON record each, split on Windows by `secrets` like any long value), bound to the server URL; `mcp_http_stream` adds `Authorization: Bearer` (unless the configuration sets `Authorization`), refreshing a minute before expiry and once on a 401. Import (`mcp/import.rs`, settings window only) reads exactly Claude Desktop's `claude_desktop_config.json`, `~/.claude.json` (user `mcpServers`, streamed), `~/.cursor/mcp.json` and VS Code's `User/settings.json` (`mcp.servers`) and `User/mcp.json` (JSON with comments, `inputs`) and returns parsed entries with secret-looking values withheld; `mcp_import_secrets` writes those to the keychain after checking each entry's fingerprint. A project's `.mcp.json` (`mcp/project.rs`, Claude Code's format) is a project trust item; `mcp_project_servers` lists its servers for the calling window's project (Settings: every open project) only while the file is allowed, and `mcp_project_spawn` / `mcp_project_http_open` start one from the file itself, expanding `${VAR}` and `${VAR:-default}` from the shell environment, in the project folder with `CLAUDE_PROJECT_DIR`; every message and request checks the window still has the project open, the user allows the file's current content, and that content declares the server exactly as it started (`project::still_allowed`: an allowed edit elsewhere in the file keeps it running; a change to its own entry, or content the user has not allowed, stops it).
- `skills::*` (`skills_list`, `skills_load`, `skills_read_file`, `skills_set_enabled`, `skills_create`, `skills_edit`, `skills_delete`, `skills_install_git`, `skills_install_zip`, `skills_install_commit`, `skills_install_cancel`) and `project_trust::*` (`project_trust_status`, `project_trust_decide`, `project_trust_list`, `project_trust_revoke`) with `project_memory::project_memory_read`: Agent Skills (see AI subsystem) and the shared project trust. Skills come from Oarlock's skills folder (app config `skills/`), `~/.claude/skills` and an open project's `.claude/skills` and `.oarlock/skills`; a project item is used only while its record (`project-trust.json`, per project folder: each item allowed or declined with the SHA-256 of its tree) allows its current content, checked on every call. File digests are cached per path and reused only while the file keeps its size, modification time, change time and inode (Windows: change time) and only once it was three seconds old when read, so a same-length edit within a coarse timestamp, or with its modification time restored, is read again. A skill is read only by these commands, inside its real folder (`skills/files.rs`: plain relative names, links only to files inside, 1 MiB text), outside the workspace registry's gates. On/off state is the backend's (`skills-state.json`). A watcher over the skill folders (FSEvents on macOS, notify elsewhere; a missing folder through its parent) emits `skills:changed` only when the listing or a trust state changed; `project-trust:changed` follows decisions and a window opening or leaving a project. Installs stage in `skills/.install-<token>` (Git: shallow clone through `run_git`, https and ssh only; zip: the user picks it in the backend's dialog, plain names, no links, size and entry caps), validate every skill found and move the picked ones into place. Each kind of project content is an `ItemKind` with its own inspector: `AGENTS.md` (`project_memory.rs`: its size, line count and first lines as plain text and the file's SHA-256, read in chunks, so any size; not UTF-8 text, a NUL byte, not a regular file or a link out of the project: not usable; empty: nothing to ask), the skill folders' tree hash (`skills/`), and `.mcp.json` (`mcp/project.rs`: each server's command line or URL and the variables it reads, the file's SHA-256, 1 MiB at most); the watcher follows each file through its folder. Oarlock's own changes keep an answer (`keeping_trust`, see `fs::*`): under one lock, the item is read from its bytes before the change (never a kept digest), the change is made, and the item as that reading plus the bytes written leaves it is recorded as allowed, checked again under the store's lock, when the previous content was allowed or held nothing (absent, blank, a `.mcp.json` without servers, a skills folder of folders only); so a write by anyone else meanwhile, or untrusted files already in a skills folder, still ask. Content Oarlock wrote that cannot be used (a half-typed `.mcp.json`) is recorded too, so the next save keeps the answer; it is never used. The model gets `AGENTS.md` only from `project_memory_read`, which reads it once and returns it only for the calling window's open project (the page's workspace must be that project), inside the folders the AI's file tools reach (the workspace registry's gates, origin `ai`), and while the decision allows the hash of exactly the bytes it returns: the whole file, with no size limit, or only its size when it is larger than the page's `limit` (the most the run's model could take). Details in `docs/architecture/security-model.md`.
- `clipboard_image::*` (`clipboard_image_read`, `clipboard_image_write`): clipboard images for the Kitty clipboard protocol (and an image pasted into the AI composer that the webview did not hand over), as PNG both ways (raw IPC bodies, 64 MiB cap), through the clipboard plugin's long-lived clipboard so a written image stays served on X11 like text. A read with no image answers an empty body; a written PNG is decoded with limits (16,384 pixels a side, 512 MiB decoded) before it reaches the clipboard. Both run on blocking workers.
- `system_fonts::system_font_faces`: an installed family's faces (file, weight, style, stretch) for terminal font features and, on macOS, for fonts the user installed, from a `fontdb` database built on first use and rebuilt when a family is missing (at most every 10 s); collection members past the first are left out, at most 64 faces.
- `primary_selection::*` (`terminal_primary_selection_write`, `terminal_primary_selection_read`): the Linux PRIMARY selection for copy-on-select and middle-click paste, through `arboard` (X11, or Wayland data-control). Two long-lived clipboards, created on first use: the writer keeps the X11 selection served after the call returns and drops a write overtaken by a newer one, the reader is separate so a read stuck on an unresponsive owner never blocks writes (one read at a time). 4 MiB cap both ways; an empty write leaves PRIMARY alone. macOS/Windows: write is a no-op, read returns `None`.
- `terminal_scrollback::*` (`terminal_scrollback_save`, `terminal_scrollback_load`, `terminal_scrollback_retain`): saved terminal scrollback, one file per pane key (`[A-Za-z0-9_-]{1,128}`) under the calling window's data root (the app data dir for `main`, `windows/<label>/` for another), so a window's `retain` never sees another's files. Raw UTF-8 bodies (key in the `x-oarlock-scrollback` header, 8 MiB cap, empty deletes), replaced atomically through a temp file (0600 on Unix) and never through a link; `retain` deletes every file it is not given, temp files included, and refuses an implausibly long list rather than truncate it. One gate serializes all three. See spaces/ below.
- `net::*` (`ai_http_stream`, `ai_http_cancel`, `ai_http_ack`, `lm_ping`, `image::markdown_remote_image`): AI HTTP proxy with SSRF guard; keeps provider calls and local-model pings off the webview. `markdown_remote_image` fetches one https image for the Markdown preview (public addresses only, every redirect hop validated and classified again, `image/*` only, 16 MiB) and answers `[u8 type length][type][bytes]`. Native AI redirects remain within the original scheme, host and port, including for local/custom endpoints; refused redirects return an error directing the user to configure the final URL. All guarded native clients use direct connections (`no_proxy`), ignoring inherited and OS proxies because proxy-side routing bypasses address pinning. Proxy-only networks are unsupported for these routes. Clients are cached per `(profile, host, pinned IPs, allow_private)` with a 90 s idle TTL and at most eight entries, so connections and HTTP/2 sessions are reused while DNS-rebinding protection stays per request. Classification (`net/ip.rs`) looks through IPv6 forms that carry an IPv4 destination (mapped, compatible, NAT64, 6to4, Teredo) and treats everything outside global unicast as non-public.
- `secrets::secrets_*`: OS keychain via `keyring-core` (macOS Keychain, Windows Credential Manager). Plain values keep the `keyring` 3 layout and the production service `oarlock-ai`; Linux keeps its file fallback. Pages may name only the exact `oarlock-ai` service, never MCP services or aliases, chunk accounts, or account names containing NUL. This closes Windows case-insensitive target aliases and account/service delimiter aliases. Values are bounded to 32 KiB of UTF-8. Windows' 2,560-byte UTF-16 item limit uses staged generations (`secrets/generations.rs`): chunks under `<account>:gen:<slot>:<index>`, with two reusable slots, then one published `\x01oarlock-chunks:g:<slot>:<count>:<digest>` head. A failed staging or head write preserves the previous readable value; the old generation is retired only after publication. The legacy inline head and numbered chunks still read without migration writes; plain replacements remain readable by older versions, while older readers reject generation heads as unknown. Reads verify the digest and reject missing/mixed chunks. Short writes need no staging; macOS and Linux retain their single-item layout. Deletion removes the head first, preserving the complete old value if that fails, then retires both bounded slots and legacy chunks, including gaps from interrupted writes. Cleanup errors are logged after commitment and cannot turn success into a failed save/sign-out; they can leave bounded unreachable items until reuse or a later deletion. All operations hold the per-process secret lock; profile ownership prevents normal concurrent app processes from sharing accounts.
- `open_settings_window`: separate webview window for Settings (optional `tab` arg deep-links a section). It is a child of the window it opens over (owned on Windows, transient on Linux), which keeps it above that window, and never always-on-top, which would float it over every other app.
- `quick_terminal::*` (`quick_terminal_toggle`, `quick_terminal_set_hotkey`): the quick terminal, a borderless always-on-top `quick` window (`quick.html`, `src/quick/`) holding one terminal. It is created on first use and kept, so its shell survives hiding; each show places it across the top of the work area of the monitor under the pointer at 40 % height (never restored by window-state). The hotkey (`terminalBehavior.quickTerminalHotkey`, off by default, one of a fixed list) is registered process-wide through `tauri-plugin-global-shortcut` from the main window (`terminal/quick/quickTerminalHotkey.ts`); a refused hotkey (taken, or Wayland without global shortcuts) is reported. The page hides the window when its shell exits (the next show starts a new one in the home directory) and, with `quickTerminalAutohide`, when it loses focus. It is not a child window, so the last app window's destruction destroys it (`windows.rs`). `pty_close_all` reaps only the calling window's shells.
- `windows::*` (`app_window_open`, `app_window_ready`, `app_quit`, `app_quit_ready`): app windows. `main` comes from the config; New Window (File menu on macOS, Cmd/Ctrl+Shift+N, the palette) opens `w-<n>` (lowest free number, so the window-state plugin keeps at most 32 entries) a step from the window it came from, its first terminal in that window's directory (`?cwd=`). Each window has its own spaces store (`windows/<label>/oarlock-spaces.json`; `main` keeps `oarlock-spaces.json`), scrollback root and active chat (`activeId:<label>` in the chat store; the history list is shared and every window follows its changes, and a window never reuses an untitled chat another has open). The windows open at quit are listed in `oarlock-windows.json` and reopen at launch; when `main` had been closed it takes over the first listed window's files, so the same windows come back. Closing a window while others stay open discards it (state files, list entry, chat key; its label is not reused until the files are gone); closing the last one quits and keeps it. The macOS menu bar is built whole (`app_menu.rs`, never by editing `Menu::default` in place): the app menu ends with our guarded Quit, and File holds New Window, Close Tab (Cmd+W: the window in front closes its active tab or pane through `oarlock:close-tab-requested`, which also works while a preview frame has the keyboard and the page never sees the key; Settings and the quick terminal close instead) and Close Window (Cmd+Shift+W, through the same close guard as the close button). Quitting (Cmd+Q, "Quit Oarlock") asks each window that answers (`app_window_ready`, set once its page listens; a page that reloads or closes while asked counts as agreeing) in turn, the focused one first, to confirm running commands and unsaved files and save its chat, scrollback and spaces (`oarlock:quit-requested`, answered by `app_quit_ready`); any cancel stops the quit, and only after every answer does Oarlock exit with all windows kept. Settings opens over the window in front and closes with it; "Open With" files and control requests without a calling pane go to the window in front. A later launch of Oarlock (Open in Oarlock, `oarlock <dir>`, a launcher) starts no second process on the same state files: `tauri-plugin-single-instance` (every build, with a separate development identifier) passes its arguments and directory to `second_launch.rs`, which opens its files in the window in front, a folder in a new window (`?folder=`), else a new window in the launch's directory (`?cwd=`, when usable). A folder macOS opens in Oarlock (Open With, dropped on the Dock icon) is the main window's launch folder until that window has read it, a new window after. A window opened during the session comes to the front when it first shows. Shells get app-wide pane ids (`OARLOCK_PANE_ID`), which the control server maps back to their window and pane, so `oarlock` commands act on the window they run in. File watches are owned per window and given back when it closes or reloads.
- `vibrancy::window_*`: native window backdrop (`window_backdrop_kind`, `window_set_backdrop`, whose `see_through` keeps a macOS window see-through without a backdrop, for translucent terminals). macOS gets `NSVisualEffectMaterial::UnderWindowBackground`, Windows 11 gets Mica (gated on build >= 22000 via `RtlGetVersion`, since `apply_mica` fails on Windows 10), Linux reports `none` because blur there belongs to the compositor. The `window-vibrancy` crate is a macOS/Windows-only dependency so Linux builds never pull it.
- `mac_privacy::*` (`mac_privacy_status`, `mac_privacy_open_settings`; macOS only): what macOS privacy controls (TCC) let Oarlock reach. TCC counts Oarlock and every program its terminals start as one app. Full Disk Access is the only grant an app can test without macOS asking: `mac_privacy_status` opens files only that grant opens (the user's TCC database, then the system's: TCC guards them on every release, and a file whose protection might change would read as allowed if it did; nothing under `~/Library/Containers`, where other apps' data asks) and the first one that tells decides (`EPERM` is refused, opened is allowed, anything else is inconclusive). Desktop, Documents, Downloads, iCloud Drive and removable and network volumes are asked about the first time Oarlock opens them, so their own switches are never probed. `mac_privacy_open_settings` opens Privacy & Security at a named pane (`fullDiskAccess`, or `filesAndFolders`, where System Settings lists every folder and volume switch of an app; the per-folder anchors are left from System Preferences); the page never passes a URL. On macOS `fs_search` and `fs_grep_interactive` report a root the privacy controls refuse to list (`EPERM`, `fs::privacy_refused_root`), which their walk would otherwise skip and answer as nothing found.

### PTY shell integration

PTY shells are bootstrapped via injected init scripts in `src-tauri/src/modules/pty/scripts/`:

- **Unix** (`zshenv.zsh`, `zprofile.zsh`, `zlogin.zsh`, `zshrc.zsh`, `bashrc.bash`) for zsh/bash, plus a profile-specific `init.fish` loaded by fish’s `-C` after user configuration. Fish no longer installs a global conf.d file. An exact unmodified legacy snippet is moved to a non-autoloaded `.disabled` backup; edited files and symlinks are preserved. Emit OSC 7 (cwd) and OSC 133 A/B/C/D (prompt boundaries + exit code) so the host can track cwd and detect command boundaries without re-parsing the prompt. Fish 4.0+ writes its own OSC 133 prompt markers; Oarlock sets `fish_features=no-mark-prompt` and loads its prompt hooks via `-C` to avoid doubling. Startup suppresses legacy conf.d hooks before loading the chosen profile, preserves user greeting/prompt configuration, and does not auto-install hooks into nested fish shells. The zsh wrappers source each user file under the user's own `ZDOTDIR` (one their `.zshenv` sets included) and move a `HISTFILE` derived from the wrapper directory to the user's, so history and `$ZDOTDIR`-relative config behave as in any terminal.
- **Windows** (`profile.ps1`) - passed via `pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File <path>`. Wraps the user's existing `prompt` function (after their `$PROFILE` runs) to emit OSC 7 + OSC 133 A/B/D. Shell priority: `pwsh.exe` (PS 7+) → `powershell.exe` (PS 5.1) → `cmd.exe`. cmd.exe runs `profile.cmd` with `/k` (after AutoRun), which wraps `PROMPT` in OSC 133 D/A, OSC 7 (`$P`, unencoded, which `parseOsc7` reads as is) and OSC 133 B; with no preexec hook it marks `oarlock_blocks=0`, so block tabs keep its prompt. A breadcrumb `cd` is written for the pane's shell (`cdCommandLine`: `cd /d "..."` for cmd.exe). cwd is normalized to backslashes before being passed to ConPTY (`CreateProcessW` misbehaves with forward-slash cwd).

`pty/shell_init.rs` is split into `#[cfg(unix)]` / `#[cfg(windows)]` modules - keep new platform-specific code in the right cfg arm.

Shells advertise `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=oarlock` and `TERM_PROGRAM_VERSION=<app version>` (the XTVERSION reply is `oarlock <version>`; WSL gets them through `WSLENV`). The identity of whatever terminal launched Oarlock (Ghostty, iTerm2, kitty, WezTerm, VS Code, tmux, a parent Oarlock, ...) is removed first by the pure `pty/terminal_env.rs`; user configuration never is. Details in `docs/architecture/pty-shell-integration.md`.

ConPTY on Windows requires `CONPTY_LIFECYCLE_LOCK` (Mutex) around `openpty + spawn_command` in `session.rs`. Concurrent spawns leave one of the resulting PTYs with a stalled output pipe. Don't remove the lock without verifying first-tab stability under fast tab spam. The lock must never be held across anything that waits on the frontend: the waiter lets the reader overdraft the output queue (`close_pseudoconsole`) before taking the lock for `ClosePseudoConsole`, so a backlog the page has not acknowledged cannot stall other `pty_open` calls.

Each ConPTY child is also assigned to a per-session **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`proc/job.rs`, shared with the LSP host). When the Job HANDLE drops - clean shutdown, panic, or even SIGKILL'd Oarlock process - the kernel kills every descendant of the shell (e.g. `npm run dev` spawned from inside pwsh). Without this Windows orphans the entire process subtree because `TerminateProcess` only kills the immediate child. macOS/Linux rely on `Drop for Session → killer.kill()`; on dev-`Ctrl-C` of `cargo run` destructors don't fire and orphans are possible there too - acceptable for now since dev only.

`AiComposerProvider` is mounted unconditionally at the App.tsx root: a conditional wrapper would change the parent element type when keys load, remounting the entire tree (and re-spawning every PTY) the moment `getAllKeys()` resolves. Production happened to dodge this because keychain reads can land in the same paint frame; dev didn't. Keep the unconditional wrap.

### Frontend (`src/`)

Single-window React app. Path alias `@/*` → `src/*`. Tabs are a tagged union (`kind`: `terminal` | `editor` | `preview` | `markdown` | `ai-diff` | `git-diff` | `git-history` | `git-commit-file`) and **not** unmounted on switch - they're hidden via `invisible pointer-events-none` so PTYs and dev servers keep streaming in the background.

`App.tsx` wires modules together - keep it a coordinator. New features go inside the appropriate `modules/<area>/`.

### Module layout (`src/modules/`)

Each module is self-contained, exports a thin barrel via `index.ts`, and owns its hooks under `lib/`.

- **terminal/** - `TerminalStack` keeps live leaves mounted. `useGhosttyTerminalSession` owns one persistent model and PTY per leaf; GPU/WebGL surfaces lease shared presentation resources independently. `terminalSessionApi.ts` exposes renderer-neutral product actions. OSC 7 paths and OSC 52 payloads are validated by pure parsers, and an OSC 7 folder is taken only after the backend checked it against the shell (`TerminalCwdReports`, see `workspace::*` above); Ghostty supplies OSC 133 events and native command anchors to the lazy block controller. WebGPU can fail over to WebGL without replacing the model, PTY, selection, search, or block history. Hidden models keep parsing through bounded PTY transport while presentation is released. There is no snapshot replay or second terminal parser. Theme colors come from the central theme engine. Restart terminal (command palette; `terminal.restart`, unbound by default) ends the active pane's shell and starts a new one in the folder it was last in, through the respawn the error retry uses (same leaf, new model and PTY, status cleared); while a program runs there (`pty_has_foreground_process`) it asks first, as closing the tab does, under the same "don't ask again" setting (`useTerminalRestart`, decision in `terminalRestart.ts`).
- **editor/** - CodeMirror 6 stack (`EditorStack` mirrors `TerminalStack`). The find panel is CodeMirror's rebuilt field for field with the match count after the search field (`lib/searchPanel.ts`). `lib/searchCount.ts` counts only while that panel or the header search listens (`SearchCountHub`, one per pane, outliving its views), keeps the matches of one document and query (stepping between matches is a binary search), stops at 10,000, and scans 32 KiB chunks, 6 ms a task, so a long document never blocks typing. Chunking never changes the count: a string query's chunk reads on by the longest match it can have, a single-line regex is cut between lines, and a regex that can span lines is counted in one pass, only up to 4 MiB; whole-word string matches are judged from the document, not the search buffer. Edits recount at once up to 128 KiB, after 200 ms above. `extensions.ts` configures language modes; supports vim mode. Buffers live in LF space and the original EOL (`lib/eol.ts`, majority-vote detection) is restored on save; indent unit/tab size are detected per file (`lib/indent.ts`) via a per-pane compartment; a file with nothing to detect (new, unindented) uses the Default indentation setting (`editorDefaultIndent`: 2 spaces, 4 spaces or tabs). The view is created a few renders after the document turns ready, after the pane's effects for it ran, so first-load work that needs the view (indent unit, a pending go-to line or focus) also runs from `onCreateEditor`. Editor reads request a content version; `fs_save_document` compares that version under a native per-file transaction and raises a persistent conflict notice with explicit conditional Overwrite. Every failed write (save, autosave, Overwrite) shows a per-file error toast. External format-on-save passes the current buffer through native stdin/stdout formatting, adopts the candidate only while its snapshot remains current, then commits through the same conditional save. Legacy in-place custom commands are unsupported; custom formatters use a JSON argument list for a stdin/stdout program. Document state lives in `lib/documentSession.ts` (IO injected, tested; `useDocument` is its React shell): async reads, checks and writes are dropped once the pane loaded another file or closed, and an explorer rename of an open file (`noteRetarget`) keeps the buffer, dirty state and mtime, so the next save writes the new path. CodeMirror takes its text only at mount; text adopted from disk later is pushed into the view by `syncViewText` (minimal change, cursor and undo survive), since a reload equal to the previous `value` prop never reached the view. A Source Control discard reloads the matching open editors even when dirty (`lib/gitSignals.ts`); edits typed while that read is in flight are kept. A change gutter marks lines added, modified or removed since HEAD (`lib/gitGutter.ts`: `@codemirror/merge` chunks against the committed text, updated incrementally on every edit; the base comes from `git_file_base`, one `git show HEAD:./<name>` in the file's folder, fetched when the file loads, when the pane is shown and after a commit or pull in Source Control, `lib/gitSignals.ts`; off above 4 MB). Images, video, audio and PDFs preview through asset URLs (`useWorkspaceAssetUrl`: a WSL path is mapped to its host path first; the CSP allows `asset:` and both `http(s)://asset.localhost`, since Windows uses `http`, and no remote images, since AI chat Markdown renders in the same webview). The asset protocol serves nothing by configuration (`assetProtocol.scope` allows nothing): `asset_scope.rs` grants each root the workspace registry authorizes, recursively (WSL roots by their host path; the scope's `requireLiteralLeadingDot` keeps its wildcards out of dot names on every platform, where Tauri's default does so only on Unix), and each font face `system_font_faces` returns, so previews work only for files inside authorized workspaces. Files over 10 MB offer "Open anyway" (hard cap 50 MB, `force` arg); binary and oversized files also offer "Open in Default App"; above 4 MB syntax highlighting and LSP stay off. Cmd-F routes to CodeMirror's own search panel (find/replace/regex) when an editor tab is active, Ctrl-G opens go-to-line, as in VS Code (`lib/editorKeymap.ts`: above the search keymap, which binds Mod-G to find-next; off macOS the pane claims Ctrl+G from Source Control, which keeps Ctrl+Shift+G there); both panels styled in `chromeTheme.ts`. Format-on-save formatters live in `lib/externalFormat.ts` (`FORMATTERS` registry: biome, prettier, ruff, rustfmt, gofmt, clang-format, shfmt, zig fmt, plus a custom `{file}` command template); `resolveFormatter` applies per-language overrides (`editorFormatterByLang`) over the global default, and a global external default only runs on languages its tool understands. Diff panes resolve the language before mounting CodeMirror: a late compartment reconfigure leaves the merge view's deleted-chunk widgets unhighlighted. Git diffs render inline (`unifiedMergeView`) or side by side (`SplitDiffView`: a `MergeView` built once and updated in place, so scroll and expanded regions survive a refetch or theme switch) per the `diffViewMode` preference (Settings > Editor, or the toggle in the diff header); both share `lib/diffTheme.ts`. AI inline completion (`lib/autocomplete/`) sends the buffer's indent unit with the request and normalizes unambiguous tab/space mismatches in responses (`normalizeIndent.ts`); triggering is `autocompleteTrigger` auto or manual, with `editor.aiComplete` / `editor.codeComplete` registry shortcuts (guarded to editor tabs so the keys fall through to terminals), and Tab accepts an open completion popup before the ghost. Multi-line ghosts render first-line-inline plus a block widget below the line (never inline `<br>`s); a closers-only line-suffix (cursor inside `fn(|)`) is hidden and re-appended after the block so the preview equals the accept result, and a line-suffix with real code caps the ghost to one line (`capToLineSuffix`). Suggestions echoing the recent prefix are dropped, multi-line suggestions and closing brackets never start on a line that ends with `;`, and closer-only lines are reindented from the previous line (`trimSuggestion`/`reindentClosers`, all tested). Markdown editing is GFM (`markdownLanguage` base) with fenced-code highlighting resolved through the shared lazy language registry, Cmd/Ctrl+Click URLs, and clickable task checkboxes (`markdownExtras.ts`, all inside the lazy markdown chunk; the eager-budget test enforces this). Dotenv files (`.env`, `.env.*`, and `*.env`) use the lazy shell grammar. Editor theme is decoupled from the app theme: the `editorTheme` pref is `"auto" | EditorThemeId` (default `"auto"`), resolved at render time by `useEditorThemeExt` via `resolveEditorThemeId`. In `auto` the editor follows the active app theme's `editorTheme[mode]` pairing (live, never stale); an explicit pick overrides. Theme ids + labels live in `settings/store.ts` (`EDITOR_THEMES`/`EDITOR_THEME_LABELS`); the matching extensions in `editor/lib/themes.ts` (`EDITOR_THEME_EXT`). Prebuilt `@uiw` themes plus locally-built ones in `editor/lib/cmThemes.ts` (Kanagawa wave/lotus/dragon, Everforest, Dracula, Monokai Pro, Solarized, Catppuccin, Rosé Pine) via `createTheme` (no extra deps). The three CM surfaces (`EditorPane`, `AiDiffPane`, `GitDiffPane`) all read the theme through `useEditorThemeExt`.
  Editor code size is stored separately as `editorFontSize` and does not affect `terminalFontSize`.
- **explorer/** - file tree with Catppuccin icons, fuzzy search, keyboard nav, inline rename, context actions. A click previews a file, a double-click keeps it open in its own tab, and F2 or Rename in the context menu renames. Expanding a folder authorizes it first (a link may lead out of every authorized folder); its listing and watch wait for that, a refresh never authorizes, and files dropped or pasted in from the OS have their folders authorized before `fs_copy` reads them. Backslash-aware `basename`. Icons are lazy: `iconResolver.ts` is the startup-safe shell and fetches the ~360 kB set (`iconEngine.ts`) when the first `FileIcon`/`FolderIcon` mounts; until then those components render a same-size blank slot that fades the icon in, and the set is never in either window's startup graph. The tree stays mounted when the sidebar collapses but is `visible={false}`: no native fs watchers (`watchRegistry.ts` disarms them), no `fs:changed` subscription, no drop listener and no reloads; showing it re-registers the watchers and reloads loaded directories once. `fs_watch_add` watches each directory and open file at its canonical path but reports every change (`fs:changed`) in each spelling the frontend registered it under (a WSL `/home/x` or `/mnt/c/x`, a root reached through a link such as macOS `/tmp` or Fedora Atomic `/home`), so the tree and editor tabs match their own keys. The WSL share delivers no change notifications, so its watched directories and the open files in them are re-checked every 1.5 s by a poller (`oarlock-fs-poll`) that starts with the first share directory and sleeps while none is watched. Refresh re-reads the root, every loaded listing and every expanded folder (`lib/refreshTargets.ts`).
- **preview/** - auto-detected dev-server preview tab (status-bar pill suggests opening when a localhost URL is detected). With `terminalLinksInPreview` on (Settings > General > Web preview, off by default), a localhost or loopback link clicked in a terminal opens in a preview tab, reusing the space's tab already showing that page, instead of the browser (`terminalLinkPreviewTarget`, registered through `setTerminalPreviewOpener`).
- **tabs/** - `useTabs` is the source of truth for tab list + active id. A tab the user opens (terminal, file, preview, Markdown, diff, history) goes to the end of the list or, with Settings, General, Tabs, "After the current tab" (`newTabPosition`), right after the active tab; every creation path places it through `newTabInserter` (`lib/newTabPosition.ts`), a reused preview slot keeps its place, and a tab opened in the background or in another space goes to the end. `useWorkspaceCwd` derives explorer root + inherited cwd for new tabs from the active space only: its active terminal, else the terminal last active there, else its terminals, else its root (`spaceExplorerRoot`, `spaceNewTabCwd`). A tab holds as many panes as Settings, General, "Panes per tab" allows (`terminalPaneLimit`, 1 to eight, `MAX_PANES_PER_TAB`, which also sizes the WebGL pool; eight by default). Splitting, "Move to split" and the agent launcher follow it, read when a pane is added (`canSplitPane`); a tab that holds more after the limit was lowered keeps its panes and gets no more. In a split, panes other than the focused one fade toward the terminal background (`terminalBehavior.unfocusedSplitOpacity`, Ghostty's unfocused-split-opacity, 0.7 by default, 1 for off; an overlay in `PaneTreeView`, no renderer work). Live terminals move without restarting: "Move to split" (tab menu) grafts a single-pane terminal tab into another tab's split beside its active pane, "Move pane to new tab" (tab menu, palette) pulls a pane out of a split. Both move the same leaf node within one tab-list update, so the leaf never leaves the live pane trees and its session, scrollback and running program stay (`planMoveTabIntoSplit`, `planMovePaneToNewTab`); agent records follow the pane to its new tab (`moveAgentLeafToTab`). `basename` splits on both `/` and `\`.
- **header/** - top bar + inline search (`SearchInline` adapts to terminal vs editor via `SearchTarget`). With a query, a terminal or editor search shows the match count ("3 of 12", "12 matches" until one is selected, "No results"; `lib/matchCount.ts`) and previous/next buttons. The terminal's count comes from its search engine as it steps (`GhosttySearchController.matchCount`, listeners hear only changes, the regex engine stops at 10,000); the editor's from the pane's `searchCounter` (see editor/), which the field subscribes to only while it has a query. `WindowControls` rendered when `USE_CUSTOM_WINDOW_CONTROLS` is true (Linux + Windows; macOS uses native traffic lights).
- **statusbar/** - bottom bar, `CwdBreadcrumb` (handles Unix paths, Windows drive letters, and home `~` segments via `pathUtils.segmentsFromCwd`), AI tools indicator. Right-clicking a breadcrumb segment (a folder, or the open file's name) offers Open in Terminal (a new tab there; the file's folder for a file), Reveal in Finder / File Manager, Copy Path (in the separators the path is shown with, `inSeparatorsOf`) and, inside the workspace folder, Copy Relative Path (`pathInside`). A breadcrumb types `cd` only while the pane's shell is at its prompt (`leafShellAtPrompt`: no command running per OSC 133 and no job owning the terminal, `pty_has_foreground_job`; Windows has no foreground group, so there it is a child of the shell built for the console subsystem, read from its PE header, and a GUI app started from the shell does not count); otherwise a toast offers the folder in a new tab.
- **shortcuts/** - keymap registry (`shortcuts.ts`) + `useGlobalShortcuts`. Handlers live in `App.tsx` and are passed in by id (`tab.new`, `ai.toggle`, …). `metaKey || ctrlKey` for cross-platform Cmd/Ctrl. Defaults are per platform (`defaultShortcuts`, its test locks the table and checks that no two defaults share a chord on any platform). macOS uses Cmd. On Windows and Linux every app shortcut macOS puts on Cmd+key is Ctrl+Shift+key first, as in Ghostty and Windows Terminal, with plain Ctrl+key kept as a second binding; the Ctrl+Shift shortcuts that chord displaced (Find in files, New Blocks terminal, explorer focus and search, split down, AI chat window, next/previous space) are Ctrl+Alt+Shift, and Toggle input bar is Ctrl+Alt+Shift+U on Linux, where input methods take Ctrl+Shift+U. A focused terminal keeps plain Ctrl+<letter> and Ctrl+[ ] \ / for its programs (`shouldDeferShortcutToTerminal`), so there only the Ctrl+Shift binding runs. New AI conversation (Cmd+N; plain Ctrl+N elsewhere, as Ctrl+Shift+N is New window) runs only while the AI composer or the chat window has focus (`isAiSurfaceTarget` in `ai/lib/aiSurface.ts`; the input bar marks its composer `data-ai-composer` while it shows it, and the chat window takes focus when clicked), so everywhere else the key passes through; the palette lists it too. Ctrl+Alt bindings never fire while AltGr is held (Windows reports it as Ctrl+Alt). A user's own binding wins over a default on the same chord, and keys an input method is composing with never trigger a shortcut (`matchShortcut`). Shortcut labels in the UI read the registry (`useShortcutText`, `shortcutLabel`), so they follow the platform and user bindings. Global shortcuts run in the capture phase, so a text box that handles a ⌘/Ctrl chord of its own marks it with `data-claims-mod-key="<key>"` and keeps exactly that chord while focus is inside it (`focusClaimsChord`): the commit message box generates a message on ⌘G / Ctrl+G, which elsewhere toggles Source Control, and off macOS the code editor keeps Ctrl+G for go-to-line.
  On macOS the menu bar carries some shortcuts as well, so they work while a preview frame has the keyboard and the page never sees their keys: New Tab (File), Command Palette and Toggle AI Agent (View), Show Previous Tab, Show Next Tab and Select Tab 1-9 (Window). Their key equivalents follow the user's bindings (`menuShortcutPlan`: per item the first binding its shortcut owns that the menu can name, else none, as for an Option chord stored as the character it typed); each app window sends them when it loads and when they change (`app_menu_set_shortcuts`, which rebuilds the menu bar whole: muda cannot take a key equivalent off an item). A chosen item runs in the window in front (`oarlock:menu-shortcut`; Settings and the quick terminal ignore it) through the handler its keys run, except that tab switching commits at once, having no key release to wait for. WebKit offers a key to the page first and keeps a handled one from the menu, and the page runs, or marks handled, every key it sees that the menu carries (`menuCarriesKey`: a held key's repeats and a chord a text box claims too), so an item fires only for keys a frame had and for clicks. The bridge (`menuBridge.ts`) loads on macOS only. `data-claims-mod-key` takes several keys separated by spaces (the block editor's completion list claims `n p y` off macOS while it shows).
- **settings/** - settings store (`store.ts` via `tauri-plugin-store`, which opens files only by plain names in the app data folder: `modules/store_scope.rs` wraps the plugin and refuses any other `load` or `get_store` path, an absolute one, `..`, a separator or another folder, except an extra window's own `windows/<label>/oarlock-spaces.json`; a test checks every `STORE_PATH` in `src/` against it), preferences hook, settings window opener. The Settings window is closed (not hidden, so its WebContent process is released) when it hands a theme edit to the main window; `open_settings_window` rebuilds it on demand.
- **sidebar/** - activity bar + collapsible side panels (explorer, source control, search). Search (`search/ContentSearchView.tsx`, loaded when first shown) is the palette's content search kept on screen: `useContentSearch` and `fs_grep_interactive` (literal, smart case) on the sidebar's own channel, up to 1,000 results, grouped by file in the explorer's order with the matched text highlighted the way the backend matched it (`contentSearchResults.ts`); a click or Enter opens the file at the line, Left/Right fold a file, and the last results stay on screen, dimmed, while the next query runs. The query lasts while the window does. Settings, General, Layout, "Sidebar position" (`sidebarPosition`, left by default) docks it on either side of the window. The panels swap with CSS `order`, so nothing moves in the DOM or remounts (preview frames keep their pages); the sidebar's panel id follows the side, which makes react-resizable-panels register it again and sort panels and separator into visual order, and the next frame puts back the width and collapsed state. The pane gutters and the header's toggle icon mirror, and the terminal area is told it moved (`terminalAreaMoved.ts`), since no size observer fires, so the window canvas re-reads its geometry and stays on the device pixel grid. The side is mirrored in `localStorage` (`oarlock.sidebar.position`) for the first paint, before preferences load.
- **source-control/** - git status / stage / commit panel and diff workflow. Changed files show as a flat list or, through the toggle in the Changes header, as a tree grouped by folder (`changeTree.ts`: folders first in the explorer's order, a chain of folders holding only the next one joined into one row, collapsible with the mouse or Left/Right); the choice is remembered (`sourceControlViewMode` in the settings store, list by default) and collapsed folders are kept per repository while the panel is open. `useSourceControl` takes a `live` flag (`statusConsumers.ts`): `git status` runs on window focus and context changes only while the Source Control panel, a git tab or the explorer's git decorations are on screen. Otherwise nothing runs, a snapshot for another repository is dropped (never a wrong badge), and the next consumer to appear refreshes it. The rail badge alone is not a consumer; it refreshes lazily. While live with a repository it also follows changes made while the window keeps focus: `git_watch_add` (`fs::watch`) watches the repository's git directory (top level and its state files, polled on the WSL share) and relates activity in the work tree's watched folders and Oarlock's own file writes to it, emitting `git:changed`; a command that finishes in a terminal inside the repository (or inside the followed context, which may be spelled through a link) counts too. Signals settle into one refresh (`refreshSignals.ts`: 300 ms quiet, 1.5 s at most, one more when a signal lands during a refresh), and the watch is released when the view goes. Status reads never write the git directory (`GIT_OPTIONAL_LOCKS=0`), so a refresh cannot trigger the next. In-place edits by a long-running program in a folder nobody watches still wait for focus. Its git commands on the followed folder wait for that folder's authorization in flight (a `cd` authorizes the new folder as a root), so a refresh right after a `cd` waits for it instead of showing the backend's refusal. The branch dropdown switches local branches, opens another worktree in a new terminal tab (Source Control follows it there when following the active context), and creates (New Worktree…: new or existing branch, folder filled with the default) or removes worktrees (Remove Worktree…: a second confirmation forces a worktree with changes); the dialogs' rules are pure (`worktrees.ts`, mirroring the Rust side). In a linked worktree the header names the repository and shows the worktree's name next to the branch. When the followed folder is not a repository, the panel lists the repositories inside it (`git_discover_repos`: children and grandchildren, not inside a repository, hidden or dependency folders, links not followed, at most 256 folder reads and 24 results) and opens one the way the explorer's Open in Source Control does.
- **git-history/** - commit graph rail, refs, per-commit file diffs. History pages are slices of `git log <newest loaded commit> --skip=<loaded count>` (`lib/historyPaging.ts`), so commits reached only through a merge are never dropped and a moved HEAD never shifts a page. Each commit carries its refs from `%D` under `--decorate=full`, classified by namespace in Rust (`git::parser::parse_decorations`: HEAD, branch, tag, remote; `origin/HEAD`, the stash and notes are left out), drawn as chips before the subject (two and a count in a row, all in the detail) and matched by the search. The detail of the commit HEAD's branch points at offers Undo Commit (`git_undo_commit`, `git reset --soft HEAD~1` as a compare-and-swap of HEAD against the chosen commit, so a commit made meanwhile fails it; ORIG_HEAD is set and the changes stay staged), with a warning when `git_commit_on_remote` finds the commit on a remote branch.
- **lsp/** - opt-in language server support, zero cost until enabled (no process, no PATH check, nothing in the eager bundle beyond a 14.5 kB shell). Statusbar pill offers Enable (binary found) or Install (with copyable command) per language; activation persists as `lspActivation` in the settings store (`enabled`/`dismissed`/unset). `sessionManager.ts` keys sessions by (server, workspace root), refcounts open docs, idle-kills after 3 min, and crash-backoffs (cooldown before respawn; 3 in 5 min → give up + toast with the server's stderr tail). Resource invariants: **no root marker → no session** (the status pill says so for the open file instead of disappearing) (a dirname fallback once spawned a server per directory and burned GBs), hard cap of 4 sessions per server, lean per-preset `initializationOptions` (rust-analyzer: `cachePriming` off + bounded `lru`; tsls: `maxTsServerMemory`). Client is `codemirror-languageserver` behind a lazy import, subclassed (`lib/client.ts`) to add didClose/didSave/shutdown, `textDocument/references` (Shift-F12; multi-result definitions and references share the `locationsPanel.ts` picker) and the publishDiagnostics capability the lib forgets (tsls sends no diagnostics without it); `lib/transport.ts` bridges to the Rust pipe and answers server-to-client requests the lib ignores. Location URIs are compared decoded with the drive letter's case ignored (`sameFileUri`; pyright sends `file:///d%3A/...`), and file tabs dedupe by `pathKey` (`@/lib/pathKey`), so a definition in an open file moves its cursor instead of opening a duplicate tab. `vscode-languageserver-protocol` is aliased to a 4-enum shim in vite.config.ts (~117 kB saved). Presets: typescript, rust-analyzer, pyright, ruff, gopls and more; custom stdio servers via Settings. Several presets can claim one language (pyright and ruff both take `py`): `serverForLanguage` prefers the enabled candidate, so enabling ruff while pyright is unset or dismissed routes Python to ruff. WSL workspaces excluded for now.
- **mcp/** - MCP (Model Context Protocol) client, on the official `@modelcontextprotocol/sdk`. Servers are configured in Settings > MCP (`src/settings/sections/mcp/`) and stored in `oarlock-mcp.json` (`lib/configStore.ts`: `servers`, `projectServers` with the user's choices for project servers, and `tools:<id>` with the tools each listed when it last ran, for per-tool choices; every write is announced as `oarlock://mcp-changed`, and `onMcpChanged` also follows `project-trust:changed` and `skills:changed`). A server (`lib/config.ts`, parsed strictly: a damaged entry is dropped, never started) has an id, a name, a `source` (`settings`, `imported:<app>`, `project:<path>`), enabled, trusted, a transport (`stdio`: command, args, env, cwd; `http` or `sse`: URL, headers, and optionally `oauth`, a sign-in client the user registered: client ID, whether a secret is in the keychain, scopes, callback port; an entry marked secret holds no value, the keychain does), per-tool choices (`allow`, `deny`) and `secretsRevision`, bumped when a secret value changes. A window runs `loadWindowServers`: the configured servers plus its project's `.mcp.json` servers while the user allows the file (`lib/projectServers.ts`: on unless turned off, untrusted until the user says so; Trusted and Always allow are kept with the hash of the server's own entry and lapse when it changes, also when Oarlock's own edit keeps the file allowed, so an edited command never inherits them; `connect.ts` starts them through `mcp_project_spawn` / `mcp_project_http_open`, never from the page's copy). Settings > MCP imports servers (`ImportDialog.tsx`, `lib/importConfig.ts`: off, untrusted, `imported:<app>`, already-configured ones marked, secret-looking values written to the keychain by the backend), lists each open project's `.mcp.json` with its decision (`ProjectServers.tsx`), and signs remote servers in and out (`SignIn.tsx`, `lib/auth.ts`: the backend's status, never a token; a sign-in restarts the server in every window). A connection the backend marks as needing sign-in fails with `SignInRequiredError` and is not retried until Settings restarts it. `index.ts` is light and is all the chat imports: with no server enabled an agent run reads the configuration and nothing else, and the client chunk (`runtime/`, the SDK in the `mcp-sdk` chunk) loads only once one is. Each app window runs its own clients (a client lives in a page; sharing one across windows would need a JSON-RPC multiplexer in the backend): enabled servers start on the window's first agent run, which waits for them up to 15 s from each start (`lib/lifecycle.ts`), stay up, restart after a crash with backoff (1, 3, 10, 30, 60 s; after five crashes in ten minutes they stay down until restarted from Settings), stop when disabled or removed and restart when their launch settings change (`launchKey`; trust, name and tool choices only change what the agent is offered). Tool lists are paged, cached, and refreshed on `notifications/tools/list_changed`; resources, resource templates and prompts likewise (`runtime/extras.ts`, on `notifications/resources/list_changed` and `notifications/prompts/list_changed`), published for the composer in `lib/extrasCatalog.ts` (`useMcpExtras`, light), whose `@` and `/` pickers also start the window's enabled servers when they first open (`extras.ts`, light like `index.ts`). `runtime/manager.ts` reports each server's state to the backend (`mcp_status_report`) and notes its lifecycle in the server's log. Transports: `runtime/stdioTransport.ts` (the SDK `Transport` over `mcp_spawn`, sends serialized so IPC calls cannot overtake each other) and the SDK's Streamable HTTP and SSE transports with `createMcpFetch` (`ai/lib/proxyFetch.ts`, routed to `mcp_http_stream`). The client offers `sampling` (no tools, no context; what an approved run uses is counted in the window's open conversation) and form-mode `elicitation` (URL mode is optional in the spec and not offered, so the SDK refuses it with Invalid params), no roots; `runtime/serverRequests.ts` answers both only with what the user gives in this window (`lib/requests.ts`, see AI subsystem, Server requests), takes server cancellations itself (the SDK 1.32 skips request id 0) and notes each request in the server's log. The SDK speaks protocol 2025-11-25; the 2026-07-28 revision (sampling deprecated, elicitation through `InputRequiredResult`) needs a newer SDK. The SDK's AJV validator cannot run under the CSP (it compiles with `new Function`), so `vite.config.ts` resolves it to a pass-through (`runtime/ajvProvider.ts`) and AJV is not bundled. Tools reach the agent as `mcp__<server>__<tool>` (`lib/toolNames.ts`: sanitized to `[A-Za-z0-9_-]`, at most 64 characters, a long or colliding name cut and given a hash of what it stands for), with the server's input schema (object schemas up to 64 KiB, `$schema` dropped) and description (2,048 characters); a tool that requires task-based execution is not offered. Results (`lib/results.ts`): text capped at 50,000 characters with a note to the model, at most four PNG, JPEG, GIF or WebP images (5 MiB of base64 each, 8 MiB together), resource links and text resources as text, everything else a note; a result with `isError` becomes the tool's error, and a transport failure of a remote server reconnects it. `lib/catalog.ts` is the window's live tool catalog the chat reads (server and annotations on the approval card).
- **markdown/** - markdown preview renderer (backs the `markdown` tab kind). Markdown tabs are in the fs watch set (`editor/lib/fileWatchTargets.ts`); the preview re-reads its file when the watcher or an Oarlock write (`fs:file-written`) reports a change, and a failed re-read keeps the last render (`previewStatus.ts`). The file renders as GitHub renders a README (`RenderedMarkdown.tsx`, `markdownPreview.css`): a centred column 980 px wide, GitHub's spacing, heading rules, lists, task lists, tables (borders, striped rows, alignment, content width with sideways scroll), quotes, rules, footnotes, `<kbd>` and disclosures, with GitHub's greys mixed from the theme's foreground and background and links in `--primary`. The sheet is unlayered and every rule is scoped to `.markdown-body`, which holds only the document; Streamdown's elements are mapped back to plain HTML (no chat classes, no table toolbar or 300 px scroll box, and a paragraph that only holds an image keeps its `align`), and an image's pixel `height` attribute becomes a style so preflight's `height: auto` cannot drop it. Code renders through the preview's own `PreviewCode.tsx`: blocks (fenced, unlabelled or indented, and a raw `<pre>`, which keeps its element) in GitHub's box with a copy button on hover and no language label, highlighted by the chat's Lezer highlighter (which reads shell and PowerShell for the preview). A file's shell blocks never offer Run in terminal: a file from disk must not offer a command to type into the active terminal, so that button stays with AI chat replies (`MarkdownCode`, `ChatCodeBlock`); `PreviewCode.test.tsx` renders both sides. README HTML shows as on GitHub: a `<picture>` takes the image of the source whose `prefers-color-scheme` matches the variant the app paints (`pictures.ts`; every `<source>` is dropped, so a srcset never reaches the webview and the chosen URL is vetted like an image's src), a link to a file next to the document (`LICENSE`, `docs/setup.md`) stays a link instead of harden's "[blocked]" note, and an anchor without a link (`<a name>`, or a `javascript:` link the sanitizer emptied) becomes its content, its name kept as the id a `#fragment` scrolls to (`documentLinks.ts`). Relative images resolve against the document's folder (`localImages.ts`, a rehype step after the sanitizer, so an `asset:` URL written in the file stays stripped, and before harden, which would rewrite `./a.png` onto the app origin) and load through `useWorkspaceAssetUrl`; https images are fetched by `markdown_remote_image` and shown as object URLs shared by `RemoteImageCache` (on-screen images kept, 32 unused ones cached, the rest revoked). The CSP loads no remote images because AI chat Markdown renders in the same webview, so chat images stay blocked. The rehype chain is `previewPipeline.ts`: a leading YAML frontmatter block renders as a key/value table (`frontmatter.ts`), GitHub alerts (`> [!NOTE]`) as callouts (`githubAlerts.ts`, `markdownPreview.css`), and headings get GitHub slug ids under the `user-content-` prefix the preview's sanitizer restores (Streamdown drops it; unprefixed ids could clobber the app's own), so `#section` links scroll the pane (`PreviewLink`, `headingAnchors.ts`), while a relative file link never navigates the webview. Math (`$...$`, `$$...$$` and ```` ```math ```` fences) renders with KaTeX in the preview and in AI chat replies: `math.ts` loads the renderer (`mathPlugin.ts`, `@streamdown/math`) the first time a file or reply holds two dollars or a math fence, and passes it only for such text, so nothing else pays for it. Single-dollar spans follow Pandoc's rule (`dollarMath.ts`: no space inside the dollars, no digit after the closing one), so prices stay text with their Markdown. KaTeX's `trust` is off (`\href`, `\url`, `\includegraphics` and the `\html*` extensions render as errors), a formula that does not parse shows inline in the destructive colour with the error as its title, and user sizes are capped at 50em. KaTeX's stylesheet resolves through `@streamdown/math` (a `vite.config.ts` alias; KaTeX is not a direct dependency) and only its woff2 fonts ship (`katexWoff2Only`); the CSP needs nothing new (fonts load from `'self'` and `data:`). A render that throws is contained by `RenderBoundary`: the preview points to the Raw view, a chat reply shows as plain text, and new content gets a fresh attempt. ```` ```mermaid ```` blocks render as diagrams in both places (`MarkdownCode` routes them to `MermaidBlock.tsx`, which loads `MermaidDiagram.tsx` and `@streamdown/mermaid` the first time a diagram is shown; a chat reply shows its code placeholder until it finishes streaming). The source is untrusted: Mermaid runs at its strict security level (no `click` callbacks, DOMPurify over the output) with labels as SVG text (`htmlLabels: false`), `MERMAID_SECURE_KEYS` keep a diagram's own `%%{init}%%` directive or front matter from turning HTML labels, DOMPurify settings, theme CSS or fonts back on, and links are unwrapped from the SVG (`stripSvgLinks`, `mermaidRender.ts`) so nothing can navigate the webview. Mermaid fetches nothing itself; an image shape's remote URL is blocked by the CSP and the diagram shows an error. Its SVG carries a `<style>` element and style attributes, which rely on `style-src 'unsafe-inline'`: an inline `<style>` in `index.html` would make Tauri add a style nonce to the CSP, and browsers ignore `'unsafe-inline'` next to a nonce. Diagrams use Mermaid's default or dark theme after the variant the app paints (`variantMode` in `theme/applyTheme.ts`), redraw on a theme change while the old drawing stays up, are laid out when they first come near the viewport, and are cached by theme and source (32). A diagram that does not parse shows the error above its source; so does a renderer that fails to load (`RenderBoundary`).
- **workspace/** - workspace environment switching (Local + WSL distros). A space keeps one environment; the status-bar picker (Windows) moves to the first space with the picked environment, else opens a space at its home (`planEnvSwitch`), and never closes a shell or tab of any space. A Windows path (drive or UNC) names a host file in every environment, since a path inside a distro starts with `/`: the editor reads and saves a document in the environment its path names (`workspaceEnvForPath`), so a host file such as a custom theme opens in a WSL window too, where the window's environment would send the backend looking inside the distro.
- **theme/** - custom theme engine (no `next-themes`). `ThemeProvider` + `applyTheme` write CSS variables; built-in presets in `themes/` (oarlock-default - colours live in `globals.css` since ThemeProvider clears rather than applies for that id - xcode, claude, kanagawa, kanagawa-dragon, tokyo-night, catppuccin, rose-pine, everforest, nord, gruvbox, dracula, solarized, github, one-half, ayu, ayu-mirage, night-owl, tomorrow, flexoki, tide, sage, caffeine), each optionally declaring an `editorTheme` pairing consumed by `resolveEditorThemeId` (see editor/). The terminal palettes of github through flexoki are Ghostty's own copies, verbatim (`themes/NOTICE.txt`, bundled under `licenses/themes/`; `bundled.test.ts` checks them against the fixtures). User themes use native per-ID transactions in `modules/themes.rs` and revisioned snapshots through `customThemes.ts`; `validateTheme.ts` validates imports. `oarlock-themes.json` is the native catalog; migration preserves `oarlock-custom-themes.json`, and neither file is accessible through the store plugin. Commits use the shared conditional, metadata-preserving writer; unavailable safe-write platforms fail without replacing files. Settings exposes load errors and Retry; a user theme is edited as a `.oarlock-theme` file in the app's config folder (`themeFiles.ts`), which is on the host, so its commands name the local environment whatever the window works in (in a WSL window the editor reaches it through `workspaceEnvForPath`); Settings → Themes also imports Ghostty, iTerm2 (`.itermcolors`), Alacritty (TOML/YAML) and Windows Terminal schemes through the dependency-free, lazily loaded parsers in `schemes/`, which keep the terminal colours exact and derive the app chrome from them (`schemes/scheme.ts`, contrast-checked; an inverting selection becomes a translucent overlay so selected text stays readable), optional background image via `bgImageStore.ts` + `SurfaceLayer` (a fixed layer over the whole page that drops under a modal's overlay while one is open, so the overlay dims and blurs it too).
- **mac-privacy/** - macOS privacy controls; nothing runs elsewhere. Settings, General, Privacy (`src/settings/sections/MacPrivacySettings.tsx`) shows Full Disk Access and, through it, the Desktop, Documents and Downloads folders, iCloud Drive, cloud storage (`~/Library/CloudStorage`: Dropbox, OneDrive, Google Drive) and removable and network volumes, each with a button to its System Settings pane, checked again whenever the window gains focus (`useFullDiskAccess`). Without Full Disk Access a folder reads "Asked on first use" (`areaStatus`): only opening it would tell, and that can make macOS ask. A Full Disk Access change applies once Oarlock is reopened (System Settings offers to). On a launch where Oarlock is known not to have Full Disk Access (`denied`, never `unknown`), the main window suggests it in a notice that blocks nothing (`useFullDiskAccessSuggestion`, `shouldSuggestFullDiskAccess`): Open System Settings or Not now. Either answer, or closing the notice, is kept (`macFullDiskAccessSuggested` in the settings store, app state rather than a preference), so it shows once and `firstRun.ts` never loads again; the Privacy group keeps the same action. File errors reach the user through `fileErrors.ts` (`showFileError`, `showPrivacyRefusal` for operations that used to fail quietly, and `usePrivacyRefusal` for errors shown in place): the editor's open and save, the explorer's listings, create, rename, delete, copy, paste, drop and Open in Default App, the Markdown preview, the explorer and palette searches, and Source Control's status, stage, discard, commit, fetch, pull, push, branch and undo errors. On macOS an `EPERM` ("Operation not permitted"; never `EACCES`) on a protected place (`privacyRefusal`, pure: Desktop, Documents, Downloads, `~/Library/Mobile Documents`, `~/Library/CloudStorage`, `/Volumes/<name>`, and places only Full Disk Access opens such as `~/Library/Mail`, `Messages`, `Safari` and the TCC databases; case-insensitive, dot segments resolved) is shown as the grant it needs with an Open System Settings button, unless Oarlock has Full Disk Access (then something else refused it, such as a locked file; the answer is kept until the window regains focus). Everything else, and every error off macOS, shows as before.
- **updater/** - auto-updater UI built on `tauri-plugin-updater`, off (`UPDATES_ENABLED`) until Oarlock publishes its own releases: no check runs, no window offers an update, About says updates are not set up for this build, and the plugin has no key and no endpoint and the webview no `updater:default` permission (`updater.test.ts` ties them together).
- **agents/** - agent launching, notifications, and management for both the built-in Oarlock agent and terminal coding agents (Claude Code, Codex, Gemini CLI, Antigravity, Pi, GJC, OpenCode, Grok). The header launcher (`components/AgentLauncherPanel.tsx` + `lib/launcher.ts`) persists per-agent start commands in preferences and atomically builds balanced one-to-four-pane tabs. Shared store (`store/agentStore.ts`: terminal `sessions` + `localAgent` + `notifications`) and a shared router (`lib/route.ts`: suppress when focused-and-visible, OS-notify when unfocused, in-app Sonner toast when focused-but-hidden) feed the header `NotificationBell` (management surface, Oarlock agent listed first, per-agent hook enable rows). Toasts use Sonner (`components/ui/sonner.tsx`) themed via the central engine; `lib/agentIcon.tsx` renders the per-agent brand mark. Terminal detection is Rust-side (`pty/agent_detect.rs`) on the PTY reader's byte filter, armed on `OSC 133;C;<cmd>` or self-armed by the marker, emitting `oarlock:agent-signal` transitions (`started`/`working`/`attention`/`finished`/`exited`) driven only by OSC sequences (never raw output, so a repainting TUI never flaps) - zero cost when no agent runs. Hook-backed terminal agents converge on the same `OSC 777` marker the detector reads, installed via `agent_enable_hooks(agent)` / `agent_hooks_status(agent)` in `modules/agent.rs` (data-driven `AgentSpec` for JSON-hook agents plus an Oarlock-owned Pi extension; atomic writes, foreign configuration preserved, idempotent; gated on `OARLOCK_TERMINAL`). OpenCode and Grok use OSC 133 process-lifecycle detection but do not install attention hooks; GJC writes the 4-field marker itself, so nothing is installed for it either. Delivery differs because only Claude's hook protocol can return terminal bytes in the hook *response*: **Claude** (`~/.claude/settings.json`, `UserPromptSubmit`/`Notification`/`Stop`) returns the marker via the `terminalSequence` field (legacy 3-field `notify;Oarlock;<event>`). **Codex** (`~/.codex/hooks.json`, `UserPromptSubmit`/`PermissionRequest`/`Stop`) **Gemini** (`~/.gemini/settings.json`, `BeforeAgent`/`Notification`/`AfterAgent`, `matcher:"*"`) and **Antigravity** (`agy`, built on Gemini CLI: the same events in `~/.gemini/antigravity-cli/settings.json`) can't, so the hook *command* emits the 4-field `notify;Oarlock;<agent>;<event>` marker itself (`printf > /dev/tty` on Unix, or `oarlock __oarlock_notify` writing to `CONOUT$` after `AttachConsole` on Windows) and prints `{}` as a JSON stdout no-op (Codex's `Stop` and Gemini both reject empty/non-JSON stdout). **Pi** (`~/.pi/agent/extensions/oarlock-notifications.ts`) uses `agent_start`/`agent_settled` extension events and writes its named marker directly to stdout. The agent-named marker lets a self-arm name the right agent when no preexec fired (bash/tmux/Windows). Any agent that emits it gets a status, known to Oarlock or not, but the name is PTY output and stays untrusted text: the detector drops control and bidi characters and keeps at most 32 characters (`sanitize_agent_name`; `sanitizeAgentName` repeats this where the frontend receives signals), it renders as plain text with the generic mark unless it is exactly a known id (`agentMark`), and it never picks a command, path, hook file or icon file. Only the first name sticks until the agent exits, and the attention repeat window and notification cooldown still apply. OSC 133 arming matches only the listed commands (`DEFAULT_AGENTS`; `agy` arms Antigravity). The Oarlock agent path is `ai/components/LocalAgentNotificationsBridge.tsx`, mapping `chatStore.agentMeta` (`awaiting-approval`→attention, busy→idle→finished, `error`) into the same router.
- **command-palette/** - modal command palette (`CommandPalette.tsx`, `commands.ts`) for actions and navigation.
- **spaces/** - workspace spaces/projects (name, root, env, color, per-space tab persistence) via `useSpaces` and `SpaceSwitcher`. Each app window has its own spaces (`lib/appWindow.ts`, `windows::*`). A folder Oarlock is asked to open (a folder argument or Open in Oarlock for `main`, `?folder=` for a later launch's window; never the process's own directory or a launched file's folder, `getExplicitLaunchDir`) wins over the restored spaces: `bootSpaces` activates the local space rooted there, else adds one named after it, on a terminal whose active pane is there, else a new one (`planOpenFolder`, applied by `applyExplicitLaunchDir`); with no saved spaces it roots the first, local, space there. Restoring authorizes, in each space's environment, its root, its terminals' folders and its open files' folders, which may lie outside the folders authorized today (`restoreGrants.ts`); a WSL space other than the active one waits until it is activated, since reaching its files at launch would start the distro.
  Open Folder (the command palette, the explorer header and its empty state, the Spaces menu, and File in the macOS menu bar, which sends `oarlock:open-folder-requested` to the window in front) shows the OS folder picker, one folder at a time, and opens the choice in the same way in the running window (`lib/openFolder.ts`, `app/hooks/useOpenFolder.ts`): `workspace_authorize` (local, whatever the window's environment) first, which also gives the canonical path, then `planOpenFolder` on the live spaces and tabs. Cancelling does nothing; a folder that cannot be authorized opens nothing and says why. The dialog plugin is loaded on first use and app windows hold only `dialog:allow-open` (`capabilities/dialog.json`); a picked folder is also added to the asset protocol scope by the plugin itself.
  Terminal scrollback survives restarts (`terminal/lib/terminalScrollbackRestore.ts`, format in `terminalScrollback.ts`, files in `modules/terminal_scrollback.rs`). Leaf ids change every launch, so each pane gets a random key stored with its leaf in the space state. Its newest 5,000 lines (at most 4 MiB, text and SGR styles) go to `<app data>/terminal-scrollback/<key>.vt` (atomic replace, owner-only) whenever the space state flushes and when the window closes (bounded to 1.5 s, in parallel with chat history); unchanged panes and panes in the alternate screen are skipped, and each save sweeps the files of closed panes, tabs and deleted spaces. Private tabs are never saved. A restored pane gets the history, with everything but text and SGR stripped (a file can never move the cursor or make the terminal answer the new shell), and a dim "Restored <date>" line before any shell output; output that arrives while the file loads is held (2 s, 1 MiB) and follows it. Exports read 256-row chunks, so a pane's WebAssembly memory does not grow by the size of its history. Settings, General, Terminal, "Restore scrollback after restart" (`terminalBehavior.restoreScrollback`, on by default) turns it off and deletes every file.
- **skills/** - Agent Skills on the frontend: the command wrappers (`api.ts`), the run's catalog (`catalog.ts`), the system prompt block (`prompt.ts`), `/skill-name` calls (`slash.ts` eager, the rest of `composer.ts` and `invocation.ts` loaded when used) and the project trust prompt. App windows mount only `SkillsBridge`, a lazy loader: `SkillsWatcher` registers the window's project (`project_trust_status` with the explorer root, debounced, again on `skills:changed`/`project-trust:changed`), shows `ProjectTrustPrompt` (loaded when a project item is undecided or changed: a card listing what each item provides, `AGENTS.md`'s size, line count and first lines, skills, or each MCP server's command and URL, worded for what is asked; Use, Don't use, or close until the content changes) and opens a `SKILL.md` Settings hands over (`oarlock:skill-edit`) in an editor tab. Settings > Skills is `src/settings/sections/SkillsSection.tsx`, loaded when its tab opens: each open project's `AGENTS.md` and its skills are decided and forgotten there (`settingsView.ts` `trustBars`), and every recorded decision is listed.
- **ai/** - see below.

### AI subsystem (`src/modules/ai/`)

BYOK. Cloud providers via `@ai-sdk/*`: **OpenAI, Anthropic, Google, xAI, Cerebras, Groq, DeepSeek, Mistral, OpenRouter**, plus **OpenAI-compatible** for any custom base URL. Settings' Add provider menu also offers ready-made custom endpoints (`lib/endpointPresets.ts`): **OpenCode Go** fills the name and the gateway's OpenAI-compatible base URL (`https://opencode.ai/zen/go/v1`, which gets the `x-opencode-session` header), and the user saves the key (keychain, like any endpoint's) and picks a model from the gateway's `/models` list with Browse. Local / offline providers (key-optional, model id supplied at runtime): **LM Studio, MLX, Ollama**. Provider list in `config.ts` (`PROVIDERS`); model registry includes `DEFAULT_MODEL_ID` + `DEFAULT_AUTOCOMPLETE_MODEL`.

- **Key storage**: macOS Keychain and Windows Credential Manager via `keyring`; Linux uses a user-only file in the app data directory. Frontend reads/writes through `secrets_*` commands. Service `KEYRING_SERVICE = "oarlock-ai"`. Keys do not go in the settings store or `localStorage`.
- **Agent** (`lib/agent.ts`): `runAgentStream` calls `streamText` with the tools, the run's approval policy (`toolApproval: buildToolApproval(...)`, see Tools) and `stopWhen: isStepCount(MAX_AGENT_STEPS)`, and the system prompt from `config.ts`. Provider branching happens here (`buildLanguageModel`). `lib/transport.ts` (`createContextAwareTransport`) is the chat transport and returns `toUIMessageStream(...)`; the rest of the system depends on AI SDK v7 chat semantics. Each run asks `project_memory_read` for the workspace's `AGENTS.md` (the system prompt's project section): only the window's open project, while the user allows its current content (project trust) and inside the folders the AI's file tools reach; otherwise the run goes on with no project memory. Nothing is cached, so a withdrawn answer or a change outside Oarlock stops it on the next run. The whole file is sent, whatever its size. The system prompt counts against the model's context before the history (`compact.ts`: four characters a token), so compaction starts earlier beside a large `AGENTS.md`, and a run whose system prompt alone does not fit fails with a message naming `AGENTS.md` and its size (or the instructions as a whole) instead of a provider error. It puts the run's `<env>` block (workspace root, terminal cwd, active file) before the last user message, for the model only; a path in it is written as it is unless it holds a control character, a line separator or a closing tag, begins with a quote or begins or ends with a space, and then as a JSON string (`pathText` in `lib/messageBlocks.ts`; the system prompt says a quoted value is JSON), so a folder or file name cannot add a line to the block or end it. Each step's usage reaches `onUsage` with the model it ran on.
- **Reasoning effort** (`lib/reasoningEffort.ts`): a picker beside the model in the composer (`ReasoningEffortPicker`) offers off, low, medium and high for catalog models tagged `reasoning` whose provider can take an effort (OpenAI, Anthropic, Google, xAI but Grok 4.20, and DeepSeek V4, which only switches thinking off or on and offers off and high). Models whose capabilities are unknown (custom endpoints, local servers, OpenRouter) hide it. The choice is remembered per model (`reasoningEffortByModel`), and until one is made nothing is sent, so the model keeps its default. OpenAI, Anthropic, Google and xAI get the AI SDK's `reasoning` call option, which each provider maps under its own constraints: Anthropic adaptive thinking with an effort (or a budget within the max tokens) and no temperature, OpenAI `reasoningEffort`, Google `thinkingConfig`, xAI `reasoningEffort`; a model that cannot stop thinking gets its lowest setting for off. DeepSeek gets its `thinking` switch through the compatible provider. Reasoning renders as before.
- **Sub-agents** (`agents/registry.ts`, `agents/runSubagent.ts`): named sub-agents with their own system prompts and tool subsets, invoked by the main agent via `run_subagent` tool. A sub-agent runs on the window's selected model, and each of its steps is counted in the meter of the conversation that started it, at that model (see Usage meter).
- **Sessions** (`lib/sessions.ts` + `store/chatStore.ts`): conversations are organized into named sessions. `oarlock-ai-sessions.json` retains only metadata and `activeId`; message arrays live in atomically replaced `conversations/session-<id>.json` files owned by Rust. Messages cross IPC as raw JSON bytes (validated by a streaming pass, never rebuilt as a document tree); every save flushes the new file (plain `fsync`) before the rename and keeps the replaced version as `session-<id>.json.bak`; mid-stream saves are scheduled at most every 2 s and at least every 4 s, while turn end, session switch and window close save durably (full flush, `F_FULLFSYNC` on Apple, plus a directory sync). A queued write for a session is replaced by a newer one, and a damaged file is set aside as `session-<id>.json.corrupt` and the load falls back to the `.bak` before the conversation reads as empty, so one bad conversation never breaks the rest. Legacy migration is per session: it removes a legacy key only after its message file is safe, never overwrites a newer file on retry, skips and reports a failing key, and deletes `oarlock-ai-sessions.before-message-files.json` once every conversation that copy holds, not only the ids the caller lists, reads back as a valid file (a leftover copy older than seven days with nothing to migrate is pruned at startup, and deleting a session scrubs it from the copy). Window close flushes with a timeout and never traps: a failed flush shows a "Close anyway" error once. Loads prefix the raw JSON with a little-endian u32 revision; saves must supply that revision and return the next one. The native gate rejects stale writes and keeps deletion tombstones, so another window cannot overwrite newer messages or resurrect a deleted chat; a conflict offers Save a copy. Per-session queues and a native I/O gate serialize storage operations across page reloads; failed latest writes remain retryable, and window close flushes pending storage. `chatStore.ts` keeps a module-scoped `Map<sessionId, Chat<UIMessage>>`; `getOrCreateChat(sessionId)` lazily constructs a `Chat`, seeded with messages from a hydration map populated by `hydrateSessions()` (called once from `App.tsx`). At most eight chats stay constructed (`touchChat`); eviction persists and stops the oldest, never the touched one, the active one or one still answering. `AgentRunBridge` mirrors active-session messages to disk on every change and auto-derives titles from the first user message (`deriveTitle`: the user's own words, never the blocks before them; for a `/command`, the words its directive quotes or the command's label (`lib/commandMessage.ts`, free of the commands' icons and stores); for a message that only invokes a skill or an MCP prompt, `/skill` or `server: prompt`; a title an earlier version took from a command's marker is derived again once the conversation is open, keeping its place). Switching the API key wipes the chat map; sessions persist.
- **Usage meter** (`lib/usage.ts`, `agentMeta.tokens` and `tokensByModel` in `store/chatStore.ts`): the open conversation's tokens since it was opened in the window, in all and by the model that used them. `countConversationUsage` adds the agent's steps, its sub-agents' steps and the MCP sampling runs the user approved, only while that conversation is still the open one (the meter starts again when another opens, so a run answering in the background is not counted in it). The managed coding agents (`spawn_coding_agent`, `send_to_agent`) are the `claude` CLI in a terminal on its own account, not Oarlock's providers, so the meter does not count them. The context indicator prices each model's tokens at that model's price (`usageCost`) and shows the tokens of a model without a price apart.
- **Run status** (`agentMeta` in `store/chatStore.ts`): the status, step label, error, compaction notice and step cap the chat, the mini window and the status pill show are the open conversation's, and opening another starts them again (the store keeps none per conversation). What a run reports (`onStep`, `onCompact`, `onFinishMeta`, the chat's `onError`, a sub-agent's steps) goes through `patchConversationMeta` with the run's own conversation, so a run still answering in the background never changes the open one; its notice and step cap are not kept for later, and its error shows from its chat when it is opened.
- **Composer** (`lib/composer.tsx`): React context providing shared input state (text, attachments, voice, the open MCP form) for both the docked `AiInputBar` and any other surface. The pickers open on `#`, `/` and `@` at a word start (`lib/composerTriggers.ts`; a `/` query may hold the `:`, `_` and `.` of an MCP prompt). Attachments include image, text-file, MCP resource and `selection` kinds (an image pasted into the composer, such as a screenshot or an image file copied in a file manager, attaches as an image while text on the same clipboard still pastes, `lib/pastedImages.ts`; WebKitGTK lists a clipboard image as "Files" without handing it over, so a paste that brings neither text nor files reads the clipboard's image through `clipboard_image_read`, never for a middle-click paste of the primary selection. An image every provider takes (PNG, JPEG, GIF, WebP within Anthropic's 5 MiB of base64) is sent as it is, any other is decoded and encoded again within 2048 px as PNG, or JPEG when that is still too large, or refused with a toast, `lib/imageAttachment.ts`; the conversation shows a sent message's inline images as thumbnails) - selections come from `useChatStore.attachSelection(text, source)` (drained into chips, not pasted into the textarea) and are wrapped as `<selection source="terminal|editor">…</selection>` blocks at submit. Everything sent ahead of the user's text travels in such blocks (`lib/messageBlocks.ts`: `<file>`, `<selection>`, `<snippet>`, and the skill and MCP ones build on it): attribute values are escaped as XML escapes them, every control character and line separator included (as a character reference), and inside a block the closing tag of every kind is escaped (`<\/file>`, also `<\/env>` and `<\/mcp-instructions>`), so no attached text ends its block early, closes another or reads to the model as the user's words. A name or path no one typed in a block's own text (a server's or prompt's name in an MCP block's note, a skill's folder) is a JSON string or `pathText`, so it cannot rewrite the note or start a line. The transcript reads them back as chips in one pass (`lib/messageChips.ts`: the leftmost block runs to its own closing tag, chips keep their order by kind, and a message stored before the escaping reads as it did), and the title skips them (`deriveTitle`). A text attachment holds up to 200 KB however it is added (`lib/pathAttachment.ts`). Explorer items dropped on the composer (`lib/composerDrop.ts`: the explorer's path drop target with the composer, marked `data-ai-composer`, in front of the terminals; OS drops stay the terminals') attach files like Attach to Agent, but read as the agent's own `read_file` reads them (deny-list, then `origin: "ai"`) and authorize nothing, so a drop never gives the AI a file it could not read itself; a dropped folder is named in the prompt as inline code at the caret, never read into it. Composer derives `isBusy` from `agentMeta.status` so it can mount safely before sessions hydrate.
- **AI HTTP transport**: binary request bodies and response packets avoid JSON byte arrays. Native requests are owned by their calling window, explicitly cancelled on abort, page reload, or window destruction, and bounded to 16 concurrent requests. A 128 KiB byte window (at most 256 packets) carries at most 64 KiB per packet and coalesces ready network chunks; the webview acknowledges validated cumulative byte boundaries once half a window has arrived, so small SSE chunks cost no per-chunk IPC, and a consumer that grants no credit for two minutes is abandoned and its request cancelled. The frontend consumer queue is capped at 192 KiB, request bodies at 64 MiB, and request metadata at 64 KiB. Consumer cancellation during startup is repeated after native registration completes. SSRF validation and DNS pinning remain in Rust.
- **Voice input**: streamed transcription pipeline. Toggled from the composer.
- **Live context bridge**: `App.tsx` calls `setLive({ getCwd, getTerminalContext, … })` so tools can read the *currently active* terminal's cwd + last 300 lines of buffer. Lazy by design - don't pre-snapshot.
- **Tools** (`tools/tools.ts`): `read_file`, `list_directory`, `grep`, `glob` and the other read-only tools auto-execute. In Ask mode `write_file`, `edit`, `multi_edit`, `create_directory`, `bash_run`, `bash_background`, `spawn_coding_agent` and `send_to_agent` are `user-approval`: the AI SDK pauses for an in-UI confirmation card. Each conversation has an approval mode (`SessionMeta.approvalMode`, read through `normalizeApprovalMode`, so a missing or damaged value asks): **Ask** (the default) or **Auto-approve**. It is chosen in the composer (`ApprovalModeControl`), and new conversations start in the Settings default (Settings > Agents, `aiApprovalMode`, Ask unless changed). While Auto-approve is on, an amber chip in the composer turns it off in one click, and the mini window and the running status pill show it too. `TOOL_GATES` classifies every tool (exhaustive, so a new tool does not compile until it is classified): `none` (read-only, never asks), `approvable` (file changes), `approvable-outside-plan` (shell commands, which plan mode keeps asking for) and `always` (`spawn_coding_agent`, `send_to_agent`: they launch or message a coding agent, which no deny-list covers, so they ask in every mode); `use_skill` and `read_skill_file` are `none`. `runAgentStream` builds each run's `toolApproval` with `buildToolApproval`, whose gated entries read the conversation's mode and plan mode on every call, so turning Auto-approve off stops the next call even mid-run. An auto-approved call runs as a read-only tool does (no approval part); its `execute` still applies the path and command deny-lists. Sub-agents run under Ask mode's fixed `TOOL_APPROVAL`. Auto-send after approval uses `lastAssistantMessageIsCompleteWithApprovalResponses`. `lib/security.ts` is a deny-list refusing obvious secret paths (`.env*`, `.ssh/`, credentials, keychain dirs) - apply on **both** read and write paths and don't bypass it. Their file and shell calls carry `origin: "ai"` (`lib/native.ts`), so only "Allow AI tools to access all folders" takes them past the authorized folders; the deny-list and approvals apply either way, and the composer shows an "All folders" chip (`AllFoldersChip`) while it is on.
- **MCP resources and prompts** (`src/modules/mcp/`): the composer's `@` picker lists, after the workspace files, a section per running server with its resources and resource templates (`lib/pickerItems.ts`); a resource is read (`resources/read`) and attached like a file (`lib/resourceAttachments.ts`: text within the 200 KB of a text attachment, images as a pasted image is, anything else refused with the reason, at most ten parts), its chip names the server, and it is sent in an `<mcp-resource server=… name=… uri=…>` block that says it is the server's data (`lib/blocks.ts`, escaped like every block of a message, see Composer). A template opens a small form for its variables (`components/ArgumentsForm.tsx`, in the composer's popover; query variables are optional) with the server's `completion/complete` suggestions when it offers them, then attaches what it names. Prompts appear in the `/` list as `/<server>:<prompt>` (`lib/promptCommands.ts`: lowercase slugs, numbered when ambiguous, always with a colon so they never clash with a command or a skill); picked or typed, a prompt with arguments asks for them in the same form (required ones enforced), then `prompts/get` and its messages (text with their roles, images as file parts, embedded resources, `lib/promptMessages.ts`; over 200 KB of text is refused, not cut) are sent in an `<mcp-prompt>` block, which says they are the server's words, not the user's instructions, before the user's text. The transcript shows both blocks as chips naming the server.
- **Server requests** (`lib/requests.ts`, `components/McpRequestsHost.tsx` mounted by `AgentRunBridge`): a request from a server waits for the user in the window whose client got it (every window runs its own servers, so the request belongs to the window that started that server; there is no cross-window routing). None is answered on its own, whatever the server's trust or the conversation's approval mode; while no host is mounted (no composer) it is refused, at most one sampling and one elicitation per server wait at a time (another is refused), and it ends when the server cancels it or stops (disabled, removed, restarted, crashed). **Sampling** (`sampling/createMessage`, `lib/sampling.ts`) opens `components/SamplingDialog.tsx`: the server, its messages and system prompt (editable, images removable), max tokens (editable, capped at 8,192), temperature, stop sequences and model preferences, and a note when `includeContext` asked for context (Oarlock includes none). The model is the conversation's (`selectedModelId`) unless a usable configured model matches one of the server's hints (`chooseSamplingModel`), and the user can pick another; requests with tools, audio or images a provider refuses are refused. Approve runs it (`sampling/run.ts`, loaded then: `generateText` with only the request, no tools, the remembered reasoning effort, a temperature only when the model takes one and no effort is set), counts what it used in the meter of the conversation open in the window when the user approved, at the model that ran (nothing when no conversation is open or another has opened since), then the reply is shown (editable) with the tokens it used for a second approval before it is returned with the model's id and stop reason; Deny, closing the dialog or Don't send return the spec's `-1` rejection. **Elicitation** (form mode, `lib/elicitation.ts`) shows `components/ElicitationCard.tsx` in the chat (the host opens the mini window): the server's name and message as its words, fields built from the schema's flat primitives (string with length and the email, uri, date, date-time formats; number and integer with bounds; boolean; single and multiple choice with or without labels; defaults filled in), checked before sending, and Submit, Decline and Dismiss for the spec's accept, decline and cancel. Any other schema is refused with the reason (the SDK refuses most itself).
- **MCP tools**: `transport.ts` asks `@/modules/mcp` for the window's MCP tools on every run (see mcp/ above) and `runAgentStream` offers them beside the built-in tools, gated by `mcpToolGate` (`tools/tools.ts`): `mcp` (a server not marked Trusted) asks in every mode, Auto-approve included; `mcp-trusted` follows the conversation's mode as a shell command does (plan mode asks); a tool set to Always allow runs unasked in every mode, and one set to Never allow is not offered at all. `mcpToolsWithGates` offers a tool only with its gate, and a tool's annotations (`readOnlyHint` and the like) are never an input: they are shown on the approval card (`components/McpTool.tsx`: server, tool, arguments, annotations as the server's claims), never trusted. Sub-agents never get MCP tools. A call's UI part carries `toolMetadata.mcp` (server and tool) and the transcript marks its result as external; the system prompt says MCP results are untrusted data and adds each server's instructions (2,000 characters each) in an `<mcp-instructions server="...">` block, the name an escaped attribute and the closing tag escaped in the text, so neither a server's name nor its instructions can add a section that reads as Oarlock's own. History is converted with the run's tools plus a converter for MCP calls whose tool is gone (`lib/mcpHistory.ts`), so an old result's images still reach the model as files.
- **Skills** (`tools/skills.ts`, `src/modules/skills/`): the Agent Skills format (Claude Code's and Codex's skills work as they are). Each run lists the skills the conversation may use (on, trusted, not overridden; a project's over `~/.claude/skills` over Oarlock's folder). The system prompt's "Available skills" block names the ones the model may load with their descriptions, within 8,000 characters, and says a skill's text never overrides the rules or the approval mode. `use_skill` returns a skill's instructions, folder and file list; `read_skill_file` reads one of its text files (deny-list first); both never ask and are not limited by the folder limits, since the backend confines them to skill folders. A run without skills offers neither (`activeTools`). Scripts run through `bash_run`/`bash_background` with normal approval. `/skill-name text` in the composer (also in its `/` list) sends the skill's instructions with the text (`$ARGUMENTS`, `$N`, `${CLAUDE_SKILL_DIR}` filled in). Frontmatter rules and validation are in `docs/architecture/ai-subsystem.md`.
- **Edit diffs**: AI-proposed edits open in a side-by-side diff tab (`ai-diff` tab kind); user accepts/rejects per hunk before the write tool actually runs.
- **Superseded approvals**: only the newest message's approvals can be answered (`lib/toolApprovals.ts`). Every user message goes through `sendUserMessage` (`store/chatRuntime.ts`), which first settles unanswered approvals as denied, so no tool call is ever left without a result (`MissingToolResultsError`).
- **Prompt snippets** (`#handle`): reusable prompt fragments surfaced in the composer. They are not skills (see Skills).

### UI conventions

- **shadcn/ui** is configured (`components.json`, style `radix-luma`, base `mist`, icon lib **hugeicons**). Primitives in `src/components/ui/` - don't hand-edit; re-run `bun run shadcn add` to upgrade.
- **AI Elements** (Vercel) live in `src/components/ai-elements/` from the `@ai-elements` registry in `components.json`. Same rule: regenerate, don't hand-patch - composition wrappers belong in `modules/ai/components/`.
- **Tailwind v4** - no `tailwind.config.*`, config is in `src/styles/globals.css` via `@theme`. Use `cn()` from `@/lib/utils`.
- Animation: `motion` (Framer Motion successor). Resizable layout: `react-resizable-panels`.
- **Animation cost**: nothing animates forever at display rate. Tailwind `animate-spin`/`animate-pulse` are redefined in `globals.css` with `steps()` (12 and ~4 fps), the text shimmer uses 40 steps per sweep, recording indicators use `.oarlock-blink`, a pending tool approval uses the finite `.oarlock-attention-pulse`, and persisted history (`bash_background`) never animates. `modules/theme/windowActivity.ts` sets `html[data-window-inactive]` while the window is unfocused, hidden or occluded (DOM focus, document visibility and the terminal's shared native presentation feed, no extra native listener); that attribute pauses every CSS animation and an animated background image freezes on a still frame (`surfaceFrame.ts`). `prefers-reduced-motion` still removes the rest.
- **Compositing budget**: every composited layer costs a backing store, and WebKit allocates a new one per window-resize step for each layer that follows the window. At rest the shell has three layers with contents (page tile, terminal canvas, the terminal's hidden textarea); everything else is clip layers without backing. Do not add `will-change`, 3D transforms (`translateZ`, `transform-gpu`), `backdrop-filter`/`backdrop-blur` or blur filters to anything mounted by default; popovers, HUDs and chips use an opaque `bg-popover`/`bg-card` instead of a translucent blurred one. Only the allowlist in `src/styles/compositingBudget.test.ts` (modal scrims, the background-image overlay, ...) may, each with a reason. A static background image gets no layer (`surfaceOwnsLayer`). While a window drag is live, `html[data-live-resize]` (`modules/theme/livePageResize`, macOS only) gives the document an invisible size rounded up to 512 px so WebKit keeps one page tile size across the drag instead of one per step (`docs/architecture/app-lab.md`, "Compositing layers").
- **React Compiler** runs natively: `@vitejs/plugin-react`'s `compiler` option uses `oxc-transform-react`, a Rust port, so the build has no Babel pass (`vite build` about 2 s instead of 15). It applies the same rules-of-React bailouts as `babel-plugin-react-compiler` and additionally compiles components with value blocks inside try/catch, which the Babel plugin skips. `react-compiler-healthcheck` (CI, advisory) still runs the Babel plugin's checks.
- **Startup graph**: neither window may preload the AI SDK, zod, Streamdown, KaTeX, Mermaid, CodeMirror, the MCP SDK or the icon set, and the Markdown preview and chat load KaTeX and Mermaid only through the dynamic imports in `math.ts` and `MermaidBlock.tsx` (the `streamdown` chunk group holds Streamdown alone, not its plugins; `marked` has a chunk of its own, since the LSP client and Mermaid use it too). `vite.config.ts` splits chunks with two prioritised `codeSplitting` groups (eager `react`/`radix`/`ghostty-vt` outrank lazy features, because a lazy chunk's recursive dependency capture once swallowed React's CJS entry and made the eager `react` chunk import every AI provider). `src/app/dist-budget.test.ts` builds into a temp dir with sourcemaps and fails if any forbidden package or chunk is reachable from `index.html`/`settings.html`; `bun run check:dist` runs the same check on `dist/`. `eager-budget.test.ts` keeps the source-graph check.
- **Native context menu**: every window's entry installs `lib/nativeContextMenu.ts`, which prevents the webview's own menu except in text fields, the terminal (it hands the menu its selection) and on selected text that is no link or image: its page menu offers Reload, which reloads the window and ends every shell in it, and its link and image menus open them inside the webview. Our own menus (Radix) prevent it themselves. Ask AI appears only after a plain primary click, never with the text menu, and never while Settings, Agents, "Ask Oarlock on selected text" (`selectionAskAi`, on by default) is off; the Ask AI shortcut works either way.
- **Long AI chats**: messages older than the newest two get `content-visibility: auto` with an estimated `contain-intrinsic-size` (`messageHeightEstimate.ts`), so layout and paint cost tracks what is near the viewport.
- **Translucent terminals**: Settings, Themes, "Terminal opacity" (`terminalOpacity`, 0.3 to 1, opaque by default) times the alpha of the theme's terminal background lets what is behind the window show through the terminals. `applyVibrancy` (`WindowVibrancyBridge`) reads the theme's alpha, and below 1 sets `html[data-terminal-translucent]` and `--terminal-opacity`, asks for a see-through window and tells the window's renderers (`theme/terminalTranslucency.ts`; a window that never applies a backdrop, such as the quick terminal, stays opaque). The frame then becomes the terminal background at that opacity, `<html>`, `<body>`, the borderless `#root` and the workspace card while a terminal tab is active (`data-terminal-surface`) paint nothing, and both renderers leave cells on the default background (and the slack) transparent: the terminal and the frame are one sheet, so nothing between them stacks its opacity onto the terminal's. Text, coloured cells, selection and the cursor stay solid; other panes keep `--background`. The WebGPU window canvas is configured premultiplied only while its panes are translucent (configured again, same element, when that changes) and the shader takes the default background's alpha from `theme_background.a`; a WebGL renderer's context gets an alpha channel only for a translucent terminal (the pool matches it, `WebGlCellRenderer.translucent`), and a custom shader's pane stays opaque. With vibrancy on the sheet frosts; without it macOS shows the desktop unblurred, Windows likewise, and Linux needs a compositor.
- **Window vibrancy**: the `windowVibrancy` pref drives `WindowVibrancyBridge` (main window only - `window_set_backdrop` targets its caller). `html[data-vibrancy="on"]` (off by default; an explicitly stored choice always wins) makes `<html>`/`<body>` transparent and redefines `--frame` with alpha, so only the chrome frosts; panes keep `--background` so terminal text stays on a solid surface and the terminal canvas still matches its container (unless terminals are translucent, above). The opaque colour the pre-paint script parks on `<html>` would cover the backdrop, so `applyVibrancy` clears it while the effect is on; there is deliberately no localStorage fast path, since pre-declaring the effect would show a see-through window on any launch where the native call has not landed yet. Repeat applications are deduped, and only Mica is rebuilt on a light/dark flip (NSVisualEffectView adapts on its own).
- **Floating panes**: header and status bar are window chrome painted on `--frame` (derived from `--card`, so no theme declares it); the sidebar and the tab surface are `.oarlock-pane` cards on `--background` - same tone as the terminal canvas. Panes meet the chrome flush and are inset only horizontally, because the header centers its content and any vertical gutter would stack onto that padding and read as asymmetric. `.oarlock-pane` carries no drop shadow: `react-resizable-panels` clips panel content at the panel box, so a shadow would only render on the gutter sides.
- Path imports: always `@/…`, never relative across modules.
- Cross-platform paths: anywhere a path may originate from OSC 7, the explorer, or the OS, normalize separators with `.split(/[\\/]/)` rather than `.split("/")`.
- Canonical path form on the frontend is **forward-slash**. `homeDir()` returns backslashes on Windows; convert at the boundary (App.tsx setHome). OSC 7 already arrives as forward-slash. Equal canonical strings keep `useFileTree` from wiping its tree and flashing the explorer when `tab.cwd` first arrives.

### Window styling

- macOS: `titleBarStyle: Overlay` + `hiddenTitle: true` in `tauri.conf.json` (native traffic lights via overlay). Every app window puts the traffic lights at (14, 22), centred on its 40 px header (`trafficLightPosition` for `main`, `windows::TRAFFIC_LIGHTS` for the others), Settings 2 px lower on its 44 px header; in fullscreen, which hides them, the header drops the room it keeps for them. `lib/windowFrame.ts` follows each window's maximized and fullscreen state (one read in flight at a time, on resize) for `useWindowFrame` and as `data-window-maximized` / `data-window-fullscreen` on `<html>`. The main window is created opaque, because a non-opaque `NSWindow` makes WindowServer blend every terminal frame. `window_set_backdrop` makes the window and its `WKWebView` (`drawsBackground`) see-through only while vibrancy is on or terminals are translucent (`see_through`), and paints the opaque window with the theme's frame colour otherwise. `macOSPrivateApi: true` stays for that `WKWebView` key and the private `NSVisualEffectView` hosting, so the macOS build uses a private API and is not App Store eligible.
- Linux: `decorations: false` + `transparent: true` from `tauri.linux.conf.json`; re-asserted post-realize for GNOME/Mutter CSD. Windows and Linux stay transparent from creation because the borderless chrome paints its own rounded corners; a maximized or fullscreen window squares them and drops the frame's edge (`data-window-maximized`, `data-window-fullscreen`), and Settings rounds at 8 px to match the frame Windows 11 draws around its shadowed window. WebKitGTK commits DMABUF buffers without an explicit-sync acquire point, which an explicit-sync compositor (KWin 6.6+) answers with a protocol error that ends Oarlock before its window maps on NVIDIA, so `main.rs` sets `__NV_DISABLE_EXPLICIT_SYNC=1` before GTK starts, only on Wayland with `/sys/module/nvidia` present and never over a value the user set; PTY shells and one-shot commands get it removed again (`workspace::child_env_overrides`). WebKitGTK answers `prefers-color-scheme` from GTK 3's settings, which GNOME 42+ and KDE leave alone, so `color_scheme.rs` reads `org.freedesktop.appearance color-scheme` from the settings portal at start and on every change and mirrors it into `gtk-application-prefer-dark-theme` (no preference restores GTK's own value).
- Windows: same as Linux via `tauri.windows.conf.json`. React renders custom `WindowControls`.

### Tauri capabilities

`src-tauri/capabilities/default.json` is the allowlist for plugin APIs available to the webview. New plugins (dialog, autostart, updater, window-state, store, opener, os, log are wired in `lib.rs`; the store through `store_scope::plugin()`, which limits the files it opens) typically need:
1. `Cargo.toml` dependency
2. `.plugin(...)` call in `lib.rs` `run()`
3. capability entry in `default.json`

### Cross-platform conventions

- HOME / cache dirs: use the `dirs` crate (`dirs::home_dir()`, `dirs::cache_dir()`), never raw `$HOME` / `%USERPROFILE%`.
- Shell init scripts: gate Unix-only logic behind `#[cfg(unix)]`; Windows arm in `pty::shell_init::windows`.
- Terminal input: send `\r` (CR) for Enter, not `\n` (LF) - PowerShell on Windows requires CR.

### Bundle config

- `bundle.targets: "all"` plus per-platform sections in `tauri.conf.json`:
  - **macOS**: `minimumSystemVersion: 13.3`, the first release whose WebKit (Safari 16.4) parses the bundle: class static blocks (Radix, in the startup chunk) and regular expression lookbehind (Streamdown) are syntax errors in macOS 13.0 to 13.2, and a startup chunk that fails leaves the window blank. Tailwind v4 also targets Safari 16.4. `dist-budget.test.ts` scans every built chunk for syntax newer than the declared minimum's Safari.
  - **Linux**: deb depends `libwebkit2gtk-4.1-0`, `libgtk-3-0`; rpm `webkit2gtk4.1`, `gtk3`; AppImage bundles its media framework.
  - **Windows**: NSIS installer in `currentUser` mode (no admin required), WebView2 via `downloadBootstrapper`. Installing a missing WebView2 runtime requires internet access; there is no bundled offline runtime. Packaged and offline-install validation remains in the release-readiness gates.
- **Open in Oarlock and Open With** offer Oarlock for folders and for text and code files, and never make it the default app for anything (`src/app/os-integration.test.ts` locks this). There are no Tauri `fileAssociations`: its NSIS template sets each extension's default to the app. Windows (`installer-hooks.nsh`, per user): "Open in Oarlock" verbs on folders, folder backgrounds and drives, and for each text type the `Oarlock Document` ProgID in the extension's `OpenWithProgids` plus `Applications\oarlock.exe` with `SupportedTypes` (so it is not offered for other files); never a `*` verb or an extension's default value. Uninstall removes every key the install wrote. macOS (`Info.plist`): `CFBundleDocumentTypes` for `public.folder`, text UTIs and the same extension list, all `LSHandlerRank` `Alternate`. Its usage descriptions word macOS's privacy prompts (camera, microphone, the Desktop, Documents and Downloads folders, removable and network volumes, and iCloud Drive and other cloud storage through `NSFileProviderDomainUsageDescription`) for Oarlock and the programs in its terminals, which macOS counts as Oarlock (`mac-privacy/infoPlist.test.ts`). Linux (`linux/oarlock.desktop`, the deb and rpm `desktopTemplate`, which the AppImage reuses): `Exec=oarlock %F` and `MimeType=inode/directory;text/plain;` only, because GIO makes an app that names a type itself its default ahead of the desktop's `text/plain` default; code types reach Oarlock through `text/plain`. A session with no default configured at all can still pick any registered app.
- Files the OS opens go to the window in front through one queue per window (`LaunchFiles` in `lib.rs`, `second_launch::open_files`): queued, then announced (`oarlock:open-file`). Once its spaces are restored the page takes them with `get_launch_files` and again on each announcement, so a file that arrives while the window boots (Explorer starts one process per selected file, each handed over by single-instance) still opens, each file opens once, and a reload replays nothing. Explorer passes a drive root as `"C:\"`, which reaches argv as `C:"`; `unescape_root_quote` restores the backslash.
- Auto-updater registered with an empty key and no endpoint while updates are off (see updater/), and `createUpdaterArtifacts` is false, so a release builds no updater artifacts and needs no signing key; the plugin parses that configuration at startup (a test in `lib.rs` checks it). Turning updates on takes Oarlock's release feed, a minisign key pair (the public key here, the private key in the release workflow's secrets) and the updater artifacts together.
- `bundle.resources` includes `LICENSE` and `NOTICE` (Oarlock's Apache-2.0 license and its notice: the work Oarlock is based on, and where every third-party notice is), the upstream Ghostty, Restty, ghostty-web, and xterm.js license notices under `licenses/terminal/`, the Oarlock Symbols (Symbols Nerd Font and its icon sets) and JetBrains Mono notices under `licenses/fonts/`, and the colour schemes' notice under `licenses/themes/`; `bundle.licenseFile` shows `LICENSE` in the installers that show one, and copyright and publisher name Quantum Ops Consulting, LLC (`src/app/licensing.test.ts` locks all of it, and that `NOTICE` lists every notice that ships). Repository documentation and test-only reference WASM cores are not packaged; the frontend includes only the adapted SIMD and scalar cores.
- Icons are a placeholder mark: `oarlock-icon.svg` is the source and `oarlock-icon.png` its 1024 px render, from which `bun run tauri icon oarlock-icon.png` generates every size in `src-tauri/icons`; `public/logo.png` (the favicon and the in-app logo) is a 256 px render of the same mark.

### Known gotchas

- **Syntax highlighting identity**: parsers and editor themes must use the same `@lezer/highlight` instance. The `overrides` entry in `package.json` resolves every consumer to one copy; raise it together with the direct dependency to upgrade them all at once. Duplicate copies silently hide token styles even when parsing succeeds. Language highlighting tests exercise every editor theme and chat code blocks; the built-output check also requires one highlighter module.
- **One marked**: Streamdown (block splitting), Mermaid (Markdown labels, `marked.lexer`) and the LSP client (hover and completion docs, `marked.parse`) share one marked. A top-level `marked` override in `package.json` holds every copy at the major Streamdown depends on (Mermaid's and the LSP client's own ranges ask for 16; the APIs they call are unchanged). It is top-level rather than scoped to those two because a scoped override needs `bun.lock` version 3, which Dependabot may not read. When Streamdown moves to a new marked major, check those two against its changelog before raising the override with it, and check any new package that depends on marked. The built-output check fails on a second copy of any package except the ones Mermaid's layouts need: cose-base and layout-base 1 (mindmaps) beside 2 (architecture), whose layout differs, and d3-sankey's older d3-array, d3-shape and d3-path (sharing the 3.x ones saves 0.1 KB and rounds Sankey link paths). The LSP library renders hover and completion docs with `marked.parse` straight into `innerHTML`, so `lsp/lib/safeMarkdown.ts` installs a renderer on that shared instance when the LSP client loads: raw HTML shows as text, links keep only web and mail targets and carry `target="_blank"` (the opener plugin opens those in the browser; a plain link would navigate the window), and images show their alt text. It changes rendering only, which Streamdown and Mermaid (lexer users) never touch.
- **React 19 strict mode** double-mounts `useEffect` in dev → terminals spawn twice on first render. The first PTY is cleaned up almost immediately. The `CONPTY_LIFECYCLE_LOCK` mutex serializes this; don't be alarmed by `pty opened id=1` followed by `pty closed id=1` in dev logs.
- **Windows PowerShell process lifecycle**: `killer.kill()` from `portable-pty` only kills the immediate child. Descendants (e.g. `npm run dev` started inside pwsh) survive unless something else takes them down. The Job Object in `proc/job.rs` handles this for the Oarlock-process-death case; an explicit `pty_close` from JS also kills only the immediate child + relies on the Job to take the rest. Don't disable the Job without a replacement.
- **Panics**: release builds unwind (`panic = "unwind"`), so a panic ends only its thread or async task. `modules/panics.rs` logs every panic (there is no crash report), long-lived loops (fs watcher) isolate each unit of work, a PTY reader panic fails that terminal at once, and the PTY hub aborts the process because its state cannot be trusted afterwards. A panic on the main thread (non-async commands, window and menu callbacks) still ends the app. A panic while holding a `std` lock poisons it; recover with `unwrap_or_else(PoisonError::into_inner)` on shared hot-path locks.
- **Tab `cwd` storage**: comes from OSC 7 with forward slashes (after `parseOsc7` strips `/C:` → `C:`). Anything that consumes `tab.cwd` and passes it to a Rust fs command on Windows must normalize separators or accept both forms - `apply_common` in `pty::shell_init` handles this for PTY spawn; other call sites must do their own.

## Further reading

Long-form contributor guides live under `docs/`. These guides elaborate on `AGENTS.md`; if anything conflicts, `AGENTS.md` wins.

- `docs/README.md` - index of contributor guides
- `docs/architecture/two-process-model.md` - IPC boundary and command reference
- `docs/architecture/pty-shell-integration.md` - PTY, shell init scripts, OSC, ConPTY, Job Object
- `docs/architecture/pty-transport-v2.md` - multiplexed PTY output stream: hub, wire format, presentation classes, credit; `scripts/pty-smoke/` drives it in a real debug app (`bun scripts/pty-smoke/run.ts`)
- `docs/architecture/security-model.md` - consolidated security model and boundaries
- `docs/architecture/ai-subsystem.md` - AI stack, sessions, tools, adding a provider
- `docs/architecture/terminal-renderer-pool.md` - model ownership and presentation pool invariants
- `docs/contributing/testing.md` - testing contract and core-subsystem invariants


### Resource ownership across spaces and windows

A mounted editor, Markdown preview and terminal retains its owning space's
`WorkspaceEnv` through `workspace/owner.tsx`. Document reads, conflict checks,
writes, formatters, assets, file watches and PTY startup must carry that environment
through asynchronous work. Navigation never retargets an existing resource.
AI turns capture their environment, paths and terminal context; approval continuations
keep that capture. Persistent AI shells are scoped by conversation, environment
and owning space; changing spaces cannot inherit another space's shell cwd.
Queued plan edits carry their environment through Apply.
UI actions that create tabs refuse to run in a different space from their owner.

Shared conversation metadata uses native `ai_sessions_mutate` transactions
(`modules/ai_metadata.rs`), with individual creates, field patches and deletions.
No window writes a replacement history list. Native revision numbers order
snapshots and notifications; deletion tombstones prevent stale creation from
reviving a removed chat. Failed local metadata transactions retry in order.
A deletion received from another window stops and releases every matching local
chat, including background chats, and cancels pending message persistence.

Foreground AI shell commands inherit chat cancellation.
Closing a shell session removes it and marks its lifetime cancelled, including pending
spawns, and terminates its process trees. The frontend discards that cached shell
so a later turn starts a fresh one. Foreground commands clean up remaining descendants
when their shell exits; background jobs stay running and stoppable until their
descendants finish. App shutdown waits for background kill workers to signal their
trees before the process exits. Unix managed commands retain the shell unreaped (`waitid` with
`WNOWAIT`) so its process group cannot be reused before cleanup. After a background
shell exits, group membership is checked every 250 ms. On Windows, processes are
created suspended, assigned to a Job Object, then resumed; background jobs retain
that object until its active-process count reaches zero. WSL commands
run under a Linux session supervisor (`setsid --wait`, from util-linux), whose private
stdin pipe kills its process group on EOF. User commands still read `/dev/null`.
Explicit background jobs carry their chat id. Settings > Agents > "Stop background
jobs with chat" also stops those jobs on Stop or deletion, including late spawn
replies. This setting defaults off; unrelated chats' jobs are never stopped.
Background job admission and retention are process-wide (`shell/job_registry.rs`):
at most 16 running or starting jobs, plus the latest 32 finished jobs ordered by
completion. Reserve before spawning and release on failure; pending replies count
against admission, including a process that exits before publication. Completion
callbacks evict only finished entries and release their log buffers outside the
registry lock; no polling, timer or next request is needed to prune. Running jobs
are never evicted. Handles never wrap or get reused; expired log handles return an
explicit history-expired/unknown error. Shutdown closes admission and rejects late
publication, stopping that process.

Read-only subagents have their own cancellation controllers and a separate Settings >
Agents > "Stop subagents with chat" switch (on by default). Off lets them finish after
Stop or chat deletion. `ai_subagents.rs` owns independent records, serialized updates,
per-page owner tokens and cross-window cancellation. Closing/reloading the owner
interrupts its runs and revokes updates. Records load only on first use; running
records from an earlier app lifetime become interrupted. At most eight subagents run
at once; the latest 32 finished tasks remain in `oarlock-subagents.json`, with bounded
instructions/results. `trackedSubagent.ts` serializes progress and final writes and
counts usage independently of chat selection. The lazy Tasks dialog in both AI
headers exposes status, instructions, results, token counts and manual cancellation.

AI read-cache hashes track both file identity and whether the model has seen its
complete contents (`ReadCacheEntry.fullContent`). Partial or truncated reads satisfy
read-before-edit but never suppress unread content with an `unchanged` reply.
An edit preserves complete-read knowledge only for a matching fully read input;
a full-file write supplies all its contents. Each subagent gets a fresh read cache
alongside its fresh messages. Context compaction clears the parent's cache because
elided file contents must be read again before suppression or editing.


Stop is a shared per-chat barrier (`ai_chat_control.rs`, `store/chatStop.ts`),
not a fire-and-forget cancellation request. Each window registers before model work;
native Stop blocks admission, requests every owner's SDK cleanup, cancels foreground
sessions, and waits for acknowledgments and pending shell/subagent starts. The two
Stop settings decide whether independent background jobs and subagents must also
finish cancelling. Failed or timed-out cleanup keeps the chat blocked with Retry Stop.
Native session/job admission and Stop serialize under the same small control lock;
slow spawning and cleanup run outside it. A stale acknowledgment cannot release a
new Stop. Window closure releases its acknowledgment, while native cleanup still
owns foreground sessions and admitted background starts. The frontend drains startup
work and discards idle cached shells too. A cancelled turn cannot reopen an old shell
or let a delayed bulk Stop reach the next turn. Context is captured before asynchronous
admission; approval continuations still belong to that original context.

Managed commands must run in foreground mode, without daemonization, `setsid`, or
self-detachment. This is a supported-program contract, not Unix process containment:
process groups cannot supervise a program that deliberately leaves them. Settings >
Agents > "Allow unmanaged detached commands" is off by default and exposes the separate
`bash_detach` tool only when enabled. Native launch rechecks the persisted opt-in and
workspace authorization. This explicit unmanaged path has null stdio, no job handle,
no log retention, no Stop or app-exit cleanup, and no managed-job cap; its PID names
the launcher only. Disabling the setting refuses future explicit launches, without
stopping already detached commands. A small reaper prevents launcher zombies.

The shared Stop barrier and explicit unmanaged-launch setting add 2.7 kB of
gzipped client JavaScript in the release build, without a dependency. The total
client budget was 2807.5 kB before unavailable-space presentation; startup and
terminal budgets remain unchanged.

Foreground shell sessions also belong to their native window's page lifetime
(`shell/session_registry.rs`). Close and reload synchronously revoke that lifetime
and reject pending opens from it, even if a replacement page uses the same label.
They request cancellation immediately, then terminate process groups/jobs on the
blocking pool. Sessions undergoing cleanup remain reachable by Stop and app shutdown
until cleanup finishes; concurrent cancellers wait for the same process cleanup.
Other windows' foreground commands, including those using the same shared chat,
and app-managed background jobs are unaffected by window closure. No frontend IPC
round-trip, timer, or additional JS is needed for this ownership.

Native shell-session run requests must match the session's bound environment; an
override cannot retarget a WSL shell to the host or another distribution. Control-pipe
cancellation waits for the supervisor to exit after EOF before releasing ownership.

Unsupported environments fail at the shared `WorkspaceEnv` IPC deserializer and
`resolve_path` boundary. On macOS/Linux a WSL space cannot fall back to host paths,
even when that path exists and is authorized locally. Path resolution is fallible;
files, assets, git and watches propagate or safely skip the rejection. Space metadata
stays raw JSON in persistence and is never rewritten to Local or dropped. The UI
marks unsupported spaces unavailable, keeps their tabs stored, excludes their
resource components from mounting, and disables their sidebar, composer and git
refresh. Other spaces' live resources remain mounted. AI transport refuses an
unsupported environment before starting MCP/model work. This platform check does
not start WSL, allocate a worker, or add a per-operation IPC request.

Unavailable-space checks and presentation add about 0.9 kB of gzipped client JS,
with no dependency. The measured total after the switch/admission guards below is 2808.403 kB;
its budget remains 2808.5 kB.

Workspace-home adoption is ordered by a window-local generation. A newer environment
or window unmount invalidates old home/cwd lookups and pending space creation; home
authorization carries the requested environment explicitly. During adoption the old
home/cwd are cleared, and failed or stale lookups cannot publish fallback paths.
Local startup lookups cannot overwrite a later adopted environment.

MCP run preparation captures configuration at submission, but waits for the shared
chat admission barrier before starting servers. Cancellation is checked after config
loading, lazy runtime loading and listener installation. Model startup also rechecks
cancellation after asynchronous project-memory and skill preparation. Existing shared
MCP servers are not stopped by a rejected run.

Active AI turns retain their submitted project's MCP servers through native,
window-owned run leases (`mcp/leases.rs`). Space changes update the visible catalog
but keep those servers callable by their original turns; another project's tools
are excluded from the turn's snapshot. Native launch and per-message trust checks
accept only a window's current or retained project and still validate the current
file hash and server entry. Revoking trust or changing the entry revokes access.
Completion, failure and Stop release the lease; close/reload revoke all leases and
pending starts from that page lifetime. Settings includes retained projects so
users can still revoke them. Empty configurations retain no project or worker;
leases are bounded to 64 per window, and the MCP SDK remains lazy. Configuration
refreshes ignore superseded replies, so a delayed space-switch refresh cannot stop
a server retained by a newer run.

Persistent AI shell commands serialize per session. A bounded streaming parser
observes stdout before its display cap and extracts NUL-terminated cwd metadata,
preserving spaces and newlines in paths even after output truncation. Missing,
invalid or inaccessible cwd metadata returns the command's output with an explicit
error and null cwd; that session refuses subsequent execution until Stop clears it.
It never silently resets to the previous directory after `exit`, `exec` or timeout.
Cancellation is checked before and after waiting for the session lock, so a retired
window's late command cannot delay its foreground cleanup.

Run leases and stream cleanup add 0.8 kB of gzipped client JS without a new
dependency (2809.226 kB total; budget 2809.5 kB). Startup, terminal and WASM budgets
are unchanged. Extra native/config reads occur at AI-run preparation; there is no
idle polling. Native HTTP and stdio publication checks the captured page lifetime
under the same lock used by close/reload, including delayed DNS or spawn results.

Stop also waits for asynchronous MCP lease release before acknowledging cleanup.
Cwd-frame removal preserves command output arriving after the metadata. Windows
PowerShell writes cwd metadata as explicit UTF-8 bytes rather than its console
codepage. A host with only cmd.exe receives a clear error before a persistent AI
command executes; the PowerShell metadata script is never handed to cmd.exe.

MCP ownership includes pending tool approvals. The stream records unanswered approval
requests; a clean approval pause transfers the lease to its chat rather than releasing
it. A continuation acquires its new lease before releasing the paused one, preserving
the same server session across navigation. New messages, errors, Stop and deletion
release it; failed release IPC stays reachable for Retry Stop. Paused chats with
project leases are excluded from chat-LRU eviction, preserving their captured context;
the existing native per-window lease cap bounds them. Global-only MCP runs retain no
project lease. Stop denies unanswered approvals and releases paused leases before its
native acknowledgment. `/stop` is available in the composer even when idle, so an
unknown-cwd shell can be reset after the reply finishes, with the normal cancellation
settings and no model request.

Foreground shell run/close IPC checks the handle's native window and current page
lifetime. A foreign or reloaded page cannot run or close it. Spawn cwd authorization
and execution preserve nonempty path whitespace; `folder` and `folder ` are distinct
paths and cannot authorize each other. The user-terminal fallback preserves the same
spelling as its authorization check.

Approval-pause retention and idle Stop recovery add about 0.6 kB gzipped client JS
(2809.830 kB total; budget 2810 kB), without a dependency or idle polling. Startup,
terminal and WASM budgets remain unchanged.

Composer submissions have cancellable preparation (`ai/lib/composerWork.ts`). Stop
cancels it synchronously in every owning window; chat, space or environment changes
cancel it through subscriptions present only while preparation is pending. Returning
to the old space cannot revive a cancelled submission. Native skill reads may finish,
but their results cannot send a turn. MCP prompt fetches carry the abort signal;
argument forms settle as cancelled and stale Submit callbacks do nothing. The draft
stays intact. Ownership transfers to the existing chat/model cancellation path as soon
as the message is accepted; preparation listeners then unsubscribe. `/stop` remains
usable while preparation is pending, and handled command chips are consumed so they
cannot intercept the next ordinary message.

Stop denies unanswered approvals after the SDK's request pipeline has finished, so a
final buffered approval cannot remain actionable after acknowledgment. MCP leases
register with the chat as soon as native acquisition completes, before configuration
loading or tool discovery can fail; failed cleanup therefore remains reachable by Stop.

Composer preparation registers its window with the native chat Stop coordinator
before loading a skill or prompt. This adds one admission IPC per submitted message
and lets another window stop preparation even before this window's first model run.
The transport still checks admission for model runs and approval continuations.

Preparation cancellation, command consumption and cleanup recovery add about 0.8 kB
of gzipped client JS (2810.658 kB total; budget 2811 kB), without a dependency or idle
polling. Startup is 248.735 kB; terminal, WebGL and WASM budgets are unchanged.

The composer exposes preparation as busy, so its Send button becomes Stop before
skill reads or MCP prompt requests finish. Its MCP picker includes the current
project's enabled servers on first use, even without any global server configured.
Failed MCP listener setup removes partial registrations and remains retryable;
late registration results are cleaned up too.
These fixes add 108 bytes of gzipped client JS (2810.766 kB total), within the
existing 2811 kB budget; terminal and WASM sizes are unchanged.

MCP Settings saves native transactions (`mcp/settings.rs`) against the current
`oarlock-mcp.json` contents, under one process-wide mutex. Settings sends only
changed fields and individual tool choices; independent edits survive, and the
last applied change wins for the same policy field. Transport and credentials
form one versioned unit: edits must match both the saved transport and revision;
stale dialogs are rejected, including when they only change a secret. Creates
never replace an existing id and updates never recreate a deleted server.
Project policy changes must match the currently trusted entry hash; a changed
entry retains Off and Never allow but drops prior grants. Invalid transactions
are discarded before publication, save failures leave the in-memory snapshot unchanged,
and successful saves notify all windows. No worker or polling runs while idle.

Approvals expire when a chat runtime is reconstructed after reload, cache eviction,
or opening stored history in another window. Waiting and approved-but-unexecuted
calls become denied with an explanation to send a fresh request. Completed calls
and live runtimes are unchanged. The transport also refuses an approval continuation
without an original binding before any model or tool preparation begins.
Denied tool cards display the reason, including the instruction to request expired
work again. Transactions and approval expiration add 359 bytes of gzipped client JS
(2811.125 kB total; budget 2811.5 kB), without a dependency. Startup is 248.733 kB;
terminal, WebGL and WASM sizes are unchanged.

MCP tool, prompt and resource lists reject superseded replies from the same
connection. Tool notifications received during initial discovery trigger one
follow-up refresh; separate prompt/resource counters preserve independent lists.
Settings updates fill omitted optional fields using the reader's defaults before
validation, so existing minimal configurations remain editable. Malformed project
records return an error instead of panicking while holding the settings mutex.
Expiring or stopping an already-approved call without a recorded result explains
that execution may have started; it never claims the tool definitely did not run.
These discovery and approval corrections add 179 bytes of gzipped client JS
(2811.304 kB total), within the existing 2811.5 kB budget. Terminal and WASM sizes
remain unchanged.

MCP credential saves (`mcp/credentials.rs`) validate the entire transaction before
keychain access. Replacement accounts use a native random namespace; unchanged
secrets are copied into it, and only an atomic settings-file replacement publishes
that namespace. Failed staging or persistence keeps the previous configuration,
secrets and OAuth records active. Cleanup retires only unreferenced accounts;
a cleanup failure can leave unreachable keychain entries, never activate them.
Deletion commits before retiring credentials. Imports may stage only new global
ids, and failed imports clean up their staging accounts. Direct secret-write IPC
is removed; tool-cache writes use the same native transaction and atomic file
replacement, so they cannot race with configuration persistence.

Global MCP launches accept a server id and revision and read their command, URL
and credentials from the native saved configuration. HTTP sessions check their
revision before requests and again under the OAuth credential lock before reading
or refreshing tokens. OAuth accounts and token caches use the same namespace;
transport or credential changes invalidate pending sign-ins and require a fresh
sign-in. Sign-in preparation, refresh and configuration publication share a
per-server lock; waiting for the browser does not hold it. Late token reads cannot
repopulate a retired namespace. A lazy native index holds only revisions and
namespaces, avoiding full configuration clones on each HTTP request. Independent
On/Off, trust and tool choices continue to merge without rotating credentials.
No dependency, worker or polling timer is added.

The credential transaction fix reduces total gzipped client JS by 209 bytes to
2,811,095 bytes, within the unchanged 2,811,500-byte budget. Startup is 248,735
bytes; terminal, WebGL and WASM sizes are unchanged. Fault-injection tests cover
partial keychain writes, failed file persistence, failed deletion and cleanup
errors; stale URL/header edits and reserved credential namespaces are rejected.

MCP configuration now has one native owner (`mcp/storage.rs`); it reads the existing
`oarlock-mcp.json` in place and exposes read-only keyed snapshots to the UI. It
never registers with the general-purpose store plugin, whose exit hook performs
non-atomic writes even with autosave disabled. The plugin scope refuses this
filename and case aliases in every window. Loads distinguish a missing file from
an unreadable, malformed or incorrectly shaped one, reject duplicate identities
and invalid credential namespaces, and bound the file to 64 MiB on read and write.
A failed load creates no writable cache and leaves the file intact; Settings shows
the error and a Retry action. Successful commits atomically replace the file before
swapping the in-memory snapshot. Reads and shutdown never rewrite it. Legacy
optional fields remain readable without migration writes or credential changes.

OAuth UI reads reject superseded replies and replies for obsolete server lists;
late status replies cannot start probes for a now-disabled configuration, and
obsolete probe results cannot relabel it. Action
results must match both the latest action and its transport/credential version.
Failed probes can retry on a later refresh. Explicit sign-out propagates keychain
deletion errors and preserves the cached sign-in until removal succeeds. Failed
token reads do not become cached "no sign-in" results: later requests retry, while
late reads preserve a newer sign-in/sign-out and cannot repopulate retired versions.
The store migration and OAuth UI fixes add 297 bytes of gzipped client JS
(2,811,392 bytes total), within the unchanged 2,811,500-byte budget. Startup,
terminal, WebGL and WASM sizes are unchanged; no dependency or idle worker is added.

Settings publishes project servers only together with their saved policies. A
failed policy read leaves the previous complete snapshot visible (or no servers
on first load), so default On choices cannot trigger probes during recovery.
Malformed stored project policies fail loading rather than silently reverting to
defaults. Retry reads the repaired file before publishing the server list.

OAuth sign-in has an explicit saving phase. The pending-sign-in mutex makes
cancellation and entry into saving mutually exclusive; once saving starts,
Cancel and replacement sign-ins fail with a visible explanation until the write
finishes. Status exposes saving without waiting for a cold keychain read. The
browser receives success only after token persistence succeeds, or the actual
failure when it does not; browser response writes have a ten-second bound.
Completion clears only its own pending identity. A rejected Cancel preserves
the saving action's UI completion, and a superseded successful action still
reconnects its server when its transport/credential version remains current.
Tests cover cancellation before commit, concurrent cancellation/replacement
during saving, failed persistence, obsolete completion and UI action races.

Native comparison of stored transports matches the editor's handling of blank
optional cwd and trimmed OAuth client/scopes, so imported values do not cause
false stale-editor errors. Nonblank cwd spelling is preserved. OAuth callback
request heads count the terminating CRLF bytes against their 8 KiB limit, even
when the terminator arrives in the final read. These corrections add 58 bytes
of gzipped client JS (2,811,450 bytes total), within the unchanged 2,811,500-byte
budget; no dependency or idle worker is added.


Development builds use `consulting.quantumops.oarlock.dev` before Tauri initializes
paths or plugins (`profile.rs`). Production identifiers, data paths and keychain
service names are unchanged. Non-production profiles qualify keychain services
with their identifier and use separate control descriptors/CLI launchers and
login-startup entries; the
normal external CLI continues to address production, while terminals receive
their own profile's descriptor. Development shell-integration files use a separate
cache on host and WSL. Both builds install the single-instance plugin, so a second
development launch forwards to development, never to production. Explicit app-lab
identifiers remain intact. Development starts with a fresh profile; production
settings and secrets are neither copied nor migrated.

OAuth metadata discovery cannot overwrite authentication completed while the
network probe was pending. Its result is checked under the existing credential
lock against the current namespace, successful token-read cache and pending
sign-in before publishing a requirement. Unknown keychain state is not proof of
missing credentials. Settings does not probe during browser sign-in or token
saving, and cached requirements count only for their matching server URL.

The staged-keychain and profile fixes add no client code or dependency. The OAuth
probe guard adds 9 bytes of gzipped client JS (2,811,459 bytes total), within the
unchanged 2,811,500-byte budget. Startup, terminal, WebGL and WASM sizes are unchanged.


Linux secret-file writes (`secrets/file.rs`) use an exclusively created 0600
same-directory temporary file, flush/sync it and atomically replace the store.
They never reuse the predictable `secrets.json.tmp` path, whose permissions or
symlink target could survive a failed write. Failed sync preserves old secrets
and removes staging. Only a genuinely missing store reads as empty; dangling
symlinks and malformed/unreadable files report errors. This persistence core is
tested on Unix hosts, including non-Linux CI, without touching real credentials.

OAuth sign-out publishes removal of tokens even if deleting the separate client
registration fails. Settings refreshes after failed sign-out to show committed
state while retaining the cleanup error. This change reduces gzipped client JS
by 6 bytes to 2,811,453 bytes, within the existing 2,811,500-byte budget. Native
credential and fish fixes add no client dependency or idle worker.

Zsh startup recognizes both production and development wrapper directories when
Oarlock is launched from another Oarlock terminal. It carries forward the saved
user ZDOTDIR (or the default home), never sources another wrapper as user config,
and drops stale saved values when ZDOTDIR was unset. A real zsh regression test
checks that cross-profile startup reads the user's startup file exactly once.

Shell integration scripts use one shared atomic writer on Unix and Windows/WSL.
Each write creates its own exclusive temporary file in the destination directory;
parallel terminal launches cannot truncate one another's staged or published script.
Predictable leftover staging files and symlinks are never opened. Failed publication
removes only that writer's staging file and preserves the previous destination.
Tests cover parallel readers/writers, leftover symlinks and failed replacement.

AI provider and endpoint key removal propagates native deletion errors. Settings
shows the error and retains the provider/endpoint and its model selection until
key deletion succeeds, so a locked credential store cannot masquerade as removal.
A successful endpoint-key deletion notifies other windows before endpoint settings
are removed; a subsequent settings failure cannot leave those windows using a
deleted cached key.

Custom endpoint keys carry an origin (scheme, hostname and effective port) in the
same versioned keychain record as the key (`ai/lib/endpointCredentials.ts`). Chat,
subagents, model browsing and editor autocomplete check that binding at use time.
Changing the path on the same origin keeps the key usable; changing scheme, host
or port requires re-entering a key. Settings never sends a saved key to a different
URL draft. Old plain keys remain stored but have no trusted origin and require
re-entry or removal; there is no automatic binding of legacy keys to a current URL.
Named endpoints never fall back to the legacy provider-wide compatible key, even
when a matching model was cached earlier. Delayed saves keep the origin captured
when requested, and stale key reads cannot replace newer UI state. Autocomplete
caches the provider/model owner with its key and validates origin against the URL
used for each completion. No credential values are saved in preferences.

These fixes add 293 bytes of gzipped client JS (2,811,746 total). The total-client
budget is adjusted by 300 bytes to 2,811,800 for the credential binding and failure
UI; startup JS decreases to 248,214 bytes through shared chunks. Terminal, WebGL
and WASM sizes are unchanged. No dependency, periodic worker or extra normal-path
IPC is introduced. Renderer surface tests inject a non-exhausting raster budget
unless testing exhaustion explicitly, so machine scheduling cannot fail a test
that expects all glyphs to be prepared in one frame.

AI bootstrap and editor autocomplete register their credential-change listener
before taking the initial key snapshot. A deletion during asynchronous listener
registration is therefore observed by that first read even if its event arrived
too early. Unmounting before registration finishes removes the late listener;
registration failures are reported and do not load a snapshot that cannot stay
in sync. Generation guards still reject reads superseded by a newer event.

Legacy fish-hook migration treats a missing source after inspection as success
when another terminal/profile already retired it. Concurrent first launches keep
one backup and both retain their private launch-time integration. Other rename
failures remain errors. A deterministic interleaving test covers this race.

These race fixes add 55 bytes of gzipped client JS (2,811,801 total), with a
100-byte adjustment of the total-client budget to 2,811,900. Startup is 248,244
bytes; terminal, WebGL and WASM sizes are unchanged. Listener registration still
uses one subscription and one initial read per credential batch; no polling,
additional normal-path IPC, dependency or background worker is introduced.

Custom AI endpoint metadata is owned by Rust (`ai_endpoints.rs`) in
`oarlock-endpoints.json`, which the general store plugin cannot open. First load
migrates the existing endpoint list (including an explicitly empty list), or the
old single compatible endpoint, retaining IDs and therefore keychain/model
associations. Even an empty migration is saved atomically before caching; later
plugin writes to the old settings file cannot resurrect removed endpoints. An
unreadable or invalid native file reports an error without falling back to legacy
data or replacing the file. Migration itself leaves legacy settings untouched.

Settings sends native create, delete-by-ID and per-field patches, serialized
against the current snapshot under one process-wide gate. Only Settings may
mutate this metadata. Native creates assign fresh random identities; updates to
a deleted identity fail instead of resurrecting it. Failed persistence retains
the previous in-memory snapshot and cleans its exclusive staging file. Endpoint
credentials keep their existing origin-bound keychain storage. Credential
mutations and endpoint deletion now share the native endpoint gate, as detailed
below. General model selection preferences remain separate.

Windows subscribe before reading endpoint snapshots and reject older or duplicate
revisions. File-recovery Retry broadcasts a native snapshot through that same
revision check, including to other windows, so a delayed retry cannot undo a
newer edit or deletion. The native wire format explicitly keeps `baseURL` (not
Rust's default `baseUrl`); a literal browser-shaped fixture tests creation, URL
patching, serialization and legacy migration together. Concurrent native edits,
deleted IDs, migration/reopen, damaged files, staging cleanup and delayed UI
snapshots have regression coverage. The old frontend migration is removed.

This adds one native metadata cache and one event subscription per window, with
an initial read and a post-subscription read to close the startup race. Edits use
one patch IPC and one snapshot event; no polling, dependency or idle worker is
added. Gzipped client JS is 2,812,023 bytes (+222), with the total-client budget
adjusted by 200 bytes to 2,812,100. Startup JS is 248,237 bytes; terminal JS is
92,541 bytes, WebGL is 16,465 bytes and WASM is unchanged at 654,361 bytes.

Endpoint recovery retains saved custom-model selections, favorites and recents
when the native file cannot be read. A load failure is not deletion: the selected
custom model stays unresolved and its execution fails until recovery, instead of
silently falling back to a cloud provider. Successfully loaded lists still apply
the existing validation of removed or unfinished models.

Manual endpoint Retry reconnects failed event subscriptions before reading. Live
observers share an in-flight registration, and both native events and the retry
reply pass through the observer's revision check. Disposal removes the observer
and any listener that finishes registering afterward. No retry timer is created.
AI bootstrap watches changes to endpoint identities in the existing preferences
store and reloads endpoint keys after metadata recovery, even without a keychain
change event. Endpoint reads have their own generation guard, so deletion or a
newer read defeats a delayed result. Name/URL edits do not reread credentials and
endpoint changes do not reload provider keys. Tests cover recovery, stale replies,
registration failure/concurrency/disposal and failure-safe model selection.

Recovery fixes add 189 bytes of gzipped client JS (2,812,212 total), with a
200-byte total-client budget adjustment to 2,812,300. Startup JS is 248,308
bytes; terminal JS is 92,540 bytes and WebGL/WASM are unchanged. The only added
steady-state subscription is an in-memory preferences observer per AI window;
manual reconnection and identity-triggered key reads add no idle IPC, dependency,
worker or polling.


Endpoint credential saves, key removal and endpoint deletion share the native
endpoint gate (`ai_endpoints.rs`). Saves validate the live endpoint identity and
compare the requested URL's normalized origin with the current saved origin
before touching credentials. A changed origin or deleted ID rejects the save;
path changes on the same origin remain valid. Rust writes the existing versioned
origin/key record, with the same account names and size limit. Generic secrets
write/delete IPC accepts only exact provider account names, so endpoint writes
cannot bypass the gate through case or Unicode aliases. Reads retain compatibility.
Only Settings may invoke endpoint mutations. Lock order is endpoint gate then
secret-store gate, all on the blocking pool.

Deletion validates metadata first, removes its key, then publishes the new endpoint
snapshot. If key removal fails, the endpoint stays available to retry. If key
removal succeeds but metadata persistence fails, the endpoint remains without its
key; deletion can be retried. Native key-change notifications also fire after
failed key operations because chunk cleanup may fail after removing the head.
This is ordered coordination, not a rollback transaction across the keychain and
filesystem. Settings listens before reading keys, ignores stale reads and uses
native notifications instead of optimistic credential replies; it does not update
model selections until native endpoint deletion succeeds.

Regression tests cover a save holding the gate while deletion waits, rejection of
saves after deletion, stale origins, normalized same-origin URLs, invalid keys,
partial key cleanup, metadata-write failure after key deletion, generic-IPC bypass
attempts and Settings refreshing credentials when deletion later reports an error.
Compressed client JS decreases by 43 bytes to 2,812,169, within the unchanged
2,812,300-byte budget. Startup JS is 248,314 bytes; terminal, WebGL and WASM sizes
are unchanged. No dependency, polling or idle worker is added; Models settings
holds one key-change listener while mounted. Endpoint deletion now uses one native
mutation instead of separate key-delete, page notification and metadata calls.

AI model-cache identities encode the provider, credentials, model ID and server
URLs as a JSON tuple. Space-delimited concatenation allowed distinct user-supplied
configurations to collide and reuse a model targeting another server. A regression
test supplies colliding model/URL strings, verifies distinct model instances and
checks the actual request URL through the proxy fixture; identical configurations
still reuse their model.

Editor autocomplete checks connection readiness in a dependency-light helper
(`autocomplete/configuration.ts`). LM Studio, MLX and Ollama require their server
URL, and custom endpoints their URL; cloud providers require a key. MLX/Ollama
must never be rejected for lacking a key they do not use. Provider-matrix tests
cover configured, empty and whitespace-only URLs, plus cloud-key requirements.

These fixes add 28 bytes of compressed client JS (2,812,197 total), within the
unchanged 2,812,300-byte budget. Startup JS is 248,312 bytes; terminal, WebGL and
WASM sizes are unchanged. They add no dependency, worker, subscription or IPC.

The historical `openai-compatible-custom` model ID is an alias of `compat-legacy`,
which resolves exclusively to native endpoint ID `legacy`. Chat, subagents,
model-configuration checks, labels and context budgeting share the same endpoint
identity helpers. The old single-endpoint URL/model/context fields remain stored
for migration, but transport and model-building inputs no longer accept them.
If the migrated endpoint is absent, execution fails even when old preferences
still contain a complete URL/model pair or an earlier model is cached. Editing
the native endpoint changes the target and context limit for old references too.

Loaded default, autocomplete, favorite and recent selections canonicalize the old
ID; lists deduplicate aliases. Chat selection also canonicalizes restored IDs.
A saved legacy default whose endpoint is gone stays blocked, rather than silently
switching to a cloud model. The retired provider-wide compatible key neither
provides model credentials nor enables AI on its own. Custom model builders take
only explicitly selected credentials; editor autocomplete passes its origin-checked
key explicitly. Existing stored keys and migration-source settings are retained.
Tests cover old references with stale preferences, native edits/removal, cached
models after deletion, context limits, canonical selection/recents and explicit
credentials for autocomplete.

This removes 235 bytes of compressed client JS (2,811,962 total), within the
unchanged 2,812,300-byte budget. Startup JS is 248,279 bytes; terminal, WebGL and
WASM sizes are unchanged. No dependency, worker, subscription or IPC is added.

Editor autocomplete aborts pending requests and debounce timers on every document
or selection change, including formatter, reload and other programmatic edits.
A response must still match the original document and current provider, model,
credentials, server URLs, filename, language and indent unit before it can be
cached or displayed. Cache identities include the entire bounded model context
(4,000 prefix and 2,000 suffix characters) as a JSON tuple, not just its final
512/first 128 characters or ambiguous delimiters. Configuration changes separate
cache contents. The cache retains at most 32 entries and 64 KiB of estimated
UTF-16 key/value text, including JSON escaping; this bounds the larger identities
without retaining complete document objects or repeating credentials per entry.

Regression tests drive the actual CodeMirror plugin with deferred model responses
and real EditorState transactions. They cover programmatic edits at an unchanged
cursor, immediate typing cancellation, changed settings while a response waits,
model/filename cache separation, edits outside the old context tail, exact-request
cache reuse and memory-bound LRU eviction. Settings notifications immediately
cancel requests and debounce timers, clear visible suggestions and discard cached
results when completion inputs change. Key-change notifications force cancellation
before reading the keychain, including requests that began without a key; publishing
a newly read key also invalidates any intervening request. Neither notification
starts completion: the next edit or manual trigger does. Unchanged completion
inputs preserve current work. Existing pane subscriptions supply the notifications,
and the driver's weak-map registration makes late notifications after teardown
no-ops; teardown also releases cached text and configuration. Regression tests cover
these transitions, disabled/re-enabled completion, stale keyless responses and
late notifications after destruction.

Validation for this pass: 4,603 frontend tests and 1,277 Rust tests pass (three
Rust tests ignored); type checks, Clippy, production build and dist graph pass.
Lint remains at 86 warnings and one info. Compressed client JS adds 134 bytes to
2,812,096, within the unchanged 2,812,300-byte budget; startup, terminal, WebGL
and WASM sizes are unchanged. No dependency, subscription, polling or IPC is added.

The approved autocomplete notification lifecycle adds five regression tests:
4,608 frontend tests and 1,277 Rust tests pass (three Rust tests ignored). Types,
Clippy, production build and dist graph pass; lint remains at 86 warnings and one
info. Compressed client JS adds 81 bytes to 2,812,177, within the unchanged budget;
startup JS is 248,277 bytes and terminal/WebGL/WASM sizes are unchanged. Existing
subscriptions are reused, with no added dependency, IPC, polling or idle worker.

Autocomplete also refreshes its context after a pane applies indentation and when
its language/path context changes, including completion of lazy language loading.
Preference notifications arrive before CodeMirror installs the new indent facet,
so that earlier notification alone cannot invalidate suggestions for the old unit.
Whole-suggestion and word acceptance revalidate context before editing as a final
guard against a delayed notification. Requests require exactly one selection:
a single insertion point must not replace a multi-cursor selection. Six regression
cases cover both acceptance commands after indentation/file changes, cancellation
after a pane publishes its indentation, and preservation of multiple cursors.

Autocomplete credential readiness is explicit: loading, failed, ready with a key,
or confirmed keyless. A provider/model change invalidates the previous read; only
a current successful lookup can enable a custom endpoint without a saved key.
Local providers that never use keys are inherently keyless. Cloud providers require
a loaded key. Custom endpoints apply the same origin-binding condition as chat:
existing credentials with an unknown or different origin block execution. Both the
editor trigger and requestCompletion enforce readiness before model construction;
readiness changes cancel pending work and clear suggestions without starting a request.

The editor subscribes to key notifications before loading credentials and retains
its generation guard across provider/model changes and teardown. Lookup failures
remain blocked and offer retry by toggling autocomplete off/on; notification setup
failures remain blocked until the window reloads. No automatic retry or polling is
introduced. Existing keyring get-functions retain their nullable fallback behavior;
strict read-functions preserve errors for this lifecycle. The secrets_get IPC's
optional strict flag also rejects damaged, incomplete or digest-mismatched stored
values; only actual absence returns null. Legacy native callers keep their existing
policy. Strict reads share the same locked read and do not issue extra keychain reads.

Regression cases cover missing versus failed lookups, origin changes, legacy unbound
keys, delayed identity mismatches, cloud/local/custom provider readiness, keyless
startup without automatic resumption, and rejection before model creation or network
generation. Native tests cover damaged headers, incomplete or altered staged
Windows generations, and old split records, while retaining compatibility reads.

Validation for the editor-context follow-up: 4,614 frontend tests and 1,277 Rust
tests pass (three Rust tests ignored). Types, Clippy, production build and dist
graph pass; lint remains at 86 warnings and one info. Compressed client JS adds
25 bytes to 2,812,202, within the unchanged budget. Startup, terminal, WebGL and
WASM sizes are unchanged. No dependency, subscription, timer or IPC is added.

Validation for explicit credential readiness: 4,631 frontend tests and 1,278 Rust
tests pass (three Rust tests ignored). Types, Clippy, build and dist graph pass;
lint remains at 86 warnings and one info. Compressed client JS adds 261 bytes to
2,812,463; its allowance rises by 300 bytes to 2,812,600 for this readiness boundary.
Startup JS is 248,279 bytes; terminal, WebGL and WASM sizes are unchanged. There
are no new dependencies, subscriptions, idle workers or polling, and the native
strict option uses the existing single credential-read IPC.

Strict credential reads also reject an existing empty value. Only an absent
entry is keyless; an empty entry is retained for replacement or removal, while
legacy reads keep their prior behavior. A native regression reproduces the empty
entry and verifies strict rejection without deleting it, plus genuine absence
after explicit removal. Settings endpoint cards share ProviderKeyCard's mask:
keys of eight UTF-16 units or fewer are fully hidden rather than displaying all
characters through overlapping prefix/suffix previews. Three tests render the
actual custom-endpoint card with short keys and verify its visible preview.

Bulk credential reads return a strict per-entry status: ready with a value,
ready with confirmed absence, or failed with an error. A failed batch marks all
requested credentials failed; it never retries as nullable individual reads.
Chat and Settings retain loading and failed entries separately from null. Key
refreshes invalidate the old snapshot before awaiting native reads, and generation
guards discard obsolete results. The shared model resolver and model builder
block unresolved credentials before cache reuse or network generation, including
subagents; only a successful missing-key lookup permits custom keyless execution.
Speech and key-presence indicators accept resolved strings only. A loaded composer
stays mounted during refresh or failure so its draft and error surface remain
available while new requests are blocked.

Settings retains failed provider and endpoint cards, with Retry, Replace and
Remove controls. Retry reconnects its notification listener if necessary, then
broadcasts the existing key-change event so registered windows refresh together.
Failed removal preserves recovery controls and reports the error. Model browsing
is disabled while the endpoint credential is unavailable or belongs to another
origin. No automatic retry, polling or per-key fallback is introduced.

Validation for empty-value rejection and credential masking: 4,634 frontend tests
and 1,279 Rust tests pass (three Rust tests ignored). Types, Clippy, production
build and dist graph pass; lint remains at 86 warnings and one info. Compressed
client JS decreases by 22 bytes to 2,812,441, within the unchanged budget; startup,
terminal, WebGL and WASM sizes are unchanged. No dependency, retained state,
subscription, timer, IPC or extra keychain read is added.

Validation for shared credential readiness and recovery: 4,652 frontend tests
and 1,280 Rust tests pass (three Rust tests ignored). Types, Clippy, production
build and dist graph pass; lint remains at 86 warnings and one info. Regression
coverage includes mixed successful/failed batch reads, failed and pending chat
and subagent credentials, cached-model rejection, stale refreshes, recovery UI,
failed removal, listener recovery and composer retention. Compressed client JS
adds 84 bytes to 2,812,525, within the unchanged 2,812,600-byte allowance; startup
JS is 248,329 bytes, and terminal, WebGL and WASM sizes are unchanged. There are
no new dependencies, idle timers or polling. Bulk reads keep the existing batched
IPC and lock; Settings shares one key listener between provider and endpoint reads.

Model browsing binds both cached results and in-flight requests to the current
URL, credential and readiness state. Changing any of them immediately hides the
old choices, even if it later changes back; an explicit open/Refresh requests
fresh models. Context cleanup, unmount and replacement requests abort the native
fetch, and late responses cannot restore stale choices. Cleanup checks its owning
context so a delayed old cleanup cannot cancel a newer request. This is local to
the existing browser component, with no shared state, listeners or idle polling.
Eight component regressions cover cache identity, readiness changes, ignored
abort, unmount and delayed cleanup; the transport test verifies signal forwarding.

Voice input owns permission acquisition, recording and transcription as one
composer operation (`voiceRecording.ts`, dependency-light and injected for tests).
It registers with the existing chat Stop gate before acquiring the microphone,
and uses composer-work cancellation for Stop and deletion. Chat, space and
environment navigation, panel closure, the AI-to-shell input switch and composer
teardown cancel it and discard unfinished audio without changing the text draft.
Only active voice work subscribes to chat, space, environment and transcription
settings stores; completion or cancellation removes those subscriptions. The controller reserves a run before
awaiting permission, so double clicks cannot open two microphones. A late grant
releases its own tracks without starting recording; old errors, recorder events
and responses cannot change a newer run. Cancellation detaches recorder handlers
before stop so teardown cannot trigger an upload. Failed recorder teardown still
releases tracks.

The microphone button's explicit Stop & transcribe still submits audio. During
permission acquisition or transcription the button cancels instead. Hidden
composers cannot acquire a microphone. Browser permission prompts themselves are
not cancellable; a grant after cancellation is released immediately. Transcription
starts from fresh settings and a ready credential snapshot. Relevant settings or
selected credential changes cancel acquisition, recording and transcription at
once, preserving the text draft. Unrelated providers' settings and credentials
do not interrupt it. Its owning signal reaches
the OpenAI SDK, REST fetch and WAV conversion; late decoding cannot start an
upload. REST timeout/cancellation remains active through response-body consumption,
not just headers. Whisper.cpp's offline upload rejects redirects: a local-server
307 reproduction previously forwarded the audio to a second server.

Validation for model-browser ownership: 4,661 frontend tests and 1,280 Rust tests
pass (three Rust tests ignored). Types, Clippy, build, dist graph and size checks
pass; lint stays at 86 warnings and one info. Compressed client JS adds 225 bytes
to 2,812,750; the total allowance rises by 300 bytes to 2,812,900 for request
invalidation and cancellation. Startup JS (248,329 bytes), terminal, WebGL and
WASM sizes are unchanged. No dependency or IPC round trip is added, and an abort
controller is allocated only when the user requests a model list.

Validation for voice ownership and offline redirects: 4,689 frontend tests and
1,280 Rust tests pass (three Rust tests ignored). Types, Clippy, production build,
dist graph and size checks pass. Lint falls to 82 warnings with no info diagnostics.
The added regressions cover Stop during admission, delayed permission and recorder
events, navigation and close, cancellation during transcription and WAV decoding,
new-run isolation, credential refresh, stalled response bodies and real local HTTP
redirect rejection using synthetic audio. Compressed client JS adds 611 bytes to
2,813,361; its allowance rises by 600 bytes to 2,813,500. Startup JS is 248,398
bytes; terminal, WebGL and WASM sizes are unchanged. No dependency, polling or idle
subscription is added. Each voice start uses one existing chat-admission IPC, and
only active transcription owns timeout and abort listeners.

Attachment imports belong to the initiating composer's chat, space and environment.
Stop, navigation, closing the composer and unmount discard unfinished imports;
completed draft attachments and text remain. Each active import registers with the
existing composer cancellation owner and chat-admission barrier. Store listeners
exist only while the import is active. Picker results and native reads that cannot
be interrupted are discarded when they return after cancellation. Image conversion
checks cancellation between asynchronous stages and closes late ImageBitmaps.
MCP resource reads, template submission and argument completion receive the same
abort signal. Replacing or dismissing a template form cancels its operation; late
results cannot attach or steal focus.

File content crosses `fs/attachment.rs` through `ai_import_attachment`. The native
OS picker selects host paths, including in a WSL space; explorer paths retain their
owning workspace environment. Copied file paths also use the native boundary, and
a refused file never falls back to clipboard pixels. Browser File objects are used
only to detect an image paste, never as an unchecked source of file content.
Native clipboard pixels remain available for screenshots. The boundary checks the
requested path, canonical path and opened file's path against the shared secret
policy before reading. It also enforces workspace AI authorization, regular files,
absolute resolved paths, a 200 KB text limit and a 15 MiB source limit. Picked files
grant their selected folder once; dropped files grant nothing. Revalidation of the
opened descriptor catches a symlink swap between canonicalization and open. Binary image
signatures identify formats; valid UTF-8 without NULs remains text unless its
filename identifies an image. HEIC/HEIF and SVG filename hints select the existing
webview conversion path, which must decode them before they can be sent. Shared native secret-path
and base64 helpers avoid duplicating the skills policy and OAuth encoder.

Offline transcription checks cancellation after reading the Blob and before
starting decodeAudioData; closing the AudioContext alone did not prevent a late
decode from starting.

Validation for attachment environment capture and cancellation before decoding:
4,692 frontend tests and 1,280 Rust tests pass (three Rust tests ignored). Types,
Clippy, production build, dist graph and size checks pass; lint stays at 82
warnings. Compressed client JS adds 31 bytes to 2,813,392, inside the unchanged
2,813,500-byte allowance. Startup JS is 248,403 bytes; terminal, WebGL and WASM
sizes are unchanged. No dependency, timer, retained cache or IPC round trip is
added; a dropped-file read uses one temporary bound native client.

Validation for native attachment imports and composer import cancellation: 4,703
frontend tests and 1,284 Rust tests pass (three Rust tests ignored). Types, Clippy,
production build, dist graph and size checks pass; lint stays at 82 warnings.
Regressions cover delayed picker, native file, clipboard and MCP results, Stop,
chat/space/environment changes, close, retained drafts, rejected-file batches,
late bitmap disposal, secret names, protected symlink targets and a path swapped
before open. Compressed client JS is 2,813,120 bytes (272 fewer), inside the
unchanged 2,813,500-byte allowance. Startup JS is 248,363 bytes; terminal, WebGL and
WASM sizes are unchanged. No dependency, polling or persistent cache is added.
Each import batch uses one chat-admission call; each file uses one native import
instead of separate frontend authorization/canonicalization/read calls. Image
paste first checks native clipboard paths. Native tests ran on macOS; Windows and
Linux picker, handle-path and clipboard integration still need platform testing.

Attachment classification also preserves ordinary text beginning with weak image
signatures (`P1`, `BM`, `DDS`, `GIF89a`) and routes HEIC/HEIF and SVG files to the
existing image converter. Native path, handle, authorization and source-size checks
still run first. Image paste now uses one primary-selection decision for both
browser-provided image files and native fallback: Linux middle-click must never
read an unrelated ordinary clipboard.

Send is blocked while any attachment import is pending, including native picking,
clipboard loading and MCP resource/template forms. The status bar shows Stop for
that interval. The import owner publishes only first-start and last-finish busy
transitions, and submission checks its live pending set before beginning any
preparation, so a handler captured before React renders cannot send too early.
Finishing one of several imports does not enable Send. Stop, failure, close and
navigation release finished/cancelled work; an obsolete read finishing later cannot
release a newer import's barrier. Completed attachments and the draft remain.
Sending requires a new explicit Send after imports finish; no submission is queued.
Import state does not trigger the agent-response autofocus effect.

Validation for attachment type classification and primary-selection routing:
4,704 frontend tests and 1,286 Rust tests pass (three Rust tests ignored). Types,
Clippy, build, dist graph and size checks pass; lint stays at 82 warnings. Client
JS is 2,813,103 compressed bytes, 17 fewer; the size allowance is unchanged.
Startup JS is 248,362 bytes; terminal, WebGL and WASM sizes are unchanged. The
classification helper adds no dependency, IPC, cache or background work. Native
validation ran on macOS; actual HEIC decoding and Linux primary-selection UI
behavior still require platform integration testing.

Validation for the import submission barrier: 4,709 frontend tests and 1,286 Rust
tests pass (three Rust tests ignored). Types, Clippy, build, dist graph and size
checks pass; lint stays at 82 warnings. Regressions cover submission before React
commits busy state, inclusion of completed imports in the next explicit Send,
pickers and multi-file batches, failures, Stop, concurrent owners and obsolete
completion after a replacement import starts. Compressed client JS adds 39 bytes
to 2,813,142, within the unchanged allowance; startup, terminal, WebGL and WASM
sizes are unchanged. No dependency, IPC, polling or idle listener is added. Busy
state updates only when the pending set becomes nonempty or empty, not per file
or progress event.

Paste source tracking consumes a middle-click hint for one paste only and clears
it on keyboard input or another pointer gesture. A regular image paste immediately
after a middle click must not be mistaken for the primary selection and dropped.
The existing one-second freshness bound remains, and timestamps before the
initiating gesture are rejected.

Voice acquisition, recording and transcription participate in the composer's
submission barrier. React state exposes Stop and disables Send; the voice
controller's synchronous `busy()` check also blocks handlers captured before a
render. Microphone Stop still transcribes, while chat Stop, navigation and close
discard unfinished audio. Completing transcription updates the draft and requires
an explicit Send. Voice state does not trigger the response autofocus effect.

AI paste uses `ai_clipboard_snapshot`, one native capture of file paths or pixels,
started alongside chat admission rather than after it. macOS changeCount and
Windows clipboard sequence numbers are recorded at command entry, before the
blocking-worker queue, and bracket path discovery and image capture;
a changed or unverifiable generation is rejected without retrying against new
contents. Linux uses one GTK clipboard with an active-only owner-change handler
and a five-second timeout, disconnecting and removing the timer on completion,
change or timeout. Displays without selection-change notifications refuse capture.
GTK APIs were checked against the locked 0.18 sources and its
[owner-change contract](https://docs.gtk.org/gtk3/signal.Clipboard.owner-change.html).
Copied-file representations with unusable local paths fail rather than falling
back to pixels; ordinary web URLs accompanying image copies are not file paths.
Captured paths still cross the native attachment authorization and secret-path
boundary before file content is read.

The snapshot returns a binary frame (0 empty, 1 PNG, 2 JSON paths), avoiding a
base64 copy for clipboard images. PNG encoding stays on blocking workers; Linux
copies the captured pixel data on the GTK thread and converts padded RGB/RGBA rows
on the worker. Existing clipboard pixel/PNG size bounds apply. Snapshot errors
remain visible, and cancellation discards late results. No second clipboard read
occurs after admission, so later clipboard changes cannot replace captured content.

Validation for one-paste source hints: 4,712 frontend tests and 1,286 Rust tests
pass (three Rust tests ignored). Types, Clippy, production build, dist graph and
size checks pass; lint stays at 82 warnings. Regressions cover consuming the hint,
keyboard/right/left-click invalidation, expiry and mismatched event timestamps.
Compressed client JS adds 106 bytes to 2,813,248, within the unchanged allowance;
startup JS is 248,364 bytes. Terminal, WebGL and WASM sizes are unchanged. No
new dependency, IPC, polling, DOM listener or cache is added; one small gesture
tracker is retained per mounted composer. Linux middle-click UI integration still
requires platform testing.

Validation for voice submission ownership and native clipboard snapshots: 4,715
frontend tests and 1,289 Rust tests pass (three Rust tests ignored). Types, Clippy,
production build, dist graph and size checks pass; lint stays at 82 warnings.
Regressions cover pre-render Send, every voice phase, late cancellation, snapshot
capture during delayed admission, changed/failed captures, invalid binary frames,
file-before-pixel priority, revision checks and padded RGB conversion. Compressed
client JS adds 147 bytes to 2,813,395 within the unchanged allowance. Startup JS,
terminal, WebGL and WASM sizes are unchanged. No new dependency or idle timer is
added; Linux owns a signal handler and timeout only during capture. Image paste
uses one snapshot IPC in place of separate path and pixel reads. Native tests ran
on macOS. A separate API-only compilation checked the Linux-specific GTK calls
against the locked crates; it did not link or run a Linux desktop. Live Windows,
X11 and Wayland clipboard integration still require platform tests.

Microphone Stop failures now report the error and cancel the owned recording,
releasing tracks and the submission barrier. If a recorder delivered its stop
event before throwing, the same cancellation aborts any transcription it started;
a late result cannot append to the draft. macOS/Windows clipboard capture also
checks the command-entry generation before the worker reads any paths or pixels,
so a clipboard change while waiting for a worker cannot silently replace the paste.

Voice configuration ownership is approved and implemented. `voiceConfiguration.ts`
compares the provider, that provider's model/local URL and its ready key. Each
Start reads current stores rather than using the previous render's settings;
missing/loading/failed cloud credentials prevent microphone acquisition. Active
store subscriptions cancel on relevant changes, including credential removal or
refresh into an unresolved state. Switching back cannot revive cancelled audio.
The transcription uses the same settings/key snapshot that owned its recording.
Only the active operation adds a settings subscription; no idle listener, timer,
dependency or IPC is added, and two render subscriptions to unused provider
options have been removed.

Validation for microphone Stop failures and queued clipboard capture: 4,717
frontend tests and 1,290 Rust tests pass (three Rust tests ignored). Types, Clippy,
build, dist graph and size checks pass; lint stays at 82 warnings. Regressions
cover thrown Stop, a stop event followed by a thrown error, aborted transcription
and rejected clipboard changes before a worker starts reading. Compressed client
JS adds 29 bytes to 2,813,424 within the unchanged allowance; startup JS is 248,365
bytes. Terminal, WebGL and WASM sizes are unchanged. No dependency, idle work or
IPC is added. macOS/Windows perform one additional generation comparison before
content reads; native tests ran on macOS. Live Windows and Linux clipboard
integration remains unverified.

Offline WAV conversion now mixes every decoded microphone channel into mono,
normalized by the channel count, instead of silently keeping only channel zero.
A synthetic stereo recording with speech only on the right reproduced a silent
upload before the fix. The pure `wav.ts` encoder retains the recording's sample
rate and duration, clips PCM16 samples and does not mutate or copy input channel
data. It allocates only a small channel-reference array in addition to the
existing WAV buffer, and runs only during offline transcription. Cancellation
checks still surround asynchronous decoding before encoding or upload. The
[current Whisper.cpp decoder](https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/common-whisper.cpp)
performs the sample-rate conversion itself.

Validation for voice configuration cancellation and offline channel mixing: 4,755
frontend tests and 1,290 Rust tests pass (three Rust tests ignored). Types, Clippy,
production build, dist graph and size checks pass; lint stays at 82 warnings.
Regressions cover settings and key changes during admission, permission, recording
and transcription, late microphone grants/results, unrelated changes, stale Start
handlers, listener cleanup, right-only stereo speech, mono/stereo/multichannel
normalization, clipping, WAV headers and duration. Compressed client JS adds 126
bytes to 2,813,550; the allowance increases by 100 bytes to 2,813,600 for the active
configuration checks and corrected channel mixing. Startup JS remains 248,365
bytes; terminal, WebGL and WASM sizes are unchanged. Native checks ran on macOS;
live Windows/X11/Wayland clipboard tests remain outstanding. A private macOS
pasteboard experiment showed that PNG-only contents are synthesized as TIFF for
the existing reader, disproving a suspected format regression; no clipboard format
change was retained.

Review follow-up: ordinary preferences still have two unversioned update sources.
The locked store plugin emits `store://change` globally from its native store;
`writePref` additionally emits the original value after awaiting `save`. Controlled
concurrent-save reproductions show an older delayed save restoring OpenAI in live
state after Whisper.cpp is saved, and restoring `aiAllFolders: true` after false
is saved. Persistence retains the latest value while subscribers are rewound by
the duplicate event. `syncAllFolders` forwards these live values to the native
permission gate, so this is release-blocking beyond the voice UI. Separately,
`usePreferencesStore.init` loads its snapshot before registering listeners; a
change during that read is permanently missed by the opening window. Its
subscription promise is also not awaited, so initialization success does not
confirm a working change listener.

The native-owned, revisioned preference snapshot/update stream is approved and
implemented in `modules/preferences.rs`. Rust alone reads and atomically replaces
`oarlock-preferences.json`; the old `oarlock-settings.json` is a read-only migration
source, retained for endpoint migration and recovery. The store plugin refuses
both names, preventing its exit hook from rewriting either file. Missing data
migrates once; unreadable, malformed or invalidly typed saved values are retained
and reported, never replaced with defaults. A mutex serializes disk commits,
revision allocation, permission-gate updates and event emission. Terminal behavior
and per-server LSP activation use field patches, so independent edits merge.

`settings/nativePreferences.ts` installs the listener before reading its initial
snapshot, ignores stale revisions and coalesces snapshot recovery after a revision
gap. Ordinary updates carry only changed fields and need no follow-up read. UI
preferences publish together, retain unchanged field references and share one
subscription with the theme. Failed startup and recovery offer Retry; unresolved
preferences block microphone acquisition, and a failure during voice work cancels
it. Native folder-access gates follow only committed values, never window events;
managed-shell detachment reads this same native store. There is no new dependency,
polling timer or per-window writer. The migration source remains untouched.

The native preference boundary validates nested shortcut bindings and custom
language-server entries as well as top-level types. Invalid key types, missing
language-server fields and malformed collections fail before consumers can throw
on `.toLowerCase()`, `.length` or language-map lookup. Existing files are preserved
and can be repaired before Retry; failed writes publish no speculative values.

R216 remains in progress. Preference and theme catalog reads use a retained
directory and check the opened file against its entry; preference commits use
the conditional metadata-preserving writer with their own 64 MiB limit. The
local `tauri-plugin-store` fork checks every store read and write without
following a final symlink and refuses hard-linked entries. Workspace file saves
and Explorer mutations check known native store and agent-settings identities.
The inventory and remaining gaps are recorded in `REVIEW_LEDGER.md`; these
partial changes do not yet establish the complete native-store boundary.

Validation for native revisioned preferences: 4,770 frontend tests pass across
514 files, and 1,298 Rust tests pass with three ignored. Types, Clippy, production
build, dist graph and size checks pass; lint remains
at 82 warnings. Tests cover delayed startup reads/events/mutation responses,
missed-revision recovery, failed startup cleanup and Retry, unchanged object
identity, native field merging, migration, damaged files and failed commits.
Compressed client JS is 2,814,899 bytes, an increase of 1,349 bytes; its allowance
rises by 1,300 bytes to 2,814,900 for revision coordination and error recovery.
Startup JS is 248,423 bytes (+58), terminal JS 92,546 bytes (+6); WebGL and WASM
are unchanged. Rust checks ran on macOS; live Windows/X11/Wayland clipboard
integration remains outstanding.

Preferences reconnects now own their in-flight reads by listener generation.
Disconnect invalidates the old read and listener callbacks. A replacement listener
always starts a fresh read; late old results/errors cannot populate or fail it,
and an old promise cannot clear the replacement's read-coalescing slot. Controlled
reconnect tests reproduced a stale OpenAI snapshot hiding a later Whisper.cpp
change while the listener was absent. Recovery retains `hydrated` after the first
valid snapshot: its separate `error` marks synchronization failure. Resetting the
startup flag hid the quick terminal and revived startup sidebar/background values.
Voice still cancels on the error, including when hydration remains true.

Resolved architecture review: a controlled real chat/runtime/transport test with
failed preference loading and a synthetic ready OpenAI key reached the model runner
with `gpt-5.4-mini`, empty custom instructions and the submitted message. Voice
checks preference readiness, but chat admission does not. The reproduction mocks
the runner (no network or paid request) and is retained outside the passing suite
at `/tmp/oarlock-review34-ai-readiness-repro.test.ts`, with its failed expectation
in `/tmp/oarlock-review34-ai-readiness-repro.log`. The user approved requiring synchronized preferences for new AI requests and
approval continuations, and cancelling autocomplete on synchronization failure.
That contract is implemented below; the original reproduction now passes as
`chatRuntime.preferences.test.ts`.

Validation for reconnect ownership and retained UI hydration: 4,772 frontend tests
pass across 514 files. Types, Clippy, build, dist graph and size checks pass; lint
remains at 82 warnings. The first Rust run had one macOS FSEvents burst test fail
with no directory event inside its 1.2-second window; it then passed alone and
all 1,298 Rust tests passed on a full rerun (three ignored). No watcher code or
test deadline was changed; the intermittent event-delivery failure remains a
review follow-up. Compressed client JS is 2,814,928 bytes (+29); the allowance is
2,814,950 (+50). Startup JS is 248,421 bytes and terminal JS 92,545 bytes; WebGL
and WASM are unchanged. No dependency, IPC per ordinary update or idle timer was
added. Live Windows/X11/Wayland clipboard integration remains unverified.

AI preference readiness is shared through `settings/readiness.ts`: a successful
initial snapshot, no known revision gap and no synchronization error are all
required. `hydrated` still preserves the UI's last loaded snapshot; `syncing`
separately marks an in-flight gap recovery. Receiving an out-of-sequence delta
sets it immediately, before a recovery read can finish or fail. Failed recovery
keeps AI blocked. Its persistent, deduplicated Retry toast disappears on success.

New chat messages check before accepting or clearing their drafts; automatic
approval continuations check transport admission too. Approval buttons leave the
card unanswered when blocked, and the transport retains its pending MCP lease
until an allowed continuation or the existing Stop/deletion cleanup. Admission
is rechecked after MCP preparation and after asynchronous model loading, before
sending content. Tracked subagents, approved MCP sampling and commit-message
requests (including repair attempts) use the same gate. Agent/subagent execution
cores receive a readiness callback from their owner. Recovery does not replay
requests or answer approvals; the user must retry. Already-started chat runs
retain their existing lifetime and cancellation rules.

Autocomplete derives execution settings in the pure `completionPreferences`
function; unreadiness disables the driver immediately, cancelling debounce and
requests and clearing visible/cached suggestions. A cancelled request also checks
its signal after model loading, before `generateText`. Recovery resumes only on
the next edit or manual trigger. Voice uses the same readiness predicate, so
known revision gaps cancel unfinished recordings/transcriptions as read failures
do. Existing subscriptions carry these changes; no polling, new dependency or
additional IPC per AI request is introduced.

Validation for AI preference readiness: 4,799 frontend tests pass across 517
files, and 1,298 Rust tests pass with three ignored. All seven preference-store
tests pass, including repeated failed Retry. Types, lint (82 existing
warnings), Clippy, production build, dist graph and size checks pass. Regressions
cover blocked startup and failed/gap recovery, preserved drafts and approvals,
MCP lease retention/cleanup, delayed model preparation, subagent and sampling
admission, cancelled autocomplete model loading, suggestion/cache clearing and
explicit retry after recovery. The macOS watcher test passed in this run; its
prior intermittent failure remains a review follow-up. Compressed client JS is
2,815,782 bytes (+854), with an allowance of 2,815,800 (+850); startup JS is
248,470 bytes (+49), terminal JS 92,546 (+1), WebGL/WASM unchanged. Native checks
ran on macOS; live Windows/X11/Wayland clipboard tests remain outstanding.

Preference Retry actions prevent the notification library's default click-dismiss;
an unsuccessful retry keeps the existing recovery action available. Successful
snapshot recovery explicitly dismisses the shared notification. This is covered
with a failing read, another failed Retry, and then a successful Retry.

Review follow-up after AI readiness: three source-control defects are reproduced
and held for the user's architecture decisions. AI commit-message generation
passes the aggregate staged `git_diff` straight to the model; a temporary Git
repository with a synthetic `.env` token proved that native diff returns it,
and the real panel hook passed it to a mocked `generateText`. The ordinary Git
viewer currently shares that read path. The proposed AI-only native Git-content
boundary must cover protected paths on both sides of renames/history; the user
has been asked whether protected staged files should refuse generation entirely
(recommended) or be omitted with a notice. No real secret or model request was
used in the reproduction.

The panel also retains `pendingDiscard` across repository changes but confirms
against its current `repo` and current environment. A controlled hook test opened
a confirmation for `/repo-a/same.txt`, changed the target to `/repo-b`, and
observed `gitDiscard('/repo-b', ...)`. The UI mounts this panel without a
repository key. Pending AI commit-message work likewise writes its result into
the current draft: both navigation to another repository and editing the draft
in place were overwritten by an older completion. The user has been asked to
choose cancellation of pending confirmations/generation on repository or space
changes, and cancellation of generation on draft edits, versus independent
per-repository pending work. Already-dispatched Git commands should stay bound
to their original environment; this broader ownership change is not implemented
yet. UI test Git mutations and model execution were mocked.

The native reproduction is `/tmp/oarlock-review36-secret-diff-repro.rs` (copy to
`src-tauri/tests/git_privacy_review_repro.rs` to run with the existing common
fixture); its failing log is `/tmp/oarlock-review36-secret-diff-repro.log`.
The four frontend reproductions are `/tmp/oarlock-review36-panel-repro.test.ts`
(copy to `src/modules/source-control/useSourceControlPanel.review-repro.test.ts`),
with failures in `/tmp/oarlock-review36-panel-repro.log`. They remain outside the
passing regression suite while the architecture decisions are pending. This
pass reran 104 readiness, recovery, voice and autocomplete regressions, all
passing. No production source or size budget changed; the preceding full-suite
validation remains the last complete run. These findings prevent release
clearance; live cross-platform clipboard tests and the intermittent macOS
watcher test remain open follow-ups.


The user approved both source-control decisions above; they are now implemented.
AI commit-message generation uses `git_ai_staged_diff` exclusively. Native
`git/ai_diff.rs` captures the index as a tree and pins HEAD's tree (or an empty
tree for an unborn branch). It validates the complete NUL-delimited changed-path
list before reading content from those exact objects. Protected additions,
deletions and either side of a rename refuse the entire request. Both lexical
historical names and canonical worktree aliases must pass the shared secret
policy; malformed, non-UTF-8 and truncated path lists fail closed. Renames/copy
inference, external diffs, text conversion and replacement objects are disabled;
submodules contribute only their short Git diff. Concurrent staging, commits or
replacement refs cannot change the validated snapshot. The normal Git viewer
continues to use its existing API. Both initial and repair model prompts use the
native snapshot's paths, never a stale panel status list, and include the native
truncation flag. An empty snapshot refuses generation.

Source-control pending confirmations and generation belong to their initiating
repository/context, space, environment and open panel lifetime. Navigation,
closing and unmount invalidate them; editing the draft aborts generation while
preserving the edit. Every async continuation checks ownership, including before
model startup, repair and applying results, and both model calls receive an abort
signal. An old completion cannot clear a newer operation's busy/error state.
Already-dispatched Git mutations retain a native client bound to their original
environment. Their notifications and cache invalidations retain that environment
as well, and late commit results preserve a newer draft. No per-repository draft
store or background generation was introduced.

Further review reproduced two diff-cache regressions: invalidation left old
in-flight requests reusable and able to refill the cache, and late commits
invalidated the newly selected environment's cache instead of their own.
Invalidation now detaches in-flight entries; only the matching current promise
may populate or remove an entry. Repository invalidation accepts its owning
environment. Mutations invalidate affected diffs at dispatch and completion
(including failure, since a Git command can partially apply). The six-entry cache
limit is unchanged; no generation tombstones or additional persistent caches are
retained. These are corrections to the already-approved ownership/invalidation
contracts. Their controlled failing log is
`/tmp/oarlock-review37-diff-repro.log`.

Review 37 validation: all 4,816 frontend tests in 518 files pass; all 1,306 native
tests pass, with three existing ignored tests. The final replacement-ref/snapshot
hardening also passes its targeted Rust tests. Type checks, Clippy with warnings
as errors, production build and distribution graph pass. Frontend lint retains
82 existing warnings and adds none. New tests include 15 panel lifecycle cases,
two cache races, six native Git integration cases and two native snapshot/path
validation cases. The initial sandboxed frontend suite could not bind loopback
servers; its authorized unsandboxed rerun passes in full. All Git/privacy
reproductions used temporary repositories and synthetic content; model calls and
panel mutations were mocked.

No dependency was added. The native snapshot/validation work runs only when
commit-message generation is requested; it uses bounded Git capture and leaves
no new frontend cache. Final gzip client JS is 2,816,345 bytes (+563); its measured
allowance increases from 2,815,800 to 2,816,350 bytes (+550). Startup is 248,482
bytes (+12), primary terminal JS 92,546, WebGL 16,465 and WASM 654,361 (all three
unchanged). Logs use `/tmp/oarlock-review37-*`. Live Windows/WSL and Linux desktop
validation remains outstanding; the previously intermittent macOS watcher test
passed this native run. This pass does not constitute cross-platform release
clearance.

Review 38 extends the approved source-control cancellation rule to branch menus
and worktree forms. A controlled removal test reached the force-confirmation
step in Ubuntu, switched the environment to Debian, and observed the old form
invoke `git_worktree_remove(force: true)` in Debian. No real worktree was removed.
`useRepositoryOwner` now captures each mounted menu/form's repository, space and
environment, rejects stale callbacks and ignores obsolete completions. The
branch menu remounts on context/space/environment changes. Worktree IPC requires
an explicit environment; creation/removal and branch checkout retain that owner
once dispatched. Delayed menu-to-dialog transitions, completion callbacks and
worktree notification navigation actions check ownership too. Form submissions
have an immediate in-flight guard, so two clicks before React renders cannot
start duplicate mutations. Eight real form callback regressions cover force
confirmation, navigation, late completion, duplicate creation and unmount.

Diff-cache keys are JSON tuples including the rename source. Controlled tests
previously reproduced identical keys for `/repo` + `a|w|-|b` and
`/repo|w|-|a` + `b`, and a request with rename source `b.txt` receiving cached
content from `a.txt`. Tuple prefixes keep invalidation scoped to exact fields;
working-file invalidation removes all rename-source variants, including their
pending reads. Mounted panes use the same complete cache identity. The six-entry
limit and existing asynchronous invalidation contract are unchanged. Three new
cache regressions cover collisions, rename sources and scoped invalidation.
Failing reproductions are logged in `/tmp/oarlock-review38-worktree-repro.log`
and `/tmp/oarlock-review38-cache-repro.log`.

Two additional findings require the user's architecture decisions and remain
unfixed. First, a mounted working diff does not subscribe to cache invalidation;
with its source unchanged, invalidation and rerender still leave old text visible.
External repository/file changes also do not invalidate its cache. The user has
been asked to choose live updates with superseded-read cancellation and visible
refresh failures (recommended), or explicit snapshots with Refresh. The real
pane reproduction is `/tmp/oarlock-review38-pane-repro.test.tsx`, with log
`/tmp/oarlock-review38-pane-repro.log`; copy it to
`src/modules/editor/GitDiffPane.refresh-review.test.tsx` to run. It is outside
the passing suite while that decision is pending.

Second, autocomplete sends an editor buffer named `/project/.env` to its model.
The provider test captured `SYNTHETIC_REVIEW38_SECRET` in the generated prompt;
the inline driver supplies the real full path but neither layer checks the
secret-path policy. No real credential or model request was used. The user has
been asked to approve native document-path/environment validation (including
canonical symlink targets) before buffer transmission and cancellation when the
document identity changes, or disable autocomplete pending that work. A lexical
filename check alone cannot enforce the policy. This privacy finding blocks
release clearance. The controlled reproduction is
`/tmp/oarlock-review38-autocomplete-privacy-repro.test.ts` (copy over
`src/modules/editor/lib/autocomplete/provider.test.ts` to run the additional
case), logged in `/tmp/oarlock-review38-autocomplete-privacy-repro.log`.
The regular provider regression file was restored after the reproduction.

Review 38 validation: 4,827 frontend tests in 519 files pass; 1,306 Rust tests
pass with three existing ignored tests. Type checks, Clippy with warnings as
errors, production build, distribution graph, and size checks pass. Frontend
lint retains 82 existing warnings. The native Git privacy and snapshot tests
continue passing. Client gzip is 2,815,936 bytes (-409 from Review 37); the
2,816,350-byte allowance is unchanged. Startup is 248,488 bytes (+6), primary
terminal JS 92,546, WebGL 16,465 and WASM 654,361 (unchanged). No dependency,
watcher, polling timer or persistent cache was added. Logs use
`/tmp/oarlock-review38-*`. Live Windows/WSL and Linux desktop validation remains
outstanding. Work remains local and uncommitted.

Review 39 implements the two Review 38 architecture decisions approved by the
user: live working diffs and native autocomplete document validation. Active
working diff panes subscribe to cache invalidations and the existing shared
native Git/file watchers in their owning environment. Hidden/closed panes and
immutable commit views acquire no live watches. Refreshes coalesce for 40 ms,
allow one read in flight per pane, discard superseded responses and expose
failures with Retry. Cancellation suppresses the obsolete result; it does not
kill an already-dispatched read-only Git process. Late watcher acquisitions
are released after disposal. Staged diffs derive rename sources from current
index status, because a tab's original-path hint can become stale after a reset
and a different rename to the same destination.

Editor reads authorize the actual opened file handle before reading bounded
content and carry native AI eligibility into the document session. A protected
buffer stays ineligible through edits, retargets and partial baseline adoption;
a full reload can establish fresh eligibility. Autocomplete requires that
provenance and validates the full current path, owning environment, canonical
target and opened handle through native AI authorization immediately before
sending buffer text. Missing eligibility fails closed. Document/environment
changes cancel requests and clear suggestions. This also prevents an alias
loaded from a secret file from becoming eligible merely by retargeting the
alias to a safe file before completion.

Review 39 validation: all 4,843 frontend tests in 522 files and 1,310 Rust tests
pass; three existing Rust tests remain ignored. One full frontend run failed
the existing GC-sensitive disposed-WASM-memory assertion; its isolated rerun
and the subsequent complete suite passed without changing that test. Type
checks, Clippy with warnings as errors, production build, distribution graph,
size checks and diff whitespace checks pass. Frontend lint has 81 existing
warnings and no errors. Client gzip is 2,817,258 bytes (+1,322); the measured
allowance is 2,817,300 bytes. Startup is 248,440 bytes (-48); primary terminal
JS 92,546, WebGL 16,465 and WASM 654,361 are unchanged. No dependency was added.
Autocomplete adds one native path-validation call per actual request; staged
diff refresh adds one tracked-only status query for current rename identity.
Logs use `/tmp/oarlock-review39-*`. Live Windows/WSL and Linux desktop validation
remains outstanding. Work remains local and uncommitted.

Review 40 fixes two regressions adjacent to the approved live-diff/document
ownership work. Overlapping document reloads could apply an older response
last, including its AI eligibility; a pre-save read could also replace freshly
saved edits with old text and mark the editor clean. Document reads now carry
a generation within their path epoch. A newer load, successful write or
formatter baseline supersedes older snapshots, and ordinary reloads do not
adopt across intervening edits. Forced reloads still preserve edits typed
while their read was pending. Working diff refreshes now retain the mounted
editor with a visible Refreshing indicator, preserving scroll/expanded regions
instead of replacing the editor with a loading screen on every invalidation.
Read/watch failures still show their error and Retry action.

Two confirmed Review 40 issues await architecture decisions; neither is fixed:
- Watch removal recomputes canonical paths. Retargeting a watched repository
  symlink before closing its view leaves the original registration held, and
  removal can address a different registration at the new target. A native
  reproduction registers a repository through an alias, retargets the alias,
  calls the same removal resolver/release path as the command, and observes a
  nonempty WatchSet. Proposed decision: window-owned registration handles that
  release the exact acquired resources, independent of current path resolution.
- Git pathspec resolution dereferences the selected symlink. A native fixture
  changes `link` from `a.txt` to `b.txt`, edits `b.txt`, then calls Discard for
  `link`: `b.txt` loses its edits and the link is not restored. Stage, Unstage
  and diff previews share the resolver. Proposed decision: preserve Git-entry
  identity and show symlink target text without dereferencing, or explicitly
  refuse symlink entries. Do not ship the destructive behavior.
Reproduction test sources and failing logs are saved under
`/tmp/oarlock-review40-{watch,symlink}-repro.{rs,log}`; the temporary failing
tests were removed from the normal suite while those decisions are pending.

Review 40 validation: 4,846 frontend tests in 522 files and 1,310 Rust tests
pass, with three existing Rust tests ignored. The first native run was denied
macOS FSEvents/local socket access by the sandbox; the permitted rerun passes.
Type checks, Clippy with warnings as errors, production build, distribution
graph, size checks and diff whitespace checks pass. Frontend lint retains 81
warnings and no errors. Client gzip is 2,817,418 bytes (+160); the allowance is
2,817,450 bytes. Startup is 248,436 bytes (-4); primary terminal JS 92,546,
WebGL 16,465 and WASM 654,361 are unchanged. No dependency, additional request,
watcher or timer was introduced by these fixes. Logs use
`/tmp/oarlock-review40-*`. Live Windows/WSL and Linux desktop validation remains
outstanding. Work remains local and uncommitted.

Review 41 implements both Review 40 decisions, approved by the user. Native
watch additions return window-owned handles: `fs_watch_add` returns directory
and file registrations with their requested paths and handles, and
`git_watch_add` returns a repository handle. `watch_release` accepts only
handles, checks the calling window, and releases exactly the acquired canonical
resources without resolving any path or environment. Repeated/foreign releases
are no-ops. Window cleanup invalidates its incarnation before releasing its
handles; preparations begun in that incarnation cannot install after reload or
close. Ownership publication, watch mutation and cleanup share a lock order.
Repository registrations retain their acquired Git directory too, including
when another registration of the same root uses a different Git directory.
Explorer, editor file sync, Source Control and live diffs retain handles and
release late responses after disposal. File additions/removals remain batched;
an individual resource can be removed without dropping the rest of its batch.

Git entry identity is now separate from filesystem target validation.
Stage/Discard and working previews retain the requested repository-relative
entry and reject traversal through a symlink ancestor. A leaf symlink is an
entry: previews read its target text with `read_link`, never its target file.
Unstage, staged previews and history address stored Git entries and do not
require their current working-tree paths to resolve. Dangling/external links
therefore work without reading outside the repository. The existing AI staged
snapshot's secret-path/canonical-target policy is unchanged. Regular working
preview reads are bounded and validate the opened handle; their filesystem
spelling can differ from the index on a case-insensitive volume. A regression
test caught and corrected an overly strict spelling comparison in this pass.

Review 41 also reproduced ordinary diff previews executing a repository's
configured text converter despite `--no-ext-diff`. Working and historical
preview commands now pass `--no-textconv` too. Synthetic converter tests prove
that merely viewing those changes does not run that helper. The previously
destructive symlink Discard reproduction and watch-alias cleanup reproduction
are now permanent passing regressions, alongside staging/unstaging, external
and dangling links, historical paths under a current symlink, late registration
responses, cross-window handles and deleted-directory cleanup.

Review 41 validation: 4,849 frontend tests in 523 files and 1,319 Rust tests
pass; three existing Rust tests remain ignored. Type checks, Clippy with
warnings as errors, production build, distribution graph, size checks and diff
whitespace checks pass. Frontend lint retains 81 warnings and no errors.
Client gzip is 2,817,814 bytes (+396); the allowance is 2,817,850 bytes. Startup
is 248,425 bytes (-11); primary terminal JS 92,546, WebGL 16,465 and WASM 654,361
are unchanged. No dependency or polling timer was added. Handle records live
only for pending/active registrations and their window incarnation; file IPC
remains batched. Regular diff reads add opened-handle validation and a bounded
read; symlink previews do not open their targets. Logs use
`/tmp/oarlock-review41-*`. Live Windows/WSL and Linux desktop validation remains
outstanding. Work remains local and uncommitted.

Review 42 extends the approved Git-entry identity invariant to Git pathspec
matching. A native reproduction selecting `file[1].txt` also staged or
discarded edits in `file1.txt`: argument separation with `--` does not disable
Git patterns. Native Git now uses `--literal-pathspecs`; it clears inherited
glob/noglob/icase/literal pathspec settings so they cannot conflict with the
flag or broaden the selection. Host commands clear those variables directly;
WSL invokes `env -u ... git --literal-pathspecs` inside the distribution.
Permanent regressions cover Stage, Unstage, Discard and working/history patch
previews. The literal-entry tests also pass with GIT_GLOB_PATHSPECS inherited
by the test process.

Review 42 also reproduced watch preparation blocking indefinitely when `.git`
was a FIFO. Git-directory metadata now uses the existing nonblocking regular
file reader before the bounded read. A timeout-guarded native regression
ensures malformed metadata cannot occupy a watch preparation worker forever.

Two Review 42 architecture questions remain pending and are not fixed:
- Handles record registration ownership, not OS coverage health. Backend
  startup/registration failures are logged without failing the acquisition;
  macOS shared-stream replacement can also remove coverage from existing
  handles. Consumers have no degraded-state notification. Proposed decision:
  expose active/degraded status and Retry, including existing consumers whose
  shared backend fails. Static evidence is Backend::sync/Running::apply and
  the macOS last_error / portable watch-error handling.
- Inherited repository-selection variables can redirect native Git outside
  the authorized repo. A separate-process native reproduction gives the child
  GIT_DIR/GIT_WORK_TREE for B, authorizes A, and calls Discard(A): B's edits are
  erased and A remains modified. Proposed decision: isolate all native Git
  execution from inherited repository/index/object-store overrides on host
  and WSL. This is separate from the path-pattern variables fixed above.
  Do not ship this destructive behavior. Reproduction source and failure log
  are `/tmp/oarlock-review42-git-env-repro.rs` and `.log`; the temporary failing
  test was removed from the normal suite while the decision is pending.

Review 42 validation: 4,849 frontend tests in 523 files and 1,323 Rust tests
pass; three existing Rust tests remain ignored. Type checks, Clippy with
warnings as errors, frontend lint and diff whitespace checks pass; lint has
81 existing warnings. No client implementation or dependency changed, so the
Review 41 bundle measurements/allowances are unchanged. No IPC round-trip or
watcher timer was added. Logs use `/tmp/oarlock-review42-*`. Live Windows/WSL
and Linux desktop validation remains outstanding. Work remains local and
uncommitted; the two architecture questions above remain open.

Review 43 implements both Review 42 decisions after user approval. Native Git
commands now clear inherited repository, worktree, index, object-store,
namespace, discovery and environment-supplied configuration overrides as well
as pathspec overrides. Host commands remove them directly; WSL removes them
inside the distribution using the existing `env -u` command boundary. Normal
on-disk Git configuration remains available. Separate-process regression cases
set GIT_DIR/GIT_WORK_TREE, another repository's index and object directory, and
GIT_CONFIG_COUNT/core.worktree: Discard(A) must use A's index and preserve B.

The shared filesystem watcher now publishes revisioned health snapshots and
change events. Coverage is conservatively shared: a failed OS registration,
shared-stream rebuild, notify callback, or WSL poller startup degrades live
consumers until recovery. File/editor and Source Control consumers show a
persistent error with Retry; working diff panes show a refresh error and resume
reading after coverage recovers. Native recovery invalidates every retained
file/directory/repository target so edits made during the gap are re-read.
Retry retains existing handles, retries failed acquisitions, and reconnects a
failed frontend health listener. One health listener/snapshot is shared per
window while there are consumers; a diff also reads a snapshot after acquiring
its handles. No retry polling timer or dependency was added. Stale snapshots,
late listeners/acquisitions and superseded diff reads cannot replace newer
state. Portable notify registration never holds its callback-error lock while
calling watch/unwatch; error publication shares that lock to prevent a late
healthy result masking a concurrent callback failure.

Watch preparation now rejects missing/non-directory/unauthorized paths instead
of silently omitting them from a successful response. Deliberately excluded
heavy directories retain their existing behavior pending the explicit-file
coverage decision below. This check completes before any handles are installed,
so failed batches can be retried without duplicating successful registrations.

Review 43 validation: 4,857 frontend tests in 524 files and 1,327 Rust tests
pass; three existing Rust tests remain ignored. The expanded Git environment
regression also passes separately. Type checks, Clippy with warnings as errors,
frontend lint (81 existing warnings), production build, startup dependency graph,
and size checks pass. Tests requiring loopback sockets/native facilities ran
outside the sandbox. Total compressed client JS is 2,819,048 bytes (+1,234);
the allowance is 2,819,100 bytes. Startup remains about 248.43 kB, terminal
92.55 kB, WebGL 16.46 kB, and WASM 654.36 kB. Logs use
`/tmp/oarlock-review43-*`. Live Linux/Windows/WSL watcher validation remains
outstanding; this host exercised macOS. Work remains local and uncommitted.

One new Review 43 architecture decision remains pending: explicit editor/diff
files inside excluded directories (for example `build/output.txt`) receive a
file handle but no parent-directory OS coverage. A native regression constructs
that registration, changes the file and feeds the directory event through the
actual FSEvents reducer; no file update reaches the consumer. Healthy backend
status cannot detect deliberately absent coverage. Proposed decision: explicit
file handles own nonrecursive parent-directory coverage for their lifetime,
including excluded folders, while ordinary explorer exclusions remain. The
alternative is explicit manual-refresh status for these files. This ownership/
exclusion-policy change is held for the user's decision. The failing reproduction
is preserved in `/tmp/oarlock-review43-excluded-watch-repro.rs` and `.log`; it
was removed from the normal suite while the policy decision is pending.

Review 44 implements the explicit-file coverage decision approved after Review
43. Every file registration now retains its canonical parent in the native watch
set, independently of explorer/directory-listing subscriptions. This applies
inside excluded folders such as build, target and node_modules. Files and
folders share one parent registration; releasing either kind keeps coverage
while the other has consumers, and the final release updates the OS backend.
Cleanup still uses the acquired handle identity after deletion or alias changes.
macOS exclusions are lifted only where a live registration requires coverage
and restored when that registration is released. Windows/Linux use the existing
nonrecursive directory backend; WSL file-only coverage activates the existing
poller only while needed.

A file-only parent has no listing subscriber: native event processing and WSL
polling stamp only the registered files instead of enumerating a potentially
large build directory. No new IPC call, frontend subscription, timer, dependency
or client bundle code was added. The previously failing native reproduction is
now a permanent passing regression. Additional tests cover duplicate file
consumers, overlapping files, folder/file release in either order, WSL polling
lifetime, deleted-directory cleanup, and a live macOS event plus exclusion
restoration after the file closes. The Review 43 architecture question is
resolved by this implementation.

Review 44 validation: 4,857 frontend tests in 524 files and 1,332 Rust tests
pass; three existing Rust tests remain ignored. The full Rust rerun used four
workers after the initial run hit two unrelated openpty allocation failures.
Type checks, frontend lint (81 existing warnings), Clippy with warnings as
errors, and diff whitespace checks pass. Frontend implementation and bundle
measurements are unchanged from Review 43. Logs use `/tmp/oarlock-review44-*`.
Live macOS coverage/exclusion recovery is tested; live Linux/Windows/WSL
validation remains outstanding. Work remains local and uncommitted.

Review 45 fixes two regressions in failed-watch recovery. Retrying a batch used
its original path arrays after consumers had been removed: one now-missing
folder could keep the remaining valid files from registering forever. Each
attempt now snapshots only live, unregistered entries, preserving duplicate
consumer counts and binding replies to the exact entries requested. A late
reply for a removed entry still releases its handle. Failed attempts and their
notices are also removed when their last consumer closes, even while other
watches in the same client stay active. Regressions cover surviving paths,
duplicate file consumers, and closing a failed batch with healthy watches left.

One new architecture decision is pending: simultaneous editor saves can lose
changes across windows. DocumentSession performs a separate stat/read conflict
check, then fs_write_file atomically replaces the file unconditionally. A
controlled two-session reproduction lets both check the same baseline before
either write; both report success, with no conflict, while the second replaces
the first. Recommended boundary: native per-file serialized conditional saves
that validate the expected disk version, retain stale buffers, and offer
explicit Overwrite. External writers do not share the native lock, so their
changes also need a final disk recheck without claiming full filesystem CAS.
This architecture change is held for the user's decision. Reproduction source
is `/tmp/oarlock-review45-save-race-repro.ts` (append to documentSession.test.ts);
the captured failure is in `/tmp/oarlock-review45-repro.log`. The temporary failing
test was removed from the normal suite pending the decision. Do not ship the
silent concurrent-save overwrite behavior.

Review 45 validation: 4,860 frontend tests in 524 files and 1,332 Rust tests
pass; three existing Rust tests remain ignored. Rust ran with four test workers.
Type checks, lint (81 existing warnings), Clippy with warnings as errors,
production build, startup graph, size and diff whitespace checks pass. Total
compressed client JS is 2,819,139 bytes (+91); the allowance is 2,819,150 bytes.
No new IPC calls, timers or dependencies were added. Logs use
`/tmp/oarlock-review45-*`. Live Linux/Windows/WSL validation remains outstanding.
Work remains local and uncommitted.

Review 46 implements the native conditional-save decision approved after Review
45. Editor reads opt into a SHA-256 content version; other fs_read_file callers
pay no hashing cost. fs_save_document takes the expected version and commits
under a process-wide canonical-path lock, shared with fs_write_file. Inactive
locks retain no live mutexes or file contents; weak entries are pruned on the
next acquisition. The lock key conservatively folds case on macOS/Windows.
The document writer stages and syncs a private temporary file, revalidates the
requested destination and opened file, hashes current disk bytes in 64 KiB
chunks, compares the version, preserves permissions on the staged file, and
renames it into place. Comparison/writes are bounded by the editor's 50 MiB
limit. Conflicts leave the destination unchanged and remove the staging file;
failed writes/conflicts do not refresh project trust or emit a saved event.

A rejected save keeps the editor buffer dirty and offers Overwrite. Overwrite
uses the version observed by that conflict, so a later disk edit raises a new
conflict rather than being silently replaced. Deletion returns a null version;
recreating the document requires explicit Overwrite and still checks that it
has not meanwhile been recreated. Missing read versions block saves. Content
versions preserve touch-without-content-change behavior while detecting edits
with equal timestamps. Separate JavaScript stat/read checks and the obsolete
saveConflict module are removed. Per-document save queues use the prior save's
returned version, preserve ownership through rename/close, and correctly save
edits that revert to the old baseline while another write is in flight.
Autosave re-arms for those edits. Formatter read-back carries a version too.

The native lock serializes Oarlock's native writes, not arbitrary external
processes. Disk is rechecked after staging, but unrelated programs can still
write between that check and rename: this is not a filesystem compare-and-swap.
Review 46 identified an architecture question for Oarlock's own external formatter
path (subsequently approved and resolved in Review 47 below). EditorPane currently saves, launches an in-place command, then reads the
file back. A real shell-process reproduction captures the saved text, permits a
newer conditional save from another editor, and then writes the old formatted
text over it. Proposed decision: format candidate content and commit through
the same conditional transaction (with an explicit policy for in-place-only
custom commands), versus keeping in-place formatting while serializing native
saves for its lifetime. The change is held for the user's choice. Reproduction
source/log: `/tmp/oarlock-review46-formatter-repro.rs` and `.log`; the temporary
failing test is removed from the normal suite. Do not claim formatter writes
are protected by the new native save transaction.

Review 46 validation: 4,862 frontend tests in 523 files and 1,337 Rust tests
pass; three existing Rust tests remain ignored. Removed obsolete frontend
conflict tests are replaced by native content/version tests and editor lifecycle
regressions. Native tests cover simultaneous saves, timestamp collisions,
conditional Overwrite, deletion/recreation, external edits during staging,
failed-save cleanup, symlinks and permissions. Types, lint (81 existing warnings),
Clippy with warnings as errors, build, startup graph, size and diff whitespace
checks pass. Compressed client JS is 2,819,141 bytes (+2), within the unchanged
2,819,150-byte allowance. Startup is 248,423 bytes; terminal/WebGL/WASM sizes
are unchanged. SHA-256 was already a dependency. Saves use one IPC request
instead of a stat plus possible read plus write. Logs use
`/tmp/oarlock-review46-*`. Live Windows/WSL/Linux validation remains outstanding;
work remains local and uncommitted.


Review 47 implements the approved formatter-candidate decision. External
formatting no longer saves first, executes an in-place shell command, or reads
back a file that another window may have edited. `fs_format_document` validates
the owning environment, destination and working directory, passes the buffer
through a private temporary stdin file, and returns bounded UTF-8 stdout. The
editor owns its captured epoch, edit revision and read generation: typing,
retargeting, closing, reloading or a completed save supersedes the result. A
current candidate is adopted and committed through `fs_save_document`; a disk
conflict preserves the formatted buffer and offers conditional Overwrite.
Formatter-only changes to line endings also count as edits and are saved.

Built-in formatters use their stdin/stdout flags. Custom formatters now require
an explicit JSON argument list such as `["mytool", "--stdin"]`; legacy shell
strings, `{file}` placeholders and common in-place flags fail clearly without
saving. Custom executables are still user-configured programs, not sandboxed
code: this contract is not a guarantee against a program deliberately editing
other files. Local execution uses direct argv and the owning working directory,
with effective child PATH/environment lookup. WSL keeps its managed supervisor
control channel separate from candidate input, maps the private host input path
with wslpath and uses a nonlogin shell so login output cannot pollute the result.
Existing shell commands retain their login-shell behavior. All candidate work
has a 20-second timeout, 50 MiB input/output caps and a 64 KiB diagnostic cap;
foreground descendants use the existing managed cleanup.

The shared process capture result now distinguishes EOF from read errors and
unfinished drains. Formatting refuses incomplete or truncated stdout, failed
exit status, timeout, binary/invalid UTF-8 output, and empty output for nonblank
input. A failed formatter keeps the unsaved draft. Native regression tests use
a real delayed formatter and a competing conditional save, proving the older
candidate cannot overwrite the newer file. Editor tests cover superseded
results, failure retention and EOL-only edits. WSL supervisor tests cover both
its default cancellation behavior and the clean-shell candidate mode. Local
Biome, gofmt and rustfmt stdin smoke tests returned formatted candidates without
changing disk files; rustfmt also left child module files untouched.

Review 47 validation: 4,862 frontend tests in 523 files pass. The full native
suite passed 1,342 tests with three existing ignores, followed by the added
supervisor regression and its existing cancellation test passing. Type checks,
lint (81 existing warnings), Clippy with warnings as errors, production build,
startup graph and size checks pass. Compressed client JS is 2,818,879 bytes
(-262), within the unchanged 2,819,150-byte allowance; startup is 248,560 bytes
(+137). Terminal/WebGL/WASM sizes are unchanged. No dependencies were added;
formatting replaces command execution plus readback IPC with one candidate IPC.
Logs use `/tmp/oarlock-review47-*`. Live Windows/WSL/Linux execution remains
outstanding; work remains local and uncommitted.

Review 48 fixes two reproduced regressions using existing mechanisms. Vim
`:wq` and `:x` previously called Save and Close synchronously, so a clean tab
could close while format-on-save was still pending; dirty tabs also reached the
close guard before knowing whether the write succeeded. Save now returns its
existing success result through EditorPane. Vim waits for it, verifies the view
registration and document lifetime still match, and reads the document's live
clean/loaded state before closing. A failed/conflicting save, newer typing,
retarget or destroyed view leaves the tab open. View updates during formatting
do not invalidate the registration. Plain `:q` still uses the ordinary close
guard. Tests cover delayed success, failure, rejection, edits, retargeting,
destruction and the case where an earlier snapshot saved but newer edits remain.

Explorer Rename previously used `Path::exists()` followed by an unconditional
rename. A dangling destination symlink therefore looked absent and was replaced;
a dangling source could not be renamed at all. Two simultaneous renames also
had a check/write race. It now inspects entry metadata and uses the existing
platform-native `rename_no_replace` helper. Tests preserve a dangling destination,
move a dangling source, and race four sources for one destination with exactly
one winner and every losing source intact. Reproduction failures are saved as
`/tmp/oarlock-review48-vim-repro.log` and `-rename-repro.log`.

Review 48 left an architecture decision pending (approved and implemented in
Review 49 below). Explorer mutation callbacks carry
paths but no owning environment. A controlled reproduction executed the actual
App rename callback extracted from source against Ubuntu and Debian editor tabs
with the same path: both tabs were retargeted. The actual `deletedPathTabs`
function similarly selected both clean tabs for closure. Other windows receive
no corresponding rename/delete notification. The proposed shared contract is
native environment-scoped successful mutation events consumed by every window,
so only matching documents update; the alternative is environment-scoped
callbacks limited to the initiating window. Do not implement that broader
lifecycle change until the user answers. Reproduction source and output are
`/tmp/oarlock-review48-environment-repro.ts` and `.log`. This is controlled
frontend evidence, not a live two-distribution Windows test.

Review 48 validation: 4,871 frontend tests in 524 files and 1,345 Rust tests
pass; three existing Rust tests remain ignored. Type checks, lint (81 existing
warnings), Clippy with warnings as errors, production build, startup graph,
size and whitespace checks pass. Total compressed client JS is 2,819,017 bytes
(+138), within the unchanged 2,819,150-byte allowance. Startup is 248,558 bytes;
terminal/WebGL/WASM sizes are unchanged. No dependencies, timers or IPC calls
were added. Logs use `/tmp/oarlock-review48-*`. Live Windows/WSL/Linux testing
remains outstanding; all changes remain local and uncommitted. PR #1 is not
release-cleared while the environment-scoping defect remains unresolved.


Review 49 implements the approved cross-window document mutation contract.
Successful native fs_rename, fs_move, fs_delete and fs_delete_batch operations
publish `fs:mutation` to all app windows, carrying the originating WorkspaceEnv,
a monotonically increasing sequence and renamed/deleted paths. Conflicts,
failed operations and no-op moves emit nothing; partial batch deletion publishes
only successful paths. A small native mutex orders entry mutation plus broadcast,
so concurrent commands cannot publish B->C ahead of A->B. Document saves retain
their separate per-file transaction locks. There is no event history or polling.
An emission error is logged as a notification failure after the disk commit,
not misreported as a failed mutation that could invite a destructive retry.

Every app window plans changes against each tab's owning space and effective
path environment, never the currently selected environment. Unknown space
ownership cannot fall back to host. Host paths open in WSL spaces still match
host events. Renames preserve mounted editor buffers, dirty state and baselines;
cold editors and Markdown tabs update their paths. Destination editors affected
by replacement moves reload only while clean; dirty drafts stay for conditional
save conflict handling. Markdown destinations also refresh. Deletion retains
existing dirty-buffer confirmation and consults synchronous buffer state so a
not-yet-rendered dirty badge cannot cause data loss. Path comparisons normalize
Windows separators/drive letters and trailing separators while preserving case
inside WSL paths. Directory events affect descendants, not sibling prefixes.

Each native mutation is applied in one synchronous React commit; document
retarget/close effects run at layout time before the next event uses the tab
identities. This preserves chained renames without waiting for unrelated UI
renders. Listener setup reports failures with Retry, cleans up late successful
registrations after disposal, and ignores duplicate/obsolete sequence values.
The old initiating-window Explorer callbacks are removed, preventing duplicate
application. Replacement guards now receive the captured operation environment;
New File/New Folder also use the captured environment rather than looking up
the active window environment at dispatch. These events represent Oarlock's
native entry operations; external tools still use filesystem watchers, whose
path notifications do not infer rename identities. Listener Retry restores
future delivery; it does not replay events missed while disconnected.

Tests exercise two simulated window subscribers, chained renames with different
dirty buffers, same-path Ubuntu/Debian/host isolation, cold/Markdown tabs,
unknown ownership, host files in WSL spaces, replacement refresh, duplicate and
disposed listeners, registration failure and live dirty-state deletion guards.
Native tests verify success-only publication, originating environment and ordered
concurrent commits. An initial sandboxed filesystem run could not access FSEvents
and FIFO services; the complete native suite passed outside the sandbox.

Review 49 validation: 4,879 frontend tests in 525 files and 1,347 Rust tests
pass; three existing Rust tests remain ignored. Types, lint (81 existing
warnings), Clippy with warnings as errors, production build, startup graph,
size and whitespace checks pass. Compressed client JS is 2,819,734 bytes (+717);
the total allowance is updated from 2,819,150 to 2,819,740 bytes to cover the
measured change. Startup is 249,192 bytes (+634); terminal/WebGL/WASM sizes are
unchanged. No dependencies were added. One shared document mutation listener
runs per app window, with no timers, and Markdown subscribes while mounted.
Logs use `/tmp/oarlock-review49-*`. Live multiwindow desktop, Windows/WSL and
Linux verification remains outstanding; work is local and uncommitted.

Review 50 audits the new mutation-event consumer and finds two confirmed
ownership defects. No implementation changes are made pending user decisions.
The controlled reproduction uses the actual planDocumentMutation,
DocumentSession and createDocumentIo functions; it is saved at
`/tmp/oarlock-review50-ownership-repro.test.ts` with output in
`/tmp/oarlock-review50-ownership-repro.log`. Both assertions reproduce existing
unsafe behavior, so the temporary reproduction is removed from the normal suite
rather than locking that behavior in as a regression expectation.

1. A dirty document retained after native deletion remains bound to its old
path. If another file is created/restored at that path and renamed, the retained
draft follows that distinct file. When the recreated bytes match the original
baseline, the conditional save succeeds at the new path without a recreation
confirmation. Reproduction: load /work/a with `base`, type a draft, delete /work/a,
retain the buffer, recreate /work/a with `base`, rename it to /work/b, then save.
The draft overwrites /work/b. The native content version correctly detects equal
bytes but cannot establish continuity of document identity. Decision requested:
detach deleted drafts until explicit restore/Save As (recommended), versus
retaining a path binding that requires explicit reattachment. Hold the document
identity/recovery change until the user answers.

2. Cross-environment tab movement changes tab.spaceId without remounting its
resource. DocumentSession retains createDocumentIo's original environment, while
WorkspaceOwner, EditorPane formatting/completion and the new mutation planner
use the destination space. Reproduction: create the editor IO for Ubuntu, move
the tab into a Debian space, apply Debian's /work/a -> /work/b rename, and save:
the native save invocation targets Ubuntu /work/b. Both moveTabToSpace and
cross-space reorderTab permit this. Terminal tabs also obtain their rendered
owner from the containing space while live PTYs keep their original environment,
so the decision must cover all environment-bound tabs. Decision requested:
block cross-environment moves for this release (recommended), versus immutable
tab execution environments independent of the containing space. Do not silently
rebind or remount dirty/live resources. Hold this architecture change for the
user's answer.

Review 50 ran two focused reproduction tests successfully. The full suites were
not repeated because this pass changes only review notes, not product code.
The previous Review 49 validation remains the implementation baseline. No
release clearance is given; both findings are release blockers. Live desktop
Windows/WSL testing remains outstanding, and all work remains local/uncommitted.


Review 51 implements the two approved ownership decisions. Native deletion of
an open dirty editor detaches its DocumentSession before presenting the existing
close confirmation. The draft stays visible and dirty, including when edits
return to the old saved text. Detachment invalidates the client epoch and read
generation, cancels autosave, disables reload/format/autocomplete/LSP binding,
and invalidates old Overwrite callbacks. Detached tabs do not follow later
rename/delete/replacement events for their old path. Future/queued client saves
are refused with recovery guidance. The editor offers Restore file and Save As
in a persistent banner. Save As accepts an absolute path in the document's
existing environment. Both use conditional creation with no overwrite; an
occupied destination retains the detached draft and reports the conflict.
Recovery rebinds the session and tab only after success, preserves newer typing
as dirty, and revalidates the created native file identity and readable context
before binding (Review 59). It never reloads a replacement over the draft.
Detached buffers are not newly persisted; app close retains its existing
unsaved-work confirmation.

Native conditional creation now uses tempfile persist_noclobber. A file appearing
between the final comparison and commit is preserved and produces a conflict.
This is used for both recovery and explicit recreation after a missing-file
conflict. A native regression creates a competing file during validation and
checks its contents and staging-file cleanup.

Tab movement now rejects different or unknown environment ownership at the
useTabs action boundary, with a clear toast. This covers moveTabToSpace,
cross-space reorderTab and terminal moveTabIntoSplit. Moves within the same
local environment or same WSL distribution remain allowed; extracting a pane
keeps its source space. No live resource is silently rebound/remounted. The
pure environment predicate covers legacy local spaces and missing owners.
The review also corrected the actual App wiring for plain Vim :q: it had passed
disposeTab directly to the editor despite the Review 48 intent. It now uses the
close guard, which consults synchronous buffer state before tab decorations
catch up; successful save-and-quit does not show a stale dirty-tab confirmation.

One further native architecture decision is pending. An already-dispatched
save cannot be cancelled by the client epoch. Native save versions currently
hash bytes only, so deletion followed by recreation of identical baseline bytes
can let that old save overwrite the replacement. Both a DocumentSession test
with a held native write and a real document_save::write_checked test confirm
this. The latter removes/recreates the file during validation, after staging,
then observes a successful old-draft overwrite. Sources/output are
`/tmp/oarlock-review51-dispatched-repro.test.ts`,
`/tmp/oarlock-review51-dispatched-repro.log`,
`/tmp/oarlock-review51-native-dispatched-repro.rs` and `.log`. These assertions
reproduce unsafe behavior and are removed from the normal suite. The requested
decision is native file identity plus content versions (recommended), versus
keeping content-only versions. Identity changes compatibility: atomic external
replacement would conflict even with identical bytes. Hold that change until
the user answers. Do not claim detachment cancels writes already executing in
native code, or give PR #1 release clearance while this race remains.

Review 51 validation: 4,890 frontend tests in 526 files and 1,348 Rust tests
pass; three existing Rust tests remain ignored. Types, lint (81 existing
warnings), Clippy with warnings as errors, build, startup graph, size and
whitespace checks pass. Compressed client JS is 2,820,581 bytes (+847); the total
allowance moves from 2,819,740 to 2,820,590 bytes for the measured recovery UI
and movement guards. Startup is 249,572 bytes (+380); terminal/WebGL/WASM sizes
are unchanged. No dependencies were added. Logs use `/tmp/oarlock-review51-*`.
Live desktop/multiwindow Windows/WSL/Linux verification remains outstanding;
changes are local and uncommitted.

Review 52 implements the approved file-identity save versions. Editor reads
hash the bytes and obtain native identity from the same open handle; ordinary
nonversioned reads still pay neither cost. Opaque v2 versions combine the
content hash with Unix device/inode and birth time (conservatively change time
when the filesystem supplies no birth time), or Windows volume plus full
128-bit file ID and creation time. Windows identity lookup failure refuses the
versioned operation with an error rather than reverting to content-only checks.
The 128-bit Windows identity matters on ReFS, where the older 64-bit identifier
is not guaranteed unique (Microsoft FILE_ID_INFO documentation:
https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info).

Save comparisons now reject deletion/recreation and atomic replacement even
when the replacement has identical bytes. After authorization and permission
preservation, the native writer reopens the destination for a final identity
check, without hashing its contents twice on the successful path. A mismatch
returns the replacement's version for explicit Overwrite; Overwrite itself
remains conditional. The returned successful version uses the persisted file's
handle, not the old destination or a reopened path, so subsequent saves follow
the new file identity. Recovery remains create-only. Tests replace a file at
each of the three validation phases, exercise identical-content atomic
replacement, conflict/Overwrite/next-save chaining, same-file timestamp changes,
and replacement during a versioned read. Formatter regression tests now use
native identity versions too. No permanent handles, caches or dependencies were
added. Unix filesystems without birth time may also conflict on metadata-only
changes; macOS can change birth time when modification time is backdated past
creation, which conservatively conflicts too. The external check-to-rename
window still exists: this is not an OS filesystem compare-and-swap and does not
claim to prevent arbitrary external writes racing after the final check.

The user also reported terminal Vim/Neovim interpreting colon as semicolon.
This is separate from editor saves. The branch already contains 3d5064e, which
passes Shift as consumed when it selected the typed character. The shipped
SIMD and scalar cores both emit literal colon in Neovim's Kitty mode. Expanded
existing keyboard tests cover modes 0, 1, 3, 5 and 7 on macOS and other platforms,
with shifted punctuation and letters, while preserving modifier-only and
report-all behavior. No new keyboard production change was necessary. The
user's currently running installed build has not been identified or tested.

Review 52 validation: 4,902 frontend tests in 526 files pass. The full Rust
fallback suite passes serially (1,352 passed, three existing ignored); nextest
is not installed on this host. The parallel run had one openpty allocation
failure (Device not configured); serial execution passed that test and the
remaining suite. Sandbox-only watcher/FIFO and loopback-server failures were
rerun outside the sandbox. Types, lint (81 existing warnings), Clippy with
warnings as errors and whitespace checks pass. Final targeted save checks and
Clippy cover the ordering adjustment that captures identity before validation
callbacks. Logs use /tmp/oarlock-review52-*. No frontend production behavior or
dependencies changed, so no bundle allowance was changed. Windows/Linux/WSL
execution and live installed-app keyboard verification remain outstanding.
Changes are local and uncommitted; this pass is not overall PR release clearance.

Review 53 fixes three reproduced issues within the existing approved save and
resource-ownership rules. New File used exists() followed by an unconditional
write: a dangling symlink under an authorized workspace created a file outside
that workspace, and 16 simultaneous creates all reported success for one path.
The native helper now uses create_new; New Folder builds parents then uses
exclusive create_dir for the leaf. Occupied leaf errors retain the existing
message. Regression tests cover the authorized dangling link, concurrent file
and folder creation, and existing content preservation. Initial reproductions
are in /tmp/oarlock-review53-create-repro.log and -create-race-repro.log.

The final document-save check previously compared identity alone after the
content hash. An in-place edit during final authorization preserved identity
and was overwritten. The reader now captures length, modification time and
native change time before comparing bytes, then checks that stamp along with
identity just before persistence. Unix uses ctime with nanoseconds; Windows
uses FILE_BASIC_INFO.ChangeTime. No second content hash is needed on the
successful path. Tests cover changed length and an equal-length in-place write
with its old modification time restored. The failing reproduction is in
/tmp/oarlock-review53-save-repro.log. This narrows the existing external-write
race, not an OS compare-and-swap: unrelated writers can still race after the
last observation, and coarse filesystem timestamps cannot prove no write took
place between observations. Oarlock's writes still share the native path gate.

Detached drafts were still selected by opening a replacement file at their old
path. File-tab planning now excludes detached drafts from matching and from
preview recycling, retains them beside the newly opened file and reuses that
new file on later opens. A dirty preview is never recycled. Detached drafts no
longer block Explorer replacement or retain file-watch coverage; a separate
live editor at the same path still does both. Existing conditional recovery
continues refusing an occupied target. Tests cover pinned and preview opens,
repeat opens, preview retention, replacement guards and watcher ownership.
Initial tab failures are in /tmp/oarlock-review53-tabs-repro.log. No new
architecture decisions were required for these corrections.

One additional candidate was disproved: Python realpath preserves alternate
Unicode spellings on macOS, but Rust canonicalize resolves them to the same
on-disk spelling. A native reproduction confirmed equal transaction keys;
no Unicode normalization or new dependency was added. Its temporary assertion
is removed from the suite; evidence is /tmp/oarlock-review53-unicode-repro.rs
and .log. Do not infer a native alias-lock bug from Python realpath alone.

Review 53 validation: 4,907 frontend tests in 526 files and 1,355 Rust tests
pass; three existing Rust tests remain ignored. Rust used cargo test --locked
with one test thread because nextest is unavailable and parallel PTY tests
previously exhausted allocation. Types, lint (81 existing warnings), Clippy
with warnings as errors, build, startup graph, size and whitespace checks pass.
Compressed total client JS is 2,820,597 bytes (+16), startup 249,588 bytes (+16);
terminal/WebGL/WASM sizes are unchanged. The total allowance moves by 10 bytes
to 2,820,600 to cover the measured result. No dependencies were added. Logs use
/tmp/oarlock-review53-*. Native tests ran on macOS; Windows/Linux/WSL runtime
validation remains outstanding. Changes remain local and uncommitted; PR #1
has not received overall release clearance.

Review 54 reproduced and corrected delayed dirty-state checks outside single-tab
closing. Close Other Tabs, Close Tabs to the Right and the initial window/quit
check used tab dirty badges, which update after the live editor buffer. They
could close a newly edited document without confirmation. They now consult the
same synchronous editorIsDirty callback already used by single-tab close,
falling back to the stored dirty flag when the editor is not mounted. A completed
save also supersedes a stale dirty badge. The App passes its existing live
editor callback into useAppCloseGuard. Six regression tests exercise both batch
actions, initial window close, successful-save transitions and missing handles;
initial failures are in /tmp/oarlock-review54-close-repro.log.

Two further architecture decisions are pending; neither fix is implemented.
First, initial close checks can pass, chat/space persistence can wait, then a
new edit can arrive and the window still closes silently. The hook reproduction
holds flushSessionWrites, changes a previously clean tab to dirty, releases the
flush and observes window.close. It is retained in
/tmp/oarlock-review54-close-repro.test.ts (the review54_repro test) and the log
above, removed from the normal suite until the lifecycle choice is answered.
Asked whether to recheck buffer revisions after persistence and reconfirm new
edits (recommended), or freeze editing once close starts. The initial live-state
fix does not resolve edits made during the later persistence wait.

Second, an atomic leaf create does not pin its parent directory. The native
reproduction authorizes workspace/folder/new.txt, renames folder aside, replaces
it with a symlink to an outside directory, calls the real create_file helper,
and observes outside/new.txt created. Source/output are
/tmp/oarlock-review54-parent-repro.rs and .log. The temporary reproduction asserts
the unsafe current behavior and is removed from the normal suite. Asked whether
creation and save destinations should use pinned native parent-directory handles
and relative operations, failing safely where unsupported (recommended). Another
path-string authorization check cannot eliminate the authorization-to-open race.
Hold this architecture change for the user's answer; the prior exclusive-create
fix only protects the final entry against collision and symlink following.

The destination-parent issue also affects save staging: write_checked creates
and writes its temporary file before its first authorization callback. A second
native reproduction authorizes a missing destination, swaps its parent for an
outside symlink, then observes SYNTHETIC_DRAFT in the outside directory during
that callback. The check refuses the final save and cleanup removes the file,
but the contents were already written outside the authorized workspace.
Evidence: /tmp/oarlock-review54-save-parent-repro.rs and .log. The temporary
unsafe-behavior test is removed from the suite. No sensitive real data was used.
This remains part of the pending pinned-directory architecture decision.

Review 54 validation: 4,913 frontend tests in 527 files and 1,355 Rust tests
pass; three existing Rust tests remain ignored. Types, lint (81 existing
warnings), Clippy with warnings as errors, build, startup graph, size and
whitespace checks pass. Native tests used the serial cargo test --locked
fallback on macOS. Compressed total client JS is 2,820,633 bytes (+36), startup
249,624 bytes (+36); terminal/WebGL/WASM sizes are unchanged. The total allowance
moves to 2,820,640 bytes for the measured live-buffer checks. No dependencies or
IPC calls were added. Logs use /tmp/oarlock-review54-*. Windows/Linux/WSL runtime
validation remains outstanding. Changes are local and uncommitted. Do not give
PR #1 release clearance with the close-wait data-loss and parent-directory
redirection issues still pending.

Review 55 implements both approved Review 54 decisions. Window close and quit
confirmation now acknowledge the live revision of each dirty document, including
its session identity and binding epoch. After chat/space persistence, any newly
dirty or subsequently edited document opens another confirmation. A successful
save removes that blocker. Missing editor handles fall back to stored dirty
state. The chat-save failure toast re-enters this guard instead of closing
directly; stale toast actions and unmounted continuations cannot close a window.
Confirmation is tied to its prompt identity, so a delayed preference save cannot
confirm a replacement prompt. The dialog prevents automatic action dismissal;
a trailing dismissal callback cannot cancel an already accepted close. Ten new
frontend regressions cover these transitions, including session remounts and
both native close and quit requests. Revision checks add no IPC. A previously
clean close now also reads the window count once to label a later confirmation
as Close Window or Quit Oarlock correctly.

Creation and saves now acquire operation-scoped directory capabilities in
fs/destination.rs. cap-std 4.0.3, with default features disabled, supplies the
cross-platform directory operations; ten packages are added to Cargo.lock and
no frontend dependency changes. The actual acquired handle path passes the
existing origin/secret gates before any bytes or missing parents are written.
New File, New Folder (including nested parents), fs_save_document and
fs_write_file use relative operations for creation, staging and publication.
Stage files use OS entropy, exclusive creation and mode 0600 on Unix. Permissions
are applied to the staged handle before publication. Replacement uses relative
atomic rename; missing-file publication uses an atomic no-clobber hard link,
failing safely on unsupported filesystems. Cleanup uses the acquired directory
even if its path moved, and successful rename disables cleanup of its old name.
Handles are released after each operation, with no persistent resource cost.

Six native regressions cover pre-acquisition parent symlink swaps, transient
staging disclosure, moved-directory publication and cleanup, and file comparison
through links/FIFOs. Testing found cap-std can follow a symlink inside the pinned
directory despite a custom O_NOFOLLOW flag; comparison now rejects a mismatched
opened handle path before reading any contents. The existing file identity,
content, final change-stamp, concurrency, exclusive creation and mode-preservation
tests continue passing. A pinned handle identifies a directory object, not a
permanent pathname reservation: detected moves fail and operations racing a move
remain bound to that acquired object. The final external-writer recheck remains
best-effort rather than an OS compare-and-swap. Windows/Linux/WSL runtime testing
of these paths is still outstanding; native validation here ran on macOS.

A further multiwindow quit issue is held for the user's architecture decision.
windows.rs::advance_quit asks windows sequentially and removes each approved
window from its queue. After A answers app_quit_ready(true), A stays editable
while B is confirming; A has no way to withdraw its prior answer on later edits.
This is established by the native queue/answer flow and the absence of a
post-answer editor subscription, not by a live multiwindow UI reproduction.
Asked whether approved windows should remain editable and invalidate/revalidate
their approval before final quit (recommended), or become read-only until quit
completes/cancels. The implemented per-window persistence recheck does not claim
to close this later native-protocol gap. Do not change that protocol without the
user's decision or give overall PR #1 release clearance.

Review 55 validation: 4,923 frontend tests in 527 files and 1,361 Rust tests
pass; three existing Rust tests remain ignored. Rust used the serial cargo test
--locked fallback because nextest is unavailable. Types, lint (81 existing
warnings), Clippy --all-targets --locked with warnings as errors, production
build, startup graph, size and whitespace checks pass. Compressed client JS is
2,820,945 bytes (+312), startup 249,882 bytes (+258); terminal/WebGL/WASM sizes
are unchanged. The measured total allowance moves to 2,820,950 bytes. Native
watcher/FIFO tests and frontend loopback-server tests ran outside the sandbox;
the initial sandboxed watcher run failed because FSEvents was unavailable.
Logs use /tmp/oarlock-review55-*. All review changes remain local/uncommitted.

Review 56 implements the approved multiwindow quit decision. Windows stay
editable while other windows confirm. A native pure state machine
(windows/quit.rs) assigns round/request tickets, retains approvals and requeues
an edited window without disturbing the current prompt. Each approved window
subscribes to live DocumentSession revisions until its first new edit or the
round ends; it sends one invalidation, including when that invalidation overtakes
its original approval IPC. Delayed, duplicate and foreign-window votes cannot
approve a later ticket. New windows, page reloads, guard replacement and window
destruction cancel the round. A window still loading or being constructed
prevents a new round and produces a visible retry message. Native focus changes
run outside the windows-state lock to avoid reentering it from focus events.

After all confirmations, native broadcasts a final verification ticket. Each
window synchronously checks its approved revisions and then briefly seals input
while flushing chat/space persistence again. This final commit phase is needed
to close the edit-to-exit IPC race; it does not freeze windows during the earlier
confirmation waits. The app shows Finishing quit, makes its root inert, blocks
CodeMirror document changes and refuses DocumentSession text changes. Lifecycle
changes (load/adopt, deletion and binding/disposal) are deferred with bounded
entries per document and restored if the final phase is abandoned. A bypassed
programmatic view change cannot alter the owned buffer and is restored on
cancellation. Async formatting refuses adoption while sealed. Ordinary window
close uses the same short final barrier and restores input if native close fails.

Native exits only after every participant answers the same verification ticket.
A stale check releases all affected seals and reconfirms the changed window;
release events carry their verification ticket so an old release cannot unseal
a newer check. The latest native request also releases an abandoned old seal if
its event was missed. Native cancels an unanswered final check after five seconds.
A six-second frontend watchdog covers lost release events and restores input
only after native confirms that exit has not committed; failed cancellation IPC
keeps the seal and retries. Timeout/loading failures are visible. Cancelled
rounds reject delayed requests. Quit-anyway after a failed flush starts a new
native round rather than reusing an aborted ticket. A new round arriving while
an old flush finishes waits for it and then proceeds only if still current.
No new dependencies, idle polling or per-keystroke IPC were added. Revision
subscriptions exist only after approval; timers exist only for final checks.

Review 56 validation: 4,940 frontend tests in 529 files and 1,367 Rust tests
pass, with three existing Rust tests ignored. Seventeen new frontend tests and
six native state-machine tests cover edits after approval, overtaken replies,
stale and duplicate tickets, cancellation, final persistence, watchdog ownership,
late failures, deferred lifecycle work and native close failure. The complete
suites passed; targeted tests were rerun after the final disposal/lock cleanups.
Types, lint (81 existing warnings), Clippy --all-targets --locked with warnings
as errors, production build, startup graph, size and whitespace checks pass.
Compressed client JS is 2,822,754 bytes (+1,809), startup 251,058 bytes (+1,176).
Terminal/WebGL/WASM bundles are unchanged; the total allowance moves to
2,822,760 bytes for this measured protocol/UI cost. Logs use
/tmp/oarlock-review56-*. Native validation ran on macOS using the serial cargo
test --locked fallback. A live two-window UI smoke test and Windows/Linux/WSL
runtime validation remain outstanding. Changes remain local and uncommitted;
this resolves the recorded quit architecture decision, not overall PR #1 release
clearance.

Review 57 reproduced and corrected two quit-barrier ownership regressions.
A normal window close could start its flush before final quit verification,
then finish late and replace that verification's global input seal. If native
close failed, it released the replacement seal while verification still believed
editing was blocked. The reverse overlap also allowed verification to replace
a normal close's seal. sealEditors now grants exclusive ownership: a competing
local close does not dispatch, and a competing verification cancels its round
without touching the existing seal. A disposed onCloseRequested callback now
returns before preventDefault, so a listener still completing asynchronous
cleanup cannot veto a later native close. Three tests first failed with the
prior behavior (/tmp/oarlock-review57-repro.log) and now pass.

The review also reproduced loss of an unsaved draft after two renames during
the final barrier. DocumentSession deferred open calls under one binding key;
A-to-B followed by B-to-C kept only open(C), lost the retarget chain and reloaded
C's disk content over the draft when quitting was cancelled. The isolated
failure is retained in /tmp/oarlock-review57-renames-repro.test.ts,
-renames-repro-snippet.ts and -renames-repro.log (full prefix oarlock-review57).
The unsafe direct-call reproduction is outside the normal suite; the permanent
regression exercises the real native mutation subscription and document session.

The user approved cancelling verification before applying filesystem events in
order. subscribeDocumentMutations now reserves a batch before requesting the
active quit seal's native cancellation. It waits until that seal is released,
then applies every rename/delete in sequence; the caller's existing flushSync
commits each identity before the next event computes its plan. The reservation
prevents a new final barrier during that batch, and queued mutations also prevent
a positive verification vote while cancellation is pending. The cancel request
is coalesced once per seal, not once per event. An acknowledged cancellation
shows a short explanation that files changed and the user can quit again.
A normal close already dispatched cannot be recalled: waiting mutations replay
if it fails, or disappear with the closed page if it succeeds. Disposing the
subscription drops its queued events, releases its reservation and settles its
waiter; nothing replays into a replacement listener. Unsealed events still apply
synchronously. These operations add no idle work, new timers or dependencies.
All native document rename/delete handling must continue through this boundary;
directly coalescing DocumentSession bindings does not preserve rename chains.

Three further tests cover A-to-B-to-C followed by deletion with an unsaved
buffer, cancellation acknowledgment and attempted resealing between events,
subscription disposal while waiting, and replay after a failed local close.
The integrated regression retains the original draft at C and detaches it on
deletion. No architecture decision from this pass remains pending.

Review 57 validation: 4,946 frontend tests in 529 files and 1,367 Rust tests
pass; three existing native tests remain ignored. Targeted tests were rerun
after the cancellation explanation was added. Types, lint (81 existing
warnings), Clippy --all-targets --locked with warnings as errors, production
build, startup graph, size and whitespace checks pass. Native checks used serial
cargo test --locked on macOS; native watcher/PTY and frontend loopback-server
tests ran outside the sandbox. Compressed client JS is 2,823,158 bytes (+404),
startup 251,314 bytes (+256); terminal/WebGL/WASM sizes are unchanged. The total
allowance moves to 2,823,160 bytes for the measured fixes. Logs use
/tmp/oarlock-review57-*. Live multiwindow UI and Windows/Linux/WSL testing remain
outstanding. Changes remain local and uncommitted. This pass does not establish
overall release clearance for PR #1.

Review 58 reproduced and corrected two more quit ownership gaps. A cancellation
IPC from an abandoned verification could fail after a replacement ticket in the
same round acquired its seal, then install a retry that cancelled that newer
verification. Failed cancellations and watchdog retries now retain their exact
request owner. Successful native cancellation still ends the whole round even
when a newer ticket arrived meanwhile. Ended rounds ignore late replies; parallel
failures replace the existing timer rather than leaving orphan retries. Disposal
still retries until native cancellation permits its seal to be released.

Local close preflight checks also lacked attempt ownership across process/window
inspection. An earlier check could reopen a prompt after Cancel, or overwrite a
newer native Quit prompt with a local Close prompt. Cancelling that replacement
then left the native quit request unanswered. Each local preflight now captures
the existing attempt generation and rechecks it and the live close/barrier state
after both awaits. Accepted native requests invalidate older local attempts.
Five new tests cover stale same-round cancellation, concurrent retry timers and
disposal, authoritative native cancellation, cancelled close preflight, and native
prompt replacement. The original failing outputs are in
/tmp/oarlock-review58-repro.log and /tmp/oarlock-review58-close-repro.log.

An additional data-loss reproduction remains unresolved pending the user's
architecture decision: Restore/Save As creates a detached draft's target, another
window deletes and replaces it before the write reply arrives, and recovery then
marks the draft clean and reloads the unrelated replacement over it. Detached
tabs deliberately ignore mutation events, including events for a destination
whose creation is still awaiting its reply. The controlled test exercises
DocumentSession and the real mutation planner, holding only the native write's
reply after the simulated disk commit. It fails with the replacement text where
the draft should remain. The reproduction is preserved outside the passing suite
in /tmp/oarlock-review58-recovery-repro.test.ts and
/tmp/oarlock-review58-recovery-snippet.ts; output is
/tmp/oarlock-review58-recovery-repro.log. Asked whether pending recovery should
own its destination and retain the detached draft on changes (recommended), or
follow the newly created file through renames. No recovery ownership change has
been made without that decision.

Review 58 validation: 4,951 frontend tests in 529 files and 1,367 Rust tests
pass; three existing native tests remain ignored. Types, lint (81 existing
warnings), Clippy --all-targets --locked with warnings as errors, production
build, startup graph and whitespace checks pass. Native tests used the serial
cargo test --locked fallback on macOS. Compressed client JS is 2,823,215 bytes
(+57), startup approximately 251.37 kB; terminal/WebGL/WASM are unchanged. The
total allowance moves to 2,823,220 bytes for this measured ownership fix. Logs
use /tmp/oarlock-review58-*. Live multiwindow and Windows/Linux/WSL validation
remain outstanding. Changes remain local and uncommitted. The open recovery
finding prevents release clearance for this review pass.

Review 59 implements the approved pending-recovery ownership decision. Restore
and Save As register their destination in the owning environment before creating
it. The existing native mutation subscription invalidates matching pending
recoveries immediately on receipt, before the quit barrier can defer tab updates.
Deletion, renaming away, renaming onto the destination, and ancestor mutations
retain the detached draft, even if a later event moves the file back. Unrelated
paths or WSL distributions do not invalidate it; Windows host destinations in
WSL-owned editors correctly observe the host environment. Missing or lost
mutation coverage refuses new recovery before creation and invalidates work in
flight. The existing document-synchronization Retry restores availability.

Before binding a successful creation, DocumentSession reads the destination and
compares its native file-identity/content version with the creation result.
Changed, unreadable, binary or oversized destinations retain the draft and report
failure. New typing remains dirty. Validation also supplies AI-context eligibility;
there is no subsequent unconditional reload that could replace the draft. A final
quit seal prevents recovery from starting or committing a late binding. Active
tracking is released on completion, failure or document closure. The tracker uses
the existing event stream and only retains entries for active recovery, with no
new native subscriptions, idle timers or dependency. Successful recovery adds one
versioned read, replacing the old post-binding reload; recovery with newer typing
now also validates before binding. A write already committed may still have
created a file when recovery is interrupted: the error asks the user to check the
destination before retrying and never deletes or overwrites that file.

The Review 58 data-loss reproduction is now a passing permanent regression.
Sixteen added tests cover replacement before the write reply, identical bytes in
a different native identity, mutation during final validation, move-away-and-back,
barrier-deferred events, listener failure/disposal, absent coverage and retry,
newer edits, read failure, closing while a write is pending, final quit sealing,
ancestor/path matching, and WSL/host ownership. The approved recovery architecture
question is resolved; no new architecture decision is pending from this fix.

Review 59 validation: 4,967 frontend tests in 530 files and 1,367 Rust tests
pass, with three existing native tests ignored. Types, lint (81 existing
warnings), Clippy --all-targets --locked with warnings as errors, production
build, startup graph, size and whitespace checks pass. Focused workspace tests
were rerun after removing two new test-only lint warnings. Native validation used
serial cargo test --locked on macOS. Total compressed client JS is 2,823,832 bytes
(+617), startup approximately 251.08 kB; terminal/WebGL/WASM sizes are unchanged.
The total allowance moves to 2,823,840 bytes for the measured recovery tracking
and validation cost. Logs use /tmp/oarlock-review59-*. Live multiwindow and
Windows/Linux/WSL validation remain outstanding. Changes remain local and
uncommitted; these checks do not establish overall release clearance for PR #1.

Review 60 reproduced and fixed an autosave regression in candidate formatting.
formatAndSave cleared a scheduled autosave before invoking the formatter, but a
failed or superseded candidate never restored it. A dirty draft could then stay
unsaved indefinitely with autosave enabled. Formatting now remembers whether it
suspended an autosave and owns that timer generation. Abandoning preparation
restores only its own suspended timer, in the same live document. A later edit,
save, conflict or document transition supersedes that ownership. Successful
candidate adoption still follows the existing save path, and a save conflict does
not start repeated autosave retries. Five permanent tests cover formatter failure,
superseded output, a conflict in the candidate save, and conflicts before or during
preparation. The original failure is /tmp/oarlock-review60-format-repro.log.

Two additional findings await architecture decisions; neither was silently fixed.
First, confirming Git Discard and then typing new editor work while native Git is
running loses that newer buffer on completion. notifyFilesDiscarded fires after
the native command; useEditorFileSync starts a forced reload then, so its revision
snapshot is too late to protect edits made during the command. The controlled
reproduction runs the real Source Control hook, DocumentSession and gitSignals,
using the same forced-reload subscriber contract as useEditorFileSync and holding
only the native command. It gets HEAD content instead of the new draft. Asked
whether confirmation should capture editor revisions and retain newer buffers as
dirty (recommended), or freeze affected editors while discard runs. The failing
reproduction is retained outside the passing suite at
/tmp/oarlock-review60-discard-repro.test.ts and -discard-repro.log.

Second, pending recovery compares displayed path spellings with mutation paths.
A real temporary-filesystem reproduction uses both /./ and a directory symlink
for the recovery target, renames the same file away and back using its other
spelling, and confirms the tracker never invalidates. Device, inode, birth time
and content remain the same, so final native identity/content validation alone
cannot detect that history. Asked whether pending recovery should match native
resolved destination identities while preserving displayed paths (recommended),
or reject aliased destinations. This changes the mutation contract and is held
for the user's decision. The two failing tests and output are preserved at
/tmp/oarlock-review60-alias-repro.test.ts and -alias-repro.log. These reproductions
must be adapted into permanent regressions when the approved fixes are made.

Review 60 validation: 4,972 frontend tests in 530 files and 1,367 Rust tests
pass, with three existing native tests ignored. The pending Git-discard and alias
reproductions still fail separately as documented above; passing suites do not
resolve those findings. Types, lint (81 existing warnings), Clippy --all-targets
--locked with warnings as errors, production build, startup graph, size and
whitespace checks pass. Native tests used serial cargo test --locked on macOS.
Total compressed client JS is 2,823,888 bytes (+56); startup approximately
251.08 kB and terminal/WebGL/WASM sizes are unchanged. The total allowance moves
to 2,823,890 bytes for the measured formatting cleanup. Logs use
/tmp/oarlock-review60-*. Changes remain local and uncommitted. Live multiwindow
and Windows/Linux/WSL runtime validation remain outstanding. The open findings
prevent PR #1 release clearance in this pass.

Review 61 implements both approved Review 60 decisions. Git Discard now captures
DocumentSession ownership/revisions in the initiating window immediately before
native dispatch. Its preparation suspends the confirmed buffer's autosave and
blocks watcher reloads; typing stays enabled. Newer edits remain protected by the
live dirty/close guards even if an autosave finishes while Git is running. On
completion, only the unchanged confirmed buffer can be replaced. Newer text stays
in the editor, gets the final disk baseline, and remains dirty when it differs.
A short "Newer edits kept" notice explains why it was retained. Earlier save
replies/queued saves and reads are invalidated, so a delayed write reply cannot
mark retained text clean. Failed/partially applied Git commands revalidate disk
without throwing away any buffer; unreadable/deleted destinations detach the
retained draft with recovery guidance. Preparation for a loading, closed or
replaced document cannot strand its load or affect the replacement. Completion
passes through the existing mutation/quit barrier before changing document state.
The per-document preparation map allocates only while Discard is active and is
released afterward; there is no editing freeze or per-keystroke IPC.

Pending recovery also owns a native, window-scoped destination record. It pins
the authorized destination directory with the existing Destination capability,
retains the native resolved target plus the original requested path, and uses
the native mutation stream's gate for both acquisition and entry identity capture.
Mutations resolve their affected entries before rename/deletion, while they still
exist; only committed events invalidate records in their owning environment.
This catches /./ and directory-symlink spellings, ancestor mutations and
away-and-back renames even if the final file identity/content version is equal.
The UI's displayed recovery path stays unchanged. Native checks also revalidate
authorization, alias resolution and the pinned directory. A replaced parent or
retargeted alias therefore interrupts recovery. Foreign windows cannot inspect
or release handles. Window close/reload releases its directory handles and
invalidates late acquisitions with an owner generation; IDs are never reused.

The existing local recovery tracker still reacts before deferred tab events;
native checks make alias history authoritative. Acquiring/checking a native handle
is asynchronous, and DocumentSession rechecks its own epoch after every await.
Closing during acquisition cleans up the returned handle without writing; closing
during validation cannot rebind the document. Normal success uses one acquisition,
two small status checks and one release in addition to the existing create/read
validation; these IPC calls exist only during explicit Restore/Save As. Native
mutations do no extra identity resolution when no recovery is active. Records,
file handles and local tracking end on success, failure, disposal or window
teardown. External programs do not participate in Oarlock's mutation history;
the existing pinned-directory and final identity/content validation remain the
protection against their concurrent changes.

Fifteen added frontend tests and four native tests cover the original discard
reproduction through the real Source Control hook/gitSignals, unchanged/newer
buffers, edits during reread, autosaved-but-not-yet-durable drafts, partial failure,
untracked deletion, late save replies, loading/remounted documents, quit deferral,
async recovery disposal, native alias matching, parent replacement, native window
ownership and failed/unrelated mutations. The earlier local-only alias reproducer
is superseded by the permanent real-filesystem native test plus the frontend
native-tracker test. Both approved architecture questions are resolved.

Review 61 validation: 4,987 frontend tests in 530 files and 1,371 Rust tests pass;
three existing native tests remain ignored. Types, lint (81 existing warnings),
Clippy --all-targets --locked with warnings as errors, production build, startup
graph, size and whitespace checks pass. The final equivalent lint cleanup was
followed by types, lint, all 79 DocumentSession tests and a fresh build. Native
validation used serial cargo test --locked on macOS. Total compressed client JS
is 2,824,540 bytes (+652), startup approximately 251.03 kB; terminal/WebGL/WASM
sizes are unchanged. The total allowance moves to 2,824,550 bytes for the measured
coordination and recovery wrappers. Logs use /tmp/oarlock-review61-*. All changes
remain local and uncommitted. Live multiwindow and Windows/Linux/WSL runtime
validation remain outstanding; this is not overall release clearance for PR #1.

Review 62 found two further ownership problems and holds both fixes for the
user's architecture decision. No production behavior changed in this pass.

The Discard preparation added in Review 61 is window-local (gitSignals keeps a
JavaScript listener set). A controlled two-DocumentSession/shared-disk reproduction
starts Discard in window A, types and saves new work in window B, completes A's
native Git write, and delivers the normal watcher reload to B. B has no pending
Discard preparation, treats its saved buffer as clean, and replaces the new text
with HEAD. The saved file was also overwritten by the earlier Git command, so
this loses the newer work. This is a model of the actual cross-window contract,
not a completed live two-webview UI test. Asked whether Discard should coordinate
preparation/completion across all windows (recommended), or refuse while another
window has affected documents. The failing full test, snippet and output are
/tmp/oarlock-review62-cross-window-repro.test.ts,
/tmp/oarlock-review62-cross-window-snippet.ts and
/tmp/oarlock-review62-cross-window-repro.log. The permanent fix must also protect
close/save-and-close and watcher adoption in non-initiating windows.

Native recovery cleanup also takes the mutation stream's global mutex in
release_window. The same mutex stays held through filesystem work in apply_tracked,
and lib.rs calls release_window synchronously in window reload/destruction
callbacks. A controlled native test holds an unrelated filesystem operation in
that gate and proves cleanup cannot finish until the operation releases it.
Consequently a long delete or stalled network/WSL operation can block the app's
lifecycle/UI thread. No live UI hang was induced. Asked whether ownership should
invalidate immediately with handle cleanup deferred off the UI thread
(recommended), or closing should wait for filesystem operations. Moving cleanup
to a worker alone is insufficient: late acquisition and replacement-page handles
must still obey the approved window generation ownership. The failing native
module, snippet and log are /tmp/oarlock-review62-cleanup-repro.rs,
/tmp/oarlock-review62-cleanup-snippet.rs and
/tmp/oarlock-review62-cleanup-repro.log.

Both failing reproductions are retained outside the normal suite while the
architecture decisions are pending. Temporary test insertions were removed
exactly, and the unchanged targeted suites pass: 107 frontend tests in four files
and six native mutation/recovery tests. Whitespace validation passes. Full suites,
Clippy and build were not rerun because this pass changed only these review notes;
the last full validation remains Review 61. Live multiwindow and Windows/Linux/WSL
runtime coverage is still outstanding. Changes remain local/uncommitted, and the
open findings prevent overall PR #1 release clearance.

Review 63 implements the two approved Review 62 decisions. Discard now has a
native coordinator (`modules/git/discard.rs`) and a page client
(`editor/lib/discardCoordinator.ts`, thin IPC bridge in `discardBridge.ts`).
Confirmation captures the initiating page's editor revisions before IPC. Native
begin validates and stores the repository/environment/entries without executing
Git, requires registered participants for all current app windows, and broadcasts
preparation with page tokens and an operation identity. Execution waits for every
preparation acknowledgement; missing/unavailable pages, reload during preparation,
a five-second preparation timeout and concurrent discards fail safely. Git is
owned by a native worker after dispatch, so closing its initiating page does not
orphan completion. Native state locks never cover filesystem access, event delivery
or waits. Finished outcomes remain until participating pages acknowledge them;
pages still loading retain membership and receive preparation/outcome in their
registration snapshot as well as events. Old page tokens cannot acknowledge work
for replacement pages. Failed/lost execution responses cannot release editor
protection while native reports a running operation. Active clients reconcile
status/settlement every two seconds only while work or acknowledgements remain;
there is no idle polling. Initial registration failure exposes Retry.

Discard document participation now lives with mounted DocumentSessions, so editors
opened while a discard is running join the operation. Loading documents keep their
initial read alive, or restart it if completion comes first. Other windows and
late participants conservatively preserve their text, including saves completed
before they receive preparation, because those windows did not provide the
originating confirmation. Their buffers cannot report safe-to-close merely because
a write completed while Git was still running. Only unchanged confirmation-time
buffers in the originating window are replaced. Completion updates retained
buffers' disk baseline; ordinary watchers cannot adopt intermediate Git contents.
The source-control hook uses the same coordinator through the native adapter.

Recovery window ownership uses a separate, short-held registry of atomic live
generations. Reload/destruction invalidates the old generation immediately; pinned
handle cleanup runs on a blocking worker only when that window held a generation.
Acquisition checks generation before and after filesystem work, validation checks
again after filesystem work, and delayed cleanup removes only dead generations,
never replacement-page handles. Ending a recovery handle also runs off the UI
thread. The ordered mutation gate still serializes filesystem mutation/recovery
identity capture, but window lifetime callbacks no longer acquire it.

Fifteen additional frontend tests and twelve native tests cover the original
cross-window autosave loss, capture before dispatch, loading/new documents,
registration snapshots, lost completion/acknowledgement recovery, ambiguous
execution failures, duplicate/foreign events, overlapping starts, native participant
barriers, timeouts, owner close, replacement/loading pages, nonblocking cleanup,
late acquisition and generation invalidation during validation. Full validation:
5,002 frontend tests in 532 files and 1,383 native tests pass; three existing native
tests remain ignored. Types, lint (81 existing warnings), Clippy all targets locked
with warnings as errors, production build, startup graph and whitespace checks
pass. Native validation used serial cargo test --locked on macOS. Total client JS
with the Bun size script is 2,826,013 compressed bytes (+1,473); its measured
allowance moves to 2,826,020. Startup is 250,964 bytes, terminal JS 92,546, WebGL
16,465 and WASM 654,361, all within their existing limits. No dependency added.
Logs use /tmp/oarlock-review63-*. These checks do not replace live multiwindow or
Windows/Linux/WSL runtime validation; changes remain local and uncommitted.

A further Discard identity issue is reproduced and held for an architecture
decision: participating editors still match native scopes by path spelling.
A real-filesystem test opens a second editor through a directory symlink, prepares
the canonical repository path, saves newer text through the alias, simulates Git's
final write and delivers the normal watcher reload. The aliased editor was not
captured, so it loses the newer text and displays HEAD. This is a controlled
DocumentSession/shared-filesystem reproduction, not a live two-webview Git test.
The failing test/snippet/log are /tmp/oarlock-review63-alias-repro.test.ts,
/tmp/oarlock-review63-alias-snippet.ts and /tmp/oarlock-review63-alias-repro.log.
Temporary insertion was removed exactly after reproduction. Asked whether to match
open documents by native-resolved identity (recommended) or conservatively retain
all editor buffers in the environment. That extension of document registration is
not implemented pending the user's answer. PR #1 is not cleared for release.

Review 64 implements the approved native document-identity matching for Discard.
The production bridge now stages the current environment's mounted documents
before IPC, then resolves their membership through git_discard_match_documents.
That command accepts only a live participant's page token and operation identity;
it reads the native operation's prepared scope, validates document paths through
the owning environment and app filesystem gates, and compares native-resolved
entry and read-target paths. Directory aliases, dot paths, missing descendants
and leaf symlinks are handled without using frontend path spelling as authority.
Discarding a symlink entry matches an editor opened through that link, but does
not mark a separately opened target file as discarded. Lookups use fresh native
resolution rather than a persistent canonical-path cache, and run off the UI
thread without holding the coordinator state lock. The worker retains the
canonical repository path established during preparation, so changing the
original repository alias cannot redirect that prepared worker.

DocumentSession.stageDiscard captures the buffer revision and guards watcher
adoption during identity lookup without invalidating an unrelated in-flight save,
formatter or autosave timer. Matching candidates acquire normal Discard ownership;
unmatched candidates release their temporary guard and replay a watcher read only
if it was suppressed. Navigation/close invalidates late candidate selection.
Other-window and late-document candidates retain independent text as before.
Preparation acknowledgements wait for initial and newly mounted candidates to
resolve. Completion likewise waits before releasing the native participant, so
native scope cannot disappear under a late lookup. Lookup failures, incomplete or
invalid result arrays and rejected IPC prevent preparation acknowledgement;
unknown buffers are retained on failure. Synchronous lookup failures are also
captured, and disposal before lookup dispatch avoids the native request entirely.
There is no idle identity lookup, watcher or timer added: normal cost is one
batched identity request per participating window with documents, plus a request
for a document opened during an active round. No dependency was added.

Thirteen additional frontend tests and five native tests cover the real-filesystem
alias reproduction, unrelated saves and suppressed watcher reads, edits while a
lookup waits, loading/new documents, late navigation/disposal, no early Git dispatch
or completion acknowledgement, malformed/failed identity responses, canonical
entry versus symlink-target semantics, missing descendants, authorization refusal,
environment validation and repository-alias retargeting. The old Review 63 failing
alias reproduction is superseded by the permanent nativeDiscard.test.ts test plus
native match_documents tests. Full validation passes: 5,015 frontend tests in 533
files and 1,388 native tests; three existing native tests remain ignored. Types,
lint (81 existing warnings), Clippy all targets locked with warnings as errors,
production build, startup graph, size and whitespace checks pass. The final
frontend suite ran after the suppressed-read cleanup. Native checks used serial
cargo test --locked on macOS; the 13 native Discard tests were also rerun after
removing the temporary reproduction below. Total compressed client JS is
2,826,439 bytes (+426), with a measured allowance of 2,826,440. Startup is 250,948
bytes; terminal JS, WebGL and WASM remain within their unchanged limits. Logs use
/tmp/oarlock-review64-*. Changes remain local/uncommitted; live multiwindow and
Windows/Linux/WSL runtime checks are still outstanding.

Review 64 also confirms a separate repository-ownership race and holds its fix
for the user's decision. In a real-Git native test, prepare Discard for repository
A, rename A's canonical directory away, replace its old location with a symlink
to authorized repository B, then execute the prepared operation. B's edited file
is restored to HEAD. Keeping the originally resolved path prevents retargeting the
initial alias, but execution still reopens that canonical path and can follow its
replacement. Native document matching also prepared A's scope, not B's. Asked
whether destructive Git operations should retain native repository-directory
ownership through execution, reject replacement, and fail safely where a platform
cannot guarantee the binding. This extends directory-handle ownership to Git and
is not implemented pending that architecture decision. The failing native test,
snippet and log remain at /tmp/oarlock-review64-repo-replacement-repro.rs,
/tmp/oarlock-review64-repo-replacement-snippet.rs and
/tmp/oarlock-review64-repo-replacement-repro.log. Its temporary insertion was removed
exactly; this known issue remains a release blocker for PR #1.

Review 65 implements the approved repository-directory ownership boundary for
native Git mutations. `git/ownership.rs` retains an operation-scoped native
handle; `owned_repo_root` resolves fresh filesystem state rather than the
canonical-path cache and authorizes the directory actually acquired. Discard's
prepared Work owns that same resolved repository through the cross-window wait
and worker execution. There is no path-only fallback when its ownership is
missing. Stage, Unstage, Commit, Undo, Push, Fetch, Pull, branch switching and
worktree Add/Remove also acquire ownership, retaining it across preflights and
command batches. Resolved-repository command/line helpers carry the optional
ownership into the shared Git runner; read-only instances retain their previous
unbound execution path and incur no directory pin.

On Unix, command configuration validates the retained directory's actual path and
device/inode against its name. An async-signal-safe pre_exec callback repeats the
identity comparison with fstat/lstat and enters the directory with fchdir using the
retained descriptor. It never changes Oarlock's own cwd. Thus replacing the path
between command configuration and spawn fails before Git executes in the wrong
repository, rather than merely leaving a second check-to-open gap. Handles stay
alive through command capture; ownership is checked again after completion and
before each later command in a batch. A move during an already-running operation
can leave changes in the original repository and return an error; this is not a
rollback mechanism or a lock on arbitrary file edits. A real-Git clean-filter test
moves/replaces the directory while Git is already running and verifies that the
replacement repository's index and working file are untouched.

On Windows, the implementation opens the resolved directory and its ancestors
without write/delete sharing, rejects reparse-point components, and retains those
handles while CreateProcess/Git use the cwd. Failure to acquire that protection is
an error. A Windows-only regression checks that repository and ancestor renames
are blocked until the handles are dropped. This platform path has not been run or
cross-compiled in the current macOS environment and requires Windows CI/runtime
validation before release.

WSL deliberately fails closed for these native mutation operations: a host-side
UNC handle does not establish Linux-side cwd ownership for wsl.exe. The native
error explains that the operation must currently be run in the WSL terminal.
Read-only WSL Git calls retain their existing behavior. There is no setting or
fallback that silently restores path-only native mutation execution. Supporting
these actions again requires a Linux-side ownership mechanism. This is a material
availability limitation, accepted by the approved fail-safe policy, not a claim
that WSL mutation support is complete.

The original Review 64 real-Git replacement reproduction is now a permanent passing
test through prepared Work execution. Six more macOS tests cover same-name directory
replacement, ancestor moves, normal file edits, the configure-to-spawn boundary,
child versus app cwd, the running-filter/index race and WSL refusal (some concerns
share a test); an additional Windows-specific test covers sharing locks. Full
validation passes: 5,015 frontend tests in 533 files and 1,395 native tests, with
three existing native tests ignored. Types, lint (81 existing warnings), Clippy
all targets locked with warnings as errors, startup graph, size and whitespace
checks pass. Native checks used serial cargo test --locked on macOS. No frontend
production file or dependency changed; the verified Review 64 client build and
size limits remain unchanged (2,826,439 compressed JS bytes). No idle handles,
timers, threads or IPC calls are added. Active Unix mutations retain one directory
handle; Windows retains one per resolved ancestor. Unix mutations use the pre_exec
launch path; ordinary read-only Git calls keep the existing launch path. Logs use
/tmp/oarlock-review65-*. All changes remain local/uncommitted. The reproduced
repository-root blocker is resolved, but this is not overall PR #1 release
clearance: live multiwindow and Windows/Linux runtime validation, plus the WSL
availability limitation, still need release consideration.

Review 66 confirms two remaining Git-context blockers with real-Git native
reproductions through prepared Discard Work. First, configure repository A's
`core.worktree` to repository B, then prepare and execute Discard for A: B's edited
file is replaced with A's indexed content. Second, prepare Discard for A, move its
`.git` directory aside and replace it with a symlink to B's `.git`: execution
succeeds and replaces A's edited file with B's indexed content. Both tests use
distinct committed contents, so wrong-repository execution is directly observed.
The working-directory handle remains valid in both cases. Pinning cwd alone does
not bind Git's effective worktree, administrative directory or common directory.

The broader fix is held for the user's architecture decision: bind the selected
worktree and its Git metadata/common directory together, reject redirection or
replacement, and retain support for validated linked worktrees. No new execution
policy or ownership mechanism has been implemented in this pass. The two failing
tests and complete inserted module are preserved outside the normal test suite at
/tmp/oarlock-review66-git-context-snippet.rs and
/tmp/oarlock-review66-git-context-repro.rs; output is in
/tmp/oarlock-review66-git-context-repro.log. The temporary insertion was removed
exactly. The existing ownership fix remains in place.

Targeted verification after restoring the module passes: 128 native Git tests and
29 frontend Discard coordination/bridge/native-matching/signal tests across four
files. Whitespace checks pass. Logs are /tmp/oarlock-review66-git-tests.log and
/tmp/oarlock-review66-discard-tests.log. No production code or dependency changed,
and the full suites, types, lint and Clippy were not rerun in this diagnostic-only
pass; their Review 65 results are historical, not new validation. The two new
reproductions remain release blockers, and PR #1 is not cleared for release.

Review 67 implements preparation and launch-time binding of the selected worktree,
Git administrative directory and common directory. `RepositoryPin` now owns
separate `DirectoryPin` capabilities for those identities. Acquisition authorizes
the worktree before Git discovery; bounded native reads resolve gitfiles and
commondir, and a read-only, cwd-pinned Git probe must report the same metadata and
worktree. A configured foreign core.worktree is refused. Validated linked
worktrees keep their separate index and shared metadata; bare repositories remain
usable for worktree management. Each command validates the layout again and adds
operation-owned GIT_DIR, GIT_COMMON_DIR and GIT_WORK_TREE after inherited overrides
have been removed. A later core.worktree edit cannot redirect that command. Unix
pre_exec checks every retained directory identity; Windows retains the existing
sharing restrictions. No idle process, timer or dependency was added. Acquisition
adds one short Git discovery process; active operations retain two directory
handles for ordinary repositories and three for linked worktrees (plus ancestors
on Windows). The two Review 66 reproductions are permanent passing tests, with
five additional regressions for linked/bare repositories, changed gitfiles and
commondir, late core.worktree edits and metadata replacement before spawn. The
older alias preparation test now initializes its fixture as an actual repository.

Validation passes: 5,015 frontend tests in 533 files and 1,402 native tests, with
three existing native tests ignored. Types, lint (81 existing warnings), Clippy
all targets locked with warnings as errors and whitespace checks pass. Full native
checks used serial cargo test --locked on macOS. Logs use /tmp/oarlock-review67-*.
No frontend production code or dependency changed; no new bundle build/size result
is claimed. Windows/Linux runtime validation remains outstanding; WSL mutations
remain explicitly unavailable. Changes are local and uncommitted.

This is NOT lifetime enforcement for an external Unix Git process. A new real-Git
reproduction pauses A's pre-commit hook, replaces A/.git with a symlink to a clone
B/.git sharing the old HEAD, and resumes. B's branch advances before Oarlock's
post-command ownership validation returns an error. The failing test was removed
exactly from the normal suite and preserved at
/tmp/oarlock-review67-running-metadata-snippet.rs,
/tmp/oarlock-review67-running-metadata-repro.rs and
/tmp/oarlock-review67-running-metadata-repro.log. It remains a release blocker.
The user chose to design a stronger execution boundary now rather than disable
native mutations for this release. Preparation checks above are useful hardening,
but must not be described as resolving this remaining blocker.

Review 67 execution-boundary design (proposed, not a production implementation):

- The native coordinator owns the authorized worktree, per-worktree metadata and
  shared metadata capabilities, an operation ID, baseline versions, and the
  publication journal. External Git and every descendant receive no writable live
  repository access. Native code alone publishes changes through retained
  directory capabilities. Path strings describe UI locations, never publication
  authority. A post-write error is not an acceptable substitute for confinement.
- The user subsequently accepted best-effort behavior for repository moves and
  replacements by another same-user process, superseding the earlier requirement
  to follow the opened repository when it conflicts. Existing retained handles
  still protect paths where available, but live Git can race a replacement.
  Protection against static untrusted repository content remains required.
- Native Source Control operations inspect repository and worktree Git config,
  included repo-origin settings and the common hooks directory before executing.
  They refuse configured executable extensions with an explanation; command-line
  overrides provide defense in depth for hooks, fsmonitor, signing and selected
  helpers. Trusted user-wide authentication helpers remain available to network
  operations. Fetch, pull and push inspect expanded remote URLs, and local remotes
  must be separately authorized and inspected; an unrelated unsafe or unauthorized
  configured local remote also blocks the operation. Skill installation clones
  without checkout and inspects before checkout. WSL read-only operations use
  best-effort inspection; their platform runtime still needs validation. Changes
  by another same-user process after inspection remain a documented race. The
  isolated executor is not implemented and terminal Git is not affected.
- Acquire and validate source identities, then capture a coherent operation input:
  selected index/worktree state, HEAD and relevant refs, effective configuration,
  and hook/filter identities. Detect changed inputs during capture and retry or
  return a conflict before running anything. Linked worktrees share the common
  metadata transaction gate while retaining distinct indexes and HEADs. Loading
  and waiting do not freeze editors; the existing cross-window Discard preparation
  and buffer-revision rules still apply.
- Materialize an operation-private candidate repository. Never use mutable
  hardlinks, live writable alternates, or gitfiles pointing back to live metadata.
  Do not blindly copy .git and trust its config. Regenerate its layout and sanitize
  context/extension/helper configuration. Candidate object data must be verified
  and obtained from the authorized snapshot; automatic lazy fetch is a separately
  authorized network operation. Reflink/copy-on-write support and bounded,
  demand-driven object transfer are optimization candidates, not prerequisites or
  already-validated features. The full-copy toy probe below is not a scalable
  implementation. Resource limits and representative large-repository benchmarks
  must be settled before integration; limit exhaustion fails visibly.
- Run Git in a platform-enforced child boundary: writes only to operation-private
  storage, with restrictions inherited by descendants. A temporary folder and
  environment variables alone are not confinement. The production runner must
  gate on actual enforcement capability; it must never fall back to unrestricted
  execution. Read, network, credential/helper, executable and process permissions
  need separate explicit policies; the prototype tests only filesystem writes.
  Repository-provided code cannot select the sandbox policy or publication scope.
- Treat candidate output as untrusted. A command-specific, dependency-light planner
  produces an allowlisted change manifest: expected identities/versions, candidate
  contents and modes, index changes and compare-and-swap ref transitions. Reject
  unexpected config/layout changes, escaping symlinks, malformed output, unknown
  repository extensions and unsupported index/ref formats. There is no generic
  "copy the candidate .git back" step. Git-entry semantics for symlinks and the
  existing content/privacy boundaries must survive this design.
- Prepare every destination with native handles, Git-compatible locks and expected
  versions. Revalidate the source context and changed destinations before
  publication. Publish objects before refs; index/ref/worktree changes need a
  durable, operation-specific journal and an explicit commit point. Multi-file
  publication is not magically atomic. A partial failure retains recovery evidence
  and reports affected paths; rollback must never overwrite a newer external edit.
  Crash recovery must verify identities again and must not reopen an old display
  path as authority. External tools that ignore Git locks remain a conflict risk;
  this design does not promise a machine-wide filesystem transaction.
- Candidate cancellation discards private work. Publication cancellation follows
  the journal's commit point, not arbitrary process termination. Cross-window
  completion releases editor protection only after the native outcome is known.
  Native publication, cleanup and recovery use directory-relative operations;
  there is no subprocess running live `git update-ref` as a final "safe" step,
  since that would reintroduce the same pathname race.
- Stage/Unstage, Commit/Undo and Discard each need a separate publication protocol.
  Branch switching, fast-forward pull and worktree Add/Remove additionally change
  many worktree entries and need their own manifests/recovery. Push has a remote
  commit point that cannot be rolled back by a local journal; remote success plus
  local failure must be reported distinctly and never auto-retried as if nothing
  happened. Fetch/network credential helpers cannot simply inherit ambient access.
  Read-only commands are not automatically harmless: lazy fetch, filters and hooks
  must be considered when classifying them. Integration should enable a command
  only after its complete protocol passes fault-injection tests.
- Preserve zero idle cost: no permanent VM, daemon, polling watcher or background
  snapshot. Scope temporary state and handles to active operations, serialize
  conflicting writes per shared metadata identity, and bound waiting operations,
  disk staging and output. Do not silently replace system Git with a heavy Git
  library: a library that opens ordinary paths does not solve this ownership bug.

The user approved the hook policy after Review 67: run supported hooks and filters
inside the candidate boundary; a hook requiring unavailable/live-path access fails
the action with an explanation and terminal guidance. Never silently skip a hook
or rerun it unrestricted. This changes compatibility, including hooks that format
live files, use absolute project paths, expect a sibling checkout, or write
dependency caches outside the candidate. Platform enforcement and compatibility
validation remain prerequisites to integration; approval is not evidence that the
production hook runner is implemented.

Design evidence: /tmp/oarlock-review67-sandbox-probe.py creates only temporary
repositories, copies A to a private candidate, pauses its real pre-commit hook,
retargets live A/.git to B/.git, then resumes. macOS sandbox-exec restricts child
writes to the candidate and /dev/null. The candidate commit succeeds; a nested
shell's attempted write to B/file is denied; B's file and HEAD remain unchanged.
The passing output is /tmp/oarlock-review67-sandbox-probe.log. This establishes the
limited write-confinement mechanism on this machine, not a production sandbox:
it permits ambient reads/network and copies the small test repository wholesale.
The first nested-sandbox attempt could not apply the policy; the explicit temporary
probe passed outside Codex's sandbox. Apple's installed sandbox-exec manual marks
that launcher deprecated. A supported/maintainable macOS helper strategy, Linux
and Windows implementations, packaging/signing, capability probes and failure UI
remain design/validation gates. No production dependency on sandbox-exec was added.
Existing native destination tests independently exercise the final validation-to-
publication race: replacement cannot redirect the handle-relative write or cleanup
into another directory. They do not implement a Git transaction or journal.

Required acceptance evidence for the new runner includes the running-hook failure
above (which must become a permanent passing integration test), same-name directory
replacement rather than only symlinks, common-directory/gitfile/ancestor swaps,
child-process escape attempts, unsupported/failed confinement with no fallback,
concurrent external Git and editor saves, linked-worktree isolation, hook failures,
full staging budgets, cancellation in every phase, process death between journal
steps, startup recovery without overwriting newer work, and platform tests on each
supported OS/WSL environment. No production runner or publication protocol is
implemented by this design pass; PR #1 remains blocked.

Primary references for the design: Git's environment and repository-layout
contract at https://git-scm.com/docs/git#Documentation/git.txt-GIT_COMMON_DIR,
hook cwd/environment behavior at https://git-scm.com/docs/githooks,
ref transaction semantics at https://git-scm.com/docs/git-update-ref,
and Linux confinement capability/ABI considerations at
https://docs.kernel.org/userspace-api/landlock.html. Mount namespaces provide a
Linux-specific filesystem view, not a cross-platform solution; see
https://man7.org/linux/man-pages/man7/mount_namespaces.7.html. These references
inform the proposal; they are not evidence that an Oarlock runner already exists.

Review 68 records the user's approval to fail unsupported hooks explicitly, without
silently skipping them or rerunning them unrestricted. Production helper selection
is still held for a separate architecture decision. The macOS proposal is an
on-demand, separately signed and sandboxed XPC service bundled with the app; the
alternative presented is a runtime sandbox-exec dependency with capability checks.
The existing app is not App Sandboxed (its entitlements grant camera and microphone
access), and must not be made App Sandboxed merely to constrain Git: its terminal
has different requirements. Apple's installed sandbox-exec manual marks that
launcher deprecated; its successful prototype is not approval to ship it.

The proposed XPC boundary is concrete enough to review before implementation:
embed a private service under Contents/XPCServices, with its own sandbox/signature
and a profile-specific service/container identity so development and release do
not share candidate state. Use a versioned, narrow operation protocol rather than
arbitrary command/path/env forwarding. The trusted coordinator supplies an operation
ID, admitted operation, captured configuration and bounded candidate input streams
or operation-private file descriptors. The service receives no writable live
repository descriptor, security-scoped bookmark, inherited PTY, keychain material
or ambient app capability. It starts only on demand; no login item, root helper,
permanent daemon or polling loop is proposed. Git descendants inherit the confined
service execution environment. Runtime probes must verify that confinement is
active and required Git/tool execution works before an operation is admitted.

The coordinator retains publication authority. A worker response must match the
protocol version and live operation ID, report Git completion and all supervised
hook outcomes, and contain only candidate result metadata. No returned absolute
path authorizes a write. Unexpected/missing results, connection loss, process
failure, timeout, cancellation, failed confinement or failed hooks reject the
candidate; none launches an unrestricted retry. Candidate manifests and native
journal/publication checks from Review 67 remain necessary even for successful
worker responses. OS idle termination/restart must not replay a mutation, and no
worker may publish by itself. Helper launch/signature failures get an explicit
unavailable result with terminal guidance. The actual XPC launch, entitlement,
packaging, signing and runtime implementation has not been added pending the
user's helper decision. Linux/Windows need their own equivalent validated boundary;
XPC is a macOS adapter, not a cross-platform implementation.

Review 68 also reproduces a hook-policy trap with real Git: a post-commit hook that
fails after a sandbox-denied write does NOT make git commit exit nonzero. The
private candidate's commit exists while Git reports exit 0. Git documents this
behavior, so command success alone cannot implement the approved hook policy.
The production design must supervise hook completion separately, including hooks
whose exit status Git ignores. The supervisor's control/report endpoint and hook
wrappers must be outside candidate-writable storage; original hook processes must
not inherit the report channel. A crashed wrapper or missing completion is failure,
not success. Result messages need operation/phase/invocation identities and bounded
sizes/counts; duplicates, gaps and protocol mismatch reject the candidate. Preserve
Git's hook arguments/stdin/environment semantics and await its descendants before
accepting output. Native filesystem denial prevents escaped writes even when a
hook deliberately tolerates a denied optional probe; this proposal does not claim
that every denied syscall can be inferred from stderr or that arbitrary hooks
cannot lie about their own success. It independently records actual hook exits.
No publication may be based on parsing human-readable hook output.

Four temporary-repository macOS probes validate parts of that policy:
1. A pre-commit hook requiring a forbidden write fails; Git exits 1, candidate HEAD
   stays unchanged, and the replacement repository's HEAD/file stay unchanged.
2. The corresponding post-commit hook fails but Git exits 0 and changes candidate
   HEAD, demonstrating the missing independent outcome problem.
3. A prototype wrapper reports hook start and exit 1 over a separate pipe, closing
   that pipe in the original hook process. The hook phase is refused despite Git
   exit 0; the replacement repository remains untouched.
4. A positive control writes only inside the candidate and reports hook exit 0;
   the hook phase is accepted. That is not permission to publish: the final native
   identity/version/journal checks still apply, and these probes do not implement
   a publisher or an authenticated production IPC supervisor.

Scripts and outputs are /tmp/oarlock-review68-hook-policy-probe.py/.log,
/tmp/oarlock-review68-post-commit-probe.py/.log,
/tmp/oarlock-review68-supervised-hook-probe.py/.log and
/tmp/oarlock-review68-supported-hook-probe.py/.log. They only use disposable sample
repositories, and run outside Codex's sandbox so the child macOS sandbox can be
applied. Four existing native destination tests pass again, including replacement
between validation and handle-relative publication/cleanup; output is
/tmp/oarlock-review68-destination-tests.log. Whitespace checks pass. No production
code, entitlements, package manifest or dependency changed in this design/probe
pass; full suites/types/lint/Clippy were not rerun, and their Review 67 results
remain historical. The current production runner still has the Review 67 running-
commit blocker. Approval of a policy and passing probes are not release clearance.

Primary sources: Apple's independent XPC sandbox and on-demand service lifecycle
at https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingXPCServices.html,
per-target entitlements and inheritance at
https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html,
and the post-commit outcome contract at
https://git-scm.com/docs/githooks#_post_commit.

Review 69 records approval of the separately signed, App Sandboxed macOS XPC
helper. This supersedes Review 68's pending helper decision. The bootstrap now
lives in `src-tauri/git-worker`, with a small Objective-C XPC client linked by
`build.rs` and an on-demand `git_execution_capability` native command. Its protocol
accepts exactly a version, a 32-character nonce and `capabilities`; extra fields,
paths, commands and execution operations are rejected. Connection success always
returns `executionReady: false`: candidate execution/publication are not present,
and the existing Git runner is not redirected through the helper. The Review 67
running-metadata race remains a release blocker.

The helper has only `com.apple.security.app-sandbox`, with no inheritance,
network, keychain-group or filesystem exception. macOS launches it on demand.
The runtime probe verifies its entitlement and denies opening its own signed
Info.plist for writing (without modifying it). Parent authentication is a compiled
Apple signing-team plus bundle-identifier requirement installed before accepting
messages. Reading the parent's static signature from inside the sandbox failed
in the activation test; granting wider access to work around that was rejected.
The client validates the helper's sealed resources, exact entitlement set and
Apple signing team against its own running code identity, then installs a peer
requirement retaining that authority, the helper's designated requirement and its
expected identifier. Accepting any replacement's self-consistent signature would
be insufficient. Local signature validation runs off the UI thread, followed by
a five-second bounded XPC wait; callbacks retain heap-owned state, never the
caller's output buffer. This command adds no startup work or polling.

Tauri's beforeBundleCommand builds/signs the profile-specific service and embeds
it under Contents/XPCServices. Development uses the isolated `.dev` identity.
Production builds require an installed APPLE_SIGNING_IDENTITY and APPLE_TEAM_ID;
the release workflow imports the existing certificate before the helper build.
The helper is signed with its own entitlements, independently of the terminal
app. Staging and final-package verification reject missing/additional helper
entitlements, wrong identifiers or invalid signatures. The release final-package
check runs after Tauri creates draft assets and fails the release job on error.
No release, upload or notarization was performed locally.

Ad-hoc development artifacts deliberately refuse peers; the production client has
no ad-hoc trust exception. The smoke fixture alone admits its exact isolated
`.dev.git-worker-tests` identity using ad-hoc signing. It verifies XPC transport
and runtime sandboxing, not a Developer ID certificate chain. Tests reject a
wrong parent identity, modified sealed resources, missing or additional sandbox
entitlements, ordinary ad-hoc service policy and ad-hoc authentication in a
production-compiled client. Protocol tests reject unknown operations, extra path
fields, malformed versions and nonces. CI runs this macOS smoke test. The fixture
may leave macOS's isolated test container, but never opens a live repository or
production settings/keychain profile.

A local Tauri debug app was actually bundled and ad-hoc signed; recursive signature
verification and the exact helper-entitlement check pass after packaging. The
unavailable local CLI sidecar was omitted only in this packaging test's command-
line config. The helper also compiles as a universal arm64/x86_64 executable.
These checks do not validate certificate-signed distribution, notarization,
Intel runtime behavior, candidate Git/hook execution or Linux/Windows confinement.
Implementation and test commands are documented in `src-tauri/git-worker/README.md`.

Review 69 validation: frontend types and lint pass (81 existing lint warnings);
all 5,015 frontend tests across 533 files pass. Final native Clippy with
`--all-targets --locked -- -D warnings` and `cargo test --locked --
--test-threads=1` pass: 1,403 tests, three ignored. The real XPC smoke test passes,
including production-client ad-hoc rejection, and the test-policy guard refuses
production and unrelated fixture identifiers. `git diff --check` passes. Logs are
`/tmp/oarlock-review69-{types,lint,frontend-tests,clippy,rust-tests,xpc-smoke}.log`,
with packaging proof in `/tmp/oarlock-review69-tauri-bundle.log` and
`/tmp/oarlock-review69-packaged-verification.log`. No production certificate-chain
or notarization result is implied by these local ad-hoc checks. No commit or push.

Review 70 advances the approved isolated Git boundary without enabling an
incomplete executor. A real App Sandbox/XPC probe found a second process-lifetime
problem: a test hook forks, calls setsid(), returns success, and its detached child
writes another candidate in the same helper container after the supervisor kills
the original process group. App Sandbox confines live-repository writes but does
not isolate successive operations within its container. The probe uses only an
isolated test identity and temporary sample files; source/output are
`/tmp/oarlock-review70-container-probe.mjs/.log`.

The user approved a narrower release policy: native isolated actions requiring
executable hooks, filters or external helpers must be refused, never silently
skipped. This supersedes Review 68's plan to support candidate-only executable
hooks for the first release. `git/candidate_policy.rs` implements bounded config
admission as a dependency-light core. It parses complete NUL-separated config
captures, preserves implicit/empty boolean and last-scalar-value semantics, rejects
filesystem and config-defined hooks, filters, monitors, signing and authentication
programs, and permits only explicit non-executable scalar configuration. Unknown
or context-redirecting configuration fails closed. This initial projection is
intentionally narrow; operation-specific handling of irrelevant settings and
native discovery of effective hook/attribute/config state are still required
before integration. It is not an admission wrapper for the existing live runner.
No configuration values or arbitrary subsection names are printed in refusals.
A real Git 2.56 test confirms that `core.hooksPath=/dev/null` alone does not suppress
hooks declared with `hook.<name>.command` and `.event`; the new policy rejects them.

`git/candidate_index.rs` adds native validation/planning for the first supported
index format (SHA-1, version 2, non-conflicted, non-sparse regular/link entries).
Inputs are bounded to 32 MiB and 250,000 entries. Unknown formats, required or
semantic extensions, invalid paths, malformed padding/checksums, unselected
changes and unexpected selected object IDs/modes fail. Expected object IDs/modes
must come from native-authorized input transformations, NOT the worker manifest.
Unselected entries retain their baseline data; selected entries discard candidate
stat information because its inode/mtime belong to a different directory. Known
disposable caches are removed. A real Git regression proves a forged TREE cache
can make `git write-tree` return a tree disagreeing with the index entries; the
native planner strips the cache and the next tree contains exactly the authorized
change. RustCrypto `sha1` is added only for Git-format checksums, sharing the digest
infrastructure already used by SHA-256. SHA-1 is not an authorization mechanism.
Git's format reference is https://git-scm.com/docs/index-format.

`git/index_publication.rs` adds a single-index publication primitive using the
retained metadata directory capability. It captures file identity plus SHA-256
content, detects in-place changes during reads using the existing document-save
change stamp, obtains Git's exclusive index.lock, writes and flushes prepared
contents and the directory entry, rechecks the repository/index/lock and commits
with a directory-relative rename. No external Git process publishes the index.
A successful rename is the commit point: a subsequent directory-flush failure
returns a committed-but-not-confirmed-durable outcome, never an ordinary failure
or a rollback over newer edits. Metadata replacement cannot redirect publication
or lock cleanup to another repository. Cleanup opens nonblocking without following
links and only removes the owned lock; unreadable/replaced locks are preserved.
A crash before rename leaves the original index and prepared lock; a later attempt
refuses the existing lock rather than replaying or deleting recovery evidence.
External writers ignoring Git locks are still outside a machine-wide transaction.
This is a one-file primitive, not the multi-file commit/ref/worktree journal.

Real-file/fault-injection tests cover successful publication readable by Git,
concurrent locks, identical-content file replacement, edits after staging,
metadata replacement, lock replacement, FIFO substitution, process death before
commit, failure flushing the committed directory and forged tree caches. This
primitive requires verified durable objects BEFORE publication; that object
coordinator is not implemented. It does not enable Stage/Commit by itself.

The execution compatibility probe also found that `/usr/bin/git` is an xcrun
launcher on this macOS installation; it fails with `xcrun: error: cannot be used
within an App Sandbox.` Direct execution of
`/Library/Developer/CommandLineTools/usr/bin/git` successfully initializes, stages
and commits a sample repository inside the actual XPC sandbox with controlled
HOME/config and no executable extensions. Sources/results are
`/tmp/oarlock-review70-git-xpc-probe.mjs/.log` and
`/tmp/oarlock-review70-git-direct-xpc-probe.mjs/.log`. This demonstrates system-Git
execution compatibility, not the production operation protocol, signing chain,
manifest transport or publication coordinator. The choice between requiring a
verified Apple Git installation and bundling a pinned Git runtime was presented
to the user; do not choose a permissive PATH fallback without that decision.

Production `executionReady` remains false. Coherent input/attribute capture,
verified object transfer/publication, XPC operation dispatch/cancellation, per-
command source revalidation, native ref/worktree journaling and recovery, complete
resource-budget/performance validation, and platform adapters remain unfinished.
The original running-metadata race is still a release blocker in the live runner.
These components must not be presented as a completed fix or release clearance.

Review 70 validation: all 5,015 frontend tests across 533 files pass; types and
lint pass with the same 81 existing warnings. Native Clippy passes with
`--all-targets --locked -- -D warnings`. The full native suite passes 1,421 tests,
three ignored. After adding the prepared-directory flush, all ten publication
fault-injection tests pass again and Clippy passes again. Logs are
`/tmp/oarlock-review70-{types,lint,frontend-tests,clippy,rust-tests,publication-tests}.log`.
Whitespace checks pass. XPC probes use temporary, ad-hoc test apps and do not
validate distribution signing. No changes were committed or pushed.

Review 71 investigates the user's Homebrew Git question; no runtime-policy choice
has been made by that question. The installed `/opt/homebrew/bin/git` resolves to
`/opt/homebrew/Cellar/git/2.56.0_1/bin/git`, has an ad-hoc signature with no team ID,
and loads Homebrew pcre2/gettext dylibs. Its binary directory is user-owned. The
same disposable XPC init/add/commit probe that passed with direct Apple Git fails
to launch this Homebrew binary: Cocoa error 4 reports the existing Git path as
missing. Narrow sandbox-log queries did not identify the exact denial, so this is
evidence that the current helper cannot launch that installation, not proof of a
specific denied syscall or universal Homebrew incompatibility. The probe is
`/tmp/oarlock-review71-homebrew-xpc-probe.mjs`, with its output in the corresponding
`.log`. Supporting Homebrew needs a validated access/provenance/dependency policy;
no broad /opt/homebrew access or PATH fallback was added. Ordinary terminal Git
selection is unaffected by the proposed isolated Source Control executor policy.
This machine already has the direct Apple CLT Git that passed the XPC probe. No
production code changed in this investigation; the full suites were not rerun.

Review 72 records the user's approval to use Apple Git for the isolated executor.
This resolves the Review 70/71 runtime-policy question. `git-worker/apple_git.m`
now resolves only the fixed Apple Command Line Tools/default Xcode Git locations;
it does not consult PATH or DEVELOPER_DIR, launch xcrun, use Homebrew, or download
anything. It validates `anchor apple and identifier "com.apple.git"`, requires
library validation without its disabling entitlement, and rejects symlinks,
non-root ownership, group/other write permission and privilege bits along the
entire path. Extended ACLs are conservatively refused. Directory traversal uses
no-follow handle-relative opens. These restrictions prevent an unprivileged
replacement between signature checking and later use; hostile root or privileged
installer actions are outside that claim. The executable must be reverified when
an operation actually launches; there is no persistent executable-trust cache.

A discovered metadata pitfall is fixed: acl_get_fd returns NULL/ENOENT for files
without an ACL on this machine. That is not safe evidence that a failed read means
no ACL. The verifier uses fstatx_np and filesec_query_property to distinguish
explicit ACL absence from retrieval errors, rejects errors, and rejects nonempty
ACLs. This keeps a signed but user-writable copy from satisfying the boundary.
Some Xcode installations under group-writable /Applications do not meet this
protection requirement; the capability guidance recommends installing/repairing
Apple's Command Line Tools, without changing directory ownership or permissions.

The XPC capability protocol is now version 2 and reports `gitVerified` separately
from `executionReady`. A connected sandboxed helper with no verified Apple Git
is distinct from a connection/protocol/confinement failure. The native response
carries installation guidance (`xcode-select --install`) for that state. No Git
process is launched by capability discovery. Production `executionReady` remains
false: verified provenance alone does not implement coherent candidate capture,
object transfer, execution/cancellation, or the publication coordinator. The
existing live Git runner and ordinary terminal Git selection are unchanged.

Real XPC tests accept this machine's protected Apple Git and reject a copied
Apple-signed binary in a user-writable directory while confirming its signature
is still valid. Tests also reject non-root/group-writable/privileged modes,
symlinks, parent traversal, non-Apple signatures and all earlier helper-auth and
sandbox failure cases. Protocol tests distinguish missing Apple Git from failed
confinement and never enable execution; Rust tests retain that distinction in the
native capability result. The updated helper compiles for arm64 and x86_64.

Review 72 validation: XPC smoke tests, frontend types/lint (81 existing warnings),
5,015 frontend tests (533 files), native Clippy with all targets and warnings denied,
and 1,422 native tests pass (three ignored). Whitespace checks pass. Logs are
`/tmp/oarlock-review72-{xpc-smoke,types,lint,frontend-tests,clippy,rust-tests}.log`;
the universal helper build is `/tmp/oarlock-review72-universal-helper.log`.
These are local ad-hoc XPC tests, not release certificate/notarization validation.
The complete isolated execution/publication pipeline remains a release blocker.
No commit or push was made.

Review 73 rechecks index publication and Git History while the isolated execution
pipeline is still incomplete. A real Apple Git reproduction showed that copying
unchanged entry stat caches into a newer index can hide an unselected worktree
edit: Git's racy-clean check depends on the index file's timestamp. The temporary
reproduction is `/tmp/oarlock-review73-racy-index.py`. `IndexSnapshot` now captures
and revalidates the index mtime as well as content/file identity. `candidate_index`
plans bind that timestamp and invalidate selected entries plus unselected entries
whose cached mtime is at least the baseline index's whole-second timestamp.
Older stat caches remain intact; this does not force every file through a content
rehash. Epoch/overflow cases invalidate conservatively. This follows Git's racy
index contract at https://git-scm.com/docs/racy-git. A real-Git publication test
retains the unselected edit, and unit tests check older caches remain intact.
The planner also refuses null object IDs and stage-zero file/directory conflicts
(including nonadjacent `a`, `a.b`, `a/child` entries).

Git History had not adopted the approved space ownership contract. Its stack now
provides the tab's owning workspace; history and Undo use a bound native client.
Unmount invalidates pending results and prevents a delayed completion from
starting another history request. Refresh invalidates pending file-list results
and pagination ownership. Undo rejects stale navigation before dispatch and
suppresses completion UI after navigation/unmount. Failed remote-containment
lookups no longer enable Undo while silently treating the commit as unshared;
the dialog shows an error and Retry. Native operations already dispatched keep
their original environment. These changes do not add a new ownership policy.

A separate real native test reproduced Undo on the wrong branch: a confirmation
for main stores only the commit SHA, a terminal switches to sibling at that same
SHA, and Undo rewinds sibling while main remains unchanged. The original failing
reproduction is preserved in `/tmp/oarlock-review73-undo-branch-snippet.rs` and
`/tmp/oarlock-review73-undo-branch.log`; it was removed from the normal suite before
adding passing stale-branch regression tests. The user approved rejecting Undo
when HEAD switches, rather than continuing to modify the original branch.
The API now carries the confirmed branch, rejects a mismatching/detached symbolic
HEAD before dispatch, and explicitly names that ref with --no-deref, so a later
checkout cannot redirect the write to another branch.

This is NOT the complete atomic branch/HEAD condition. Tests of Apple Git 2.54
and Homebrew Git 2.56 reject combining `symref-verify HEAD refs/heads/main` and an
update of that branch in one update-ref transaction: Git reports multiple updates
for HEAD, including the implicit update via its referent. `symref-update` with the
same target is also rejected. A separate preflight cannot guarantee rejection of
a checkout that happens during execution. The native isolated ref publisher must
retain and revalidate symbolic HEAD under publication locks, together with the
confirmed branch/commit and repository identity. No live update-ref subprocess
has been declared a safe publication boundary, and no unsupported transaction or
unsafe fallback was added. The live runner's metadata replacement race, atomic
Undo branch-switch protection, and the broader candidate/object/ref/worktree
execution/publication pipeline remain release blockers; executionReady is false.

A final native regression also showed publication restoring stale permissions:
chmod the captured index from 0644 to 0600, then publish, and the old publisher
successfully replaced it with mode 0644. The failing evidence is
`/tmp/oarlock-review73-permissions-before.log`. Index snapshots now retain the
native change stamp and permissions as well, and recheck them before publication.
Metadata is captured within the stable-read checks. The regression now passes;
publication rejects the stale snapshot and keeps the tightened permissions.

Review 73 validation: frontend types and lint pass (80 existing warnings), all
5,022 frontend tests across 536 files pass, native Clippy passes with all targets
and warnings denied, and the final full native suite passes 1,428 tests with three
ignored. All 13 index-publication fault/race tests pass. Logs are
`/tmp/oarlock-review73-{types,lint,frontend-tests,clippy,rust-tests,index-tests,undo-tests}.log`.
Whitespace checks pass. This pass does not newly validate XPC packaging/signing,
Intel runtime or Windows/Linux execution. No commit or push was made. No claim of
release clearance or complete isolated execution/publication is made.

Review 74 checks Git History's native reads and the new index publisher. Real-Git
tests reproduced empty root/merge file lists and zero line counts: diff-tree
without --root/first-parent merge selection omits those commits, and --name-status
suppresses --numstat. Commit file lists now use one --raw --numstat -z process,
explicit rename detection, root inclusion and first-parent merge comparison,
matching the existing per-file preview. The dependency-light commit_files parser
consumes framed raw records before numstat records, preserves tabs/newlines in
paths and rename pairs, and matches statistics in linear time. Truncated output,
invalid UTF-8, missing/duplicate/mismatching records and invalid counts fail
visibly rather than presenting an incomplete or misidentified file list.

Two executable-preview gaps were reproduced with synthetic repository programs.
Whole-commit previews still ran configured text converters; they now explicitly
disable textconv like the file previews. log.showSignature could launch a
configured signature verifier just by opening history or a signed commit preview.
History/show reads now explicitly disable signature verification; this UI does
not display verification results. These changes apply the existing policy against
running executable extensions from previews. Permanent real-Git regressions cover
both programs, root/merge counts, renames, binary files and delimited filenames.
Original failures are /tmp/oarlock-review74-{history,converter,verifier}-before.log.

A separate native reproduction confirms index publication loses an explicit
macOS ACL even though ordinary mode bits are preserved. The successful replacement
has no ACL; the evidence is /tmp/oarlock-review74-acl-before.log and the temporary
test source is /tmp/oarlock-review74-acl-snippet.rs. The intentionally failing
probe was removed from the normal suite. Editor conditional saves use the same
mode-only replacement pattern; this pass did not separately reproduce their ACL
behavior. The user was asked whether to preserve ACLs with safe failure when
unsupported or refuse custom-ACL files for v1. That architecture decision is
pending, and no ACL contract change has been implemented.

Review 74 validation: frontend types/lint pass (80 existing warnings), all 5,022
frontend tests across 536 files pass, native Clippy passes with all targets and
warnings denied, and cargo test --locked passes 1,435 tests with three ignored.
nextest is not installed, so the documented cargo test fallback was used.
Formatting and whitespace checks pass. Logs are
/tmp/oarlock-review74-{types,lint,frontend-tests,clippy,rust-tests}.log.
The complete isolated execution/publication pipeline and atomic Undo HEAD/ref
condition remain release blockers; production executionReady remains false.
No new release-signing, Intel, Windows or Linux runtime validation was performed.
No commit or push was made, and this pass does not establish release readiness.

Review 75 implements the user's decision to preserve ACLs and fail safely where
preservation is unsupported. `fs/access_control` captures access rules through
open file handles, together with owner, group, mode and a stable change stamp.
Document conditional saves, general atomic file writes and isolated index
publication use this shared boundary. Candidate metadata is read back and checked
before publication; failures leave the original unchanged. Source ACL changes
invalidate the operation instead of restoring stale access rules. General file
writes now also recheck file identity/change stamp before replacing their target.
No new dependency, background worker or IPC request was added.

On macOS, fstatx_np/filesec_query_property distinguish explicit ACL absence from
retrieval failure; acl_get_fd's ambiguous ENOENT is not treated as absence. Native
ACL serialization retains entry order, qualifiers, permissions and inheritance
flags. Read/set/verification errors are returned. Owner/group preservation can
also fail safely when the process lacks authority to retain them. On Linux the
POSIX access ACL is copied through descriptor xattrs on ext-family, XFS, Btrfs and
tmpfs filesystems; other filesystem types and unavailable ACL APIs are refused.
Linux-specific round-trip/unsupported tests are present but were not run here.

Windows ACL preservation is NOT implemented. The fallback explicitly refuses
staged content writes, including new files, before writing their contents. It
does not silently retain the former mode-only behavior. Other unsupported
platforms/filesystems behave the same way. This is a material release limitation;
Windows support and platform CI still need completion, not a claim of cross-
platform readiness. Direct empty-file/directory creation is a different path.

Review of the fix found two staging hazards. Inherited ACL grants can expose a
temporary file despite mode 0600, so staging captures inherited rules and removes
them before writing content, verifying private mode/ACL first. Publication uses
the original file's rules for replacements or restores captured inherited rules
for new files. A synthetic macOS test also confirmed deny-delete ACLs prevent
temporary-file removal. Such rules are refused before installation on candidates,
so failures do not strand draft contents behind an undeletable staging ACL.
ACLs are never stripped from the original to make an operation succeed.

Seven macOS regressions cover editor/general/index ACL retention, source ACL
races, read/apply failures, inherited rules, private staging and unsupported-rule
cleanup. Final validation: frontend types/lint pass (80 existing warnings), all
5,022 frontend tests pass across 536 files, all-target native Clippy passes with
warnings denied, and cargo test --locked passes 1,442 tests with three ignored.
Formatting/whitespace checks pass. Logs are
/tmp/oarlock-review75-{acl-tests,types,lint,frontend-tests,clippy,rust-tests}.log.
These are macOS arm64 results; Linux/Windows runtime and Intel runtime were not
validated. The isolated Git execution/publication and atomic Undo HEAD/ref
blockers remain unresolved. No commit or push was made.

Review 76 found and reproduced two more staging ownership bugs. Replacing a save
candidate's directory entry let publication install the replacement, and cleanup
deleted the unowned entry. A read-denying ACL also stranded Git index locks
because cleanup tried to open their contents to identify them. The shared native
`fs/file_identity` check compares directory entries with retained handles without
requiring content reads, following symlinks or opening FIFOs. Publication rejects
observed substitutions; cleanup removes only matching entries. The retained Unix
descriptor prevents inode reuse. This remains a final identity check, not a
filesystem compare-and-swap against hostile same-user writers.

A real descriptor test confirmed that revoking permissions does not revoke an
already-open reader: bytes written afterward remain readable through that handle.
The user approved private, handle-owned staging directories. Content files are
now created only after their enclosing directory has had inherited ACL grants
removed and private mode verified. A real-Git test then showed `git add --all`
capturing an ignored .env draft under the temporary content filename inside the
worktree. The user approved moving staging outside worktrees on the same filesystem
and refusing operations where no suitable location is available.

On macOS `fs/private_staging` asks Foundation for an item replacement directory
on the destination volume, opens and verifies the resulting directory, and refuses
ancestor .git markers (including linked-worktree files). macOS does not permit
opening its shared TemporaryItems parent, so cleanup rechecks the directory's
identity through its returned path; a separate same-user process can race that
final check. Linux opens an `O_TMPFILE` in the target directory and holds a file
lock until publication. Existing files are linked through a private Git common
directory on the same filesystem, a hidden sibling outside repositories, or a
private same-filesystem cache fallback. Before each save, only matching regular
staging entries older than one minute whose locks are available are removed; no
journal or startup sweep is used. A file in a repository with no safe staging
location is refused. Other platforms retain their existing safe-refusal policy.
The operation-owned directory is private before content is linked into it. No editor placeholder or content file
is created in the worktree. New-file inheritance is reproduced with an empty
kernel-created probe below the private directory, using the destination parent's
ACL inheritance and group rules. Probes are cleared and removed without exposing
content. Linux explicitly removes an inherited temp-directory default ACL when
the real destination has none. Existing-file replacements retain their captured
access rules as before. Unsuitable temporary locations, cross-filesystem staging,
unsupported ACLs/platforms and verification failures remain explicit errors;
there is no fallback to staging plaintext inside the workspace. On platforms using
the OS temporary directory, saves can fail if it is on another volume.

Git's public index.lock reservation remains empty while the private candidate is
written and verified. A prepared candidate replaces that reservation before the
durable prepared-lock phase; early reservation readers keep the empty inode.
Crash/recovery tests still retain the old index and prepared lock before the final
index rename. Private candidates are removed on ordinary success/failure; a process
crash may leave private recovery artifacts, never automatically replayed or deleted
without ownership evidence. No worker, timer, dependency or IPC request was added;
directory/file handles and metadata probes exist only during an active write.

The AI path checker also admitted internal staging names. Shared component-prefix
rules now deny .oarlock-stage-* and legacy .oarlock-save-* paths for AI reads and
writes, native imports and document-context validation. This applies the existing
no-bypass rule to draft copies, with matching Rust/TypeScript regressions.
Original evidence is /tmp/oarlock-review76-{stage-before,stage-publication-before,
lock-before,open-reader,git-staging-exposure,private-ai-before}.log; the descriptor
reproduction is /tmp/oarlock-review76-open-reader.py.

Review 76 validation: 5,023 frontend tests in 536 files, frontend types/lint (80
existing warnings), all-target native Clippy with warnings denied, and 1,452
native tests pass (three ignored). Formatting and whitespace checks pass. Logs
are /tmp/oarlock-review76-{types,lint,frontend-tests,clippy,rust-tests}.log. A narrow
filesystem run under the sandbox could not start FSEvents or bind its socket;
the final complete native run with the required access passed. Linux-specific
inheritance and Windows/Intel runtime behavior were not validated on this Mac.
Windows staged writes remain unsupported. The full isolated Git execution and
object/ref/worktree publication pipeline, plus atomic Undo HEAD/ref protection,
remain release blockers; executionReady is still false. No commit or push was made.

Review 77 reproduced a new-file save failure when the destination directory allows
creation but denies child deletion. The private inheritance probe copied that
restriction, then tried to delete its empty child before clearing the directory's
ACL. Cleanup now clears the probe directory first, while its enclosing private
directory continues to protect it. A macOS regression verifies that creation
succeeds, the requested bytes are published and the probe directory is removed.
Evidence: /tmp/oarlock-review77-probe-{before,after}.log.

AI staged-diff capture still used the unowned Git runner. A real-Git regression
redirected an authorized repository's .git symlink to an unauthorized repository
and received its synthetic staged content for AI. Capture now retains the shared
repository owner and uses its runner for every command; this rejects the symlink
and checks ownership between snapshot commands. The seven AI-diff integration
tests pass. This does not solve the live runner's during-execution ownership race,
and WSL capture now fails safely without Linux-side directory ownership. Evidence:
/tmp/oarlock-review77-ai-owner-{before,after}.log.

Two additional findings await user architecture decisions. Atomic replacements
remove macOS quarantine and Finder-tag xattrs despite preserving ACLs; carrying
extended metadata forward needs an explicit preservation/failure policy. Also,
a regular .git pointer file into another unauthorized repository still passes the
existing owner check. The pending proposal requires authorization for external
metadata except reciprocally validated linked worktrees. Neither policy has been
implemented or assumed approved. Synthetic failing probes were retained outside
the passing suite at /tmp/oarlock-review77-{metadata,gitfile}-probe.rs, with evidence
in /tmp/oarlock-review77-{metadata,gitfile}-before.log. They are unresolved findings,
not covered fixes.

Review 77 validation: all 5,023 frontend tests in 536 files and 1,454 native tests
pass (three native tests ignored). Types, lint (80 existing warnings), all-target
Clippy with warnings denied, formatting and whitespace checks pass. Logs:
/tmp/oarlock-review77-{types,lint,frontend-tests,clippy,rust-tests}.log. Results are
macOS arm64 only. Windows staged writes, the complete isolated Git execution and
publication pipeline, and atomic Undo HEAD/ref protection remain unresolved
release limitations. No commit or push was made.

Review 78 implements both Review 77 policy decisions. The user approved preserving
supported extended metadata with safe refusal, and separately authorizing external
Git metadata except reciprocally verified linked worktrees.

The shared replacement metadata snapshot now includes descriptor-read xattrs, so
conditional editor saves, general atomic file writes and index publication use the
same capture/apply/read-back checks. macOS supports quarantine, provenance, Finder
metadata/tags, FinderInfo, ResourceFork and user.* attributes, plus UF_HIDDEN and
UF_NODUMP flags. Other flags and attributes are refused, including content-dependent
compression/signature state, rather than copied onto changed content or silently
dropped. Linux supports user.* xattrs while the existing ACL adapter owns POSIX
access ACLs; other enumerated xattrs are refused. Windows remains unsupported.
This is an explicit supported-attribute policy, not a claim to preserve every
platform's metadata, timestamps or filesystem-specific inode behavior.

Attribute reads are bounded to 64 KiB of names, 1 MiB per value and 8 MiB total per
snapshot. Growth, failed reads, unsupported state and failed read-back verification
abort publication. Source metadata participates in the existing final metadata and
change-stamp checks. No new dependency, worker or IPC call was added. Regressions
exercise real quarantine/tag saves, exact binary and empty values, removal of stale
candidate attributes, source changes, bounded/failed reads, supported macOS flags,
and refusal leaving original content, identity and unsupported metadata intact.

Repository ownership checks now authorize canonical Git and common directories
before Git discovery. External metadata requires authorization unless the Git
directory is exactly common/worktrees/<id> and its gitdir backlink resolves to
this worktree's own .git marker. Owned operations revalidate that backlink. Regular
gitfiles cannot grant arbitrary external access. Read-only root operations and
containing-repository discovery also check metadata trust. Real-Git tests cover
unauthorized pointer rejection, explicit authorization success, and stale or wrong
linked-worktree backlinks. Existing valid linked-worktree tests continue to pass.

Review of that fix found discovery automatically authorizing an unrelated worktree
named by core.worktree. The reproduction is
/tmp/oarlock-review78-discovery-before.log. Discovery now requires the reported root
to be the actual containing repository, without skipping a nearer .git marker,
before authorizing it. Ordinary discovery from an authorized project subdirectory
retains its prior ancestor-repository behavior. Both panel and repository discovery
reject unrelated redirects without granting access; tests cover that and normal
subdirectory compatibility. These checks do not replace the pending isolated Git
execution boundary or eliminate hostile changes during an external Git process.

Review 78 validation: all 5,023 frontend tests in 536 files and 1,463 native tests
pass (three native tests ignored). Types, lint (80 existing warnings), all-target
Clippy with warnings denied, formatting and whitespace checks pass. Logs are
/tmp/oarlock-review78-{types,lint,frontend-tests,clippy,rust-tests}.log. These are
macOS arm64 results; Linux/Windows runtime validation remains outstanding. Windows
staged writes, the complete isolated Git execution/publication pipeline and atomic
Undo HEAD/ref protection remain release limitations. No commit or push was made.

Review 79 responds to the user's concern about repeated review loops. Recent
passes concentrated on filesystem/Git redesign and its regressions; that is not
broad PR coverage. docs/pr-1-review-coverage.md now separates fresh subsystem
review from regression checks and records remaining release blockers and scope.
This pass bounded its metadata/authorization follow-up and moved into LSP. The
metadata and Git fixes were not expanded; their existing regressions still pass.

A real-process LSP test confirmed Stop deadlocking behind a blocked stdin writer:
kill acquired the writer's mutex before signalling the process, and lsp_kill is a
synchronous UI-thread command. Termination now marks stopping once, signals first,
and only tries the stdin lock. An active writer closes the pipe when it returns;
new and queued writes reject a stopping session. Windows explicitly terminates an
existing Job Object while references remain, rather than relying on final Drop.
Its platform test is present but was not run on this macOS host. This does not add
new supervision, guarantee detached-descendant cleanup, or solve every LSP lifetime
issue. Evidence: /tmp/oarlock-review79-lsp-stop-{before,after}.log.

A frontend reproduction started five servers under the four-session preset cap:
admission counted completed sessions but ignored starts in flight. It now counts
the union of active and creating keys, while allowing callers to share an existing
reservation for the same root. Tests hold four starts open, check refusal of the
fifth before startup completes, and verify same-root sharing. This is frontend
admission, not a process-wide hard quota across windows or shutting-down servers.
Evidence: /tmp/oarlock-review79-lsp-cap-{before,after}.log.

Transport regressions reproduced malformed workspace/configuration items throwing
from the channel callback and delivery of buffered/late notifications after close.
Malformed items now receive an invalid-params reply. Closing clears buffered input
and its listener; closed transports discard messages and late send-error callbacks.
Evidence: /tmp/oarlock-review79-lsp-transport-before.log and
/tmp/oarlock-review79-lsp-frontend-after.log. These changes add no dependency,
background worker, timer or IPC round trip to normal LSP traffic.

Review 79 validation: all 5,026 frontend tests in 537 files and 1,464 native tests
pass (three native tests ignored). Types, lint (80 existing warnings), all-target
Clippy with warnings denied, formatting and whitespace checks pass. Logs:
/tmp/oarlock-review79-{types,lint,frontend-tests,clippy,rust-tests}.log. These are
macOS arm64 results. The isolated Git execution/publication, atomic Undo, Windows
staged-write and platform-validation release limitations remain. No commit or push
was made. Next fresh scope is startup/updater/release configuration; unresolved
LSP lifecycle paths remain explicitly unverified in the coverage record.


Review 80 moved into startup, updater and release packaging. This is fresh scope,
separate from Git/fs regression work; docs/pr-1-review-coverage.md records both
coverage and unresolved release blockers. The updater is deliberately disabled
(UPDATES_ENABLED=false, no endpoint/pubkey/artifacts/capability). It stays disabled;
its dormant installation path was not certified.

Two CLI packaging regressions reproduced with the real build script and controlled
Cargo/rustc fixtures: Tauri's cross-compilation target was ignored, and a configured
Cargo target directory was missed (or a stale default artifact reused). The script
now prioritizes TAURI_ENV_TARGET_TRIPLE and reads Cargo metadata.target_directory.
Tests cover cross-target precedence, a fresh custom output beside a stale default,
and standalone development .exe naming. A real local development CLI build passed.
Evidence: /tmp/oarlock-review80-cli-{before,after,real}.log.

The documented local macOS release build failed without an Apple signing identity.
The user approved local ad-hoc helpers that refuse execution, with strict signing
for distribution. scripts/git-worker/build.mjs now separates that policy with
OARLOCK_DISTRIBUTION_BUILD=1, set in release CI regardless of debug/release mode.
Distribution requires APPLE_SIGNING_IDENTITY and APPLE_TEAM_ID; final app/helper
signature verification remains required. Ad-hoc helpers retain the false peer
requirement; the isolated smoke-fixture exception remains restricted to its test
identifier. A real local helper compiled and verified its signature and exact
sandbox entitlement without a Developer identity. This did not run a signed
release or make the production executor operational. Evidence:
/tmp/oarlock-review80-local-{bundle-before,helper-after}.log and
/tmp/oarlock-review80-packaging-after.log.

A real filesystem test denied a destination rename and showed startup adoption
then deleting the saved source window anyway. The user approved recoverable
migration with startup stopped on failure. windows/restore.rs now prepares a
private durable journal covering spaces, scrollback, shared active-chat metadata
and the registry. It retains displaced destinations, verifies content fingerprints,
publishes the registry last, commits durably and atomically retires the journal
before deleting backups. Interruption resumes on relaunch; malformed or changed
state stops with a recovery error instead of falling back to an empty store.
Renames retain spaces/scrollback metadata; JSON candidates preserve existing ACLs
and supported metadata. Source window directories are not recursively deleted.
Absent active-chat state clears stale main selection. A failed extra-window build
now stops restoration; teardown before successful startup cannot discard windows.
Control IPC starts after restoration. Setup errors are logged and propagated,
including the recovery path and retry guidance; no recovery wizard was added.

Migration tests interrupt each of eight backup/publication moves and the commit
marker, reproduce the original ACL denial, preserve unexpected replacements,
reject corrupt registry/chat/manifest and source symlinks, resume a partial commit
marker, avoid replay after commit and keep ordinary startup read-only. The journal
contains no arbitrary destination paths. Fingerprints stream history with a 64 KiB
read buffer during adoption/recovery only; there is no recurring worker or IPC.
Windows adoption fails without changing source state because private staging and
metadata preservation remain unsupported there. Linux runtime validation remains
outstanding. Evidence: /tmp/oarlock-review80-adoption-before.log and
/tmp/oarlock-review80-restore-after.log.

Review 80 validation: 5,035 frontend tests in 539 files and 1,475 native tests pass
(three native tests ignored). Types, lint (80 existing warnings), all-target Clippy
with warnings denied, formatting and whitespace checks pass. Logs:
/tmp/oarlock-review80-{types,lint,frontend-tests,clippy,rust-tests}.log. These are
macOS arm64 results; script checks do not certify Windows execution or a complete
release bundle. Complete isolated Git execution/publication, atomic Undo HEAD/ref
protection, Windows staged writes and platform validation remain release blockers.
No commit or push was made. Next fresh scope is native HTTP/network boundaries.


Review 81 performed the planned native network-boundary pass after a bounded
startup/packaging regression check. The 27 window lifecycle/recovery tests and nine
packaging tests still pass. The new scope traced native request admission/body
handling, address classification, cached clients, redirect behavior, flow control,
image downloads, MCP/OAuth origin checks and the frontend fetch bridge/callers.
This is not exhaustive certification of every adjacent lifetime or network path.

A real two-server HTTP fixture reproduced a 307 forwarding a synthetic AI prompt
and x-api-key to another origin. The native redirect policy allowed new hosts with
private access and did not bind scheme/port even otherwise. The user approved
strict same-origin redirects. The policy now compares each hop to the original
request's scheme, host and port and returns an explicit error on refusal. The
error asks the user to configure the final endpoint URL. Same-origin redirects
retain the pinned resolver, headers and body. HTTP-to-HTTPS also changes origin
and requires an explicit URL change. Tests cover all five followed redirect codes,
same-origin POST success, scheme/port/host changes, userinfo, literal IPv6, metadata
addresses and the existing hop limit. No real credentials or external servers were
used. Evidence: /tmp/oarlock-review81-network-{before,after}.log.

A separate subprocess with an inherited HTTP proxy demonstrated routing around
the destination's resolver pin: the proxy returned a different response from the
pinned local fixture. The user approved direct connections until explicit trusted
proxy support is designed. The shared native client builder now calls no_proxy
for Stream, Ping, Fetch and Mcp, covering native AI, local-model probes, OAuth,
MCP and Markdown images. Regression tests exercise all four profiles with inherited
HTTP_PROXY/http_proxy in a subprocess, leaving the test runner's environment alone.
Windows system proxy support remains available to other dependencies such as the
updater, but these guarded clients disable it explicitly. Windows OS-proxy behavior
was not run on this Mac. README describes the loss of proxy-only connectivity for
these routes. Built-in browser-provider requests retain webview networking policy.
No dependency, background worker, timer, IPC call or cache-key dimension was added.

Review 81 validation: all 5,035 frontend tests in 539 files and 1,480 native tests
pass (three native tests ignored). The focused native network suite has 64 tests.
Types, lint (80 existing warnings), all-target Clippy with warnings denied,
formatting and whitespace checks pass. Logs:
/tmp/oarlock-review81-{types,lint,frontend-tests,clippy,rust-tests}.log. These are
macOS arm64 results. Existing isolated Git execution/publication, atomic Undo,
Windows staging/restoration and platform-validation release limitations remain.
No commit or push was made. Next fresh scope is network consumers, including
model-list response bounds and preview-image request/cache lifetime. Native request
admission across page replacement, DNS cancellation and full fetch-contract parity
remain follow-up targets rather than certified behavior.


Review 82 moved into model-list consumers and preview-image lifetimes after
checking the prior redirect/proxy changes. The 64 native network regressions and
packaging checks still pass. A real rendering regression showed uppercase HTTPS
URLs rejected by MarkdownImage's case-sensitive startsWith despite its earlier
case-insensitive remote-URL classification. Both secure-image checks now share a
case-insensitive decision; the rendering regression passes. No ownership or
resource policy changed in this fix.

The user approved and this pass implemented model-discovery limits: 4 MiB of
streamed response bytes, 2,000 catalog entries, 1,024 UTF-16 code units per ID and
a 30-second total deadline. Oversized responses/catalogs fail explicitly rather
than truncate. A composed abort signal covers headers and body consumption;
caller cancellation and the deadline cancel the reader and native transport.
Late responses from a non-cooperative fetch are discarded and their bodies
cancelled. Tests cover misleading Content-Length, error bodies, split UTF-8,
exact boundaries, stalled headers/body and cleanup of timers/listeners.

The approved image ownership change uses exact-load, idempotent leases. Hidden
and closed preview panes release them; the last pending consumer cancels its
native request. Native registration is synchronous, results use a binary channel,
and frontend cancellation is repeated after registration acknowledges if needed.
Window destruction and page reload cancel that window's registered image loads.
A cancelled late result cannot create an object URL or affect a newer retry.
Completed unused images have both the existing 32-entry cap and the approved
32 MiB encoded-blob budget, evicting oldest unused entries. Active images are
never evicted by this budget. This is not a decoded image/GPU memory limit or a
new active-request concurrency limit. No dependency or recurring worker was added.

Regressions cover shared consumers, repeated releases, stale failure cleanup,
hide/show and document switches, late native results, failed registration,
window isolation and a real local HTTP stalled body whose socket closes on
cancellation. HTTPS-only image validation remains intact; HTTP is used solely
for the local transport fixture. The original four failing reproductions now
pass. Evidence before the fixes remains in
/tmp/oarlock-review82-{consumers-before,image-budget-before}.log; focused results
are in /tmp/oarlock-review82-{consumers-integration,native-images-after}.log.

Review 82 Validation: all 5,054 frontend tests in 541 files and 1,483 native tests pass
(three native tests ignored). Types, lint (80 existing warnings), all-target Clippy
with warnings denied, production build, startup dependency graph, formatting and
whitespace checks pass. Total client JS is 2,828,615 compressed bytes, 2,176 bytes
above the last recorded measurement; the measured allowance is 2,828,620 bytes.
Startup and terminal bundles remain within their existing budgets. The size check
passes with that explicit allowance adjustment. Logs:
/tmp/oarlock-review82-{types,lint,frontend-tests,clippy,rust-tests,build,dist,size}.log.
These are macOS arm64 results, not Windows/Linux runtime or release-bundle
certification. No commit or push. Existing release blockers remain open.
This consumer pass does not certify native request admission across page
replacement, DNS resolver shutdown or full fetch-contract parity. Those are the
next fresh review targets; completed consumer fixes need new evidence to reopen.


Review 83 followed native fetch cancellation and request handling after bounded
model-discovery/image regression checks. A controlled-clock test reproduced a
stalled consumer's 120-second timeout restarting whenever another tiny network
chunk arrived. The pump now retains one pinned credit-wait future across network
arrivals, renewing it only after a credit notification. This enforces the existing
policy with no new heap allocation, recurring worker or dependency.

Three frontend regressions reproduced caller cancellation reasons being replaced
with a generic AbortError before native admission, during request-body buffering
and while waiting for response headers/body. The bridge now preserves the signal's
reason, including TimeoutError and custom reasons, and supplies it to the upload
reader's cancellation. Normal default AbortError behavior remains unchanged.

A controlled native scheduling regression reproduced a dispatched async request
registering after cancel_window had already run. Cleanup previously cancelled only
work already in the registry; synchronous image registration also lacked a page
generation. Evidence before the fixes remains in
/tmp/oarlock-review83-{timeout-before,reasons-before,admission-before}.log.

After approval, AI, MCP and preview-image requests now require a native-issued
page generation. Native retirement and request admission share one lock; retirement
invalidates the token before cancelling the registered requests. Cancel and credit
commands also require that same generation, so delayed old-page cleanup cannot
act on replacement requests. The original queued-admission reproduction now passes.

Native delivers the token into the loaded document at PageLoadEvent::Finished,
instead of exposing a token-query command that could itself be delayed across a
reload. The frontend waits abortably, fails visibly after 30 seconds if delivery
never arrives, and cancels an unowned upload body if initialization fails. No new
request starts after its caller cancels while waiting. Existing request limits,
image leases, idle cache limits and SSRF checks remain in force.

Regressions cover queued stale admission, wrong-window tokens, retirement racing
registration, cancellation before the first I/O poll, stale cancel/credit commands,
missing initialization and late delivery. An isolated real Tauri webview probe
uses the production lifecycle handler and frontend initialization module; it
verifies delivery, reload rotation and refusal of the old generation without
opening app stores or credentials. Reproduce it with the commands at the top of
src-tauri/examples/network_page_probe.rs. It is a bootstrap/reload smoke test, not
a complete end-to-end test of every HTTP route or platform.

Validation: all 5,064 frontend tests in 543 files and 1,489 native tests pass
(three native tests ignored). Types, lint (80 existing warnings), all-target Clippy
with warnings denied, production build, startup graph, size, formatting and whitespace
checks pass. Total client JS is 2,829,152 compressed bytes, 537 bytes above pass 82;
the measured allowance is 2,829,160 bytes and the size check passes. Startup and
terminal bundles stay within their existing budgets. No dependency or per-request
token-query IPC was added. Initialization timers/listeners exist only while a
request is waiting for native delivery. Logs:
/tmp/oarlock-review83-{types,lint,frontend-tests,clippy,rust-tests,build,dist,size}.log.
The real macOS webview bootstrap/reload probe also passes:
/tmp/oarlock-review83-webview-probe.log. These are macOS arm64 results; Windows,
Linux and macOS Intel runtime validation remain outstanding.
No commit or push. Blocking OS DNS worker shutdown, remaining fetch-contract parity
and existing Git/platform release blockers remain outside this pass's certification.


Review 84 followed DNS cancellation and request handling after a bounded
page-generation regression pass. A controlled held-resolver test reproduced 17
blocking lookup workers surviving after their HTTP requests were cancelled, even
though only 16 HTTP request slots exist. The user approved preserving system DNS
with 8 active lookups, 32 queued callers and a 10-second DNS caller deadline.

net/dns.rs now owns that shared gate, initialized on the first hostname lookup.
An OS lookup keeps its active permit until it returns, even after cancellation or
timeout. Queued futures release their waiting slot when dropped, and a dropped
blocking-task handle aborts jobs which Tokio has not started. Deadline checks cover
queueing and prevent a newly available permit from starting an already-expired
lookup. IP literals still bypass resolution. AI, images, MCP, OAuth and local
probes share this boundary through the existing classification helpers. System
resolver behavior, address classification and pinning remain unchanged. There is
no new dependency, DNS cache or dedicated worker pool. Running OS lookups cannot
be forcibly stopped; if all eight stick, further queued calls time out or fail
busy instead of creating unbounded resolver work.

An upload regression reproduced aborting immediately after page-generation delivery
leaving the source stream open. The request now checks cancellation inside the same
cleanup boundary as initialization; already-aborted uploads also cancel their body
before any IPC. Native response serialization separately discarded all but the last
value of repeated headers. Header pairs now preserve authentication challenges and
separate Set-Cookie fields through Response construction; MCP still overrides its
native sign-in marker. These enforce existing cancellation and HTTP contracts.

DNS tests inject held lookup closures without changing system DNS or contacting an
external server. They cover capacity, overflow, cancellation, deadline races,
queued blocking tasks, resolver error/panic and recovery. Before-fix evidence:
/tmp/oarlock-review84-{dns-before,upload-before,headers-before}.log. Focused results:
/tmp/oarlock-review84-{page-regressions,request-after,headers-after,network-after}.log.
Validation: all 5,067 frontend tests in 543 files and 1,495 native tests pass
(three native tests ignored). The focused native network suite has 79 passing
tests. Types, lint (80 existing warnings), all-target Clippy with warnings denied,
production build, startup graph, unchanged size budgets, formatting and whitespace
checks pass. Logs: /tmp/oarlock-review84-{types,lint,frontend-tests,clippy,
rust-tests,build,dist,size}.log. These are macOS arm64 results only; Windows,
Linux and macOS Intel runtime validation remain outstanding.
No commit or push. Existing Git publication, Undo, Windows staged writes/restoration
and platform release blockers remain open; this is not full fetch-contract
certification. Remaining request/response contract behavior and non-streaming
request deadlines are the next fresh review targets.


Review 85 continued into response handling and non-streaming request deadlines.
A real local HTTP fixture reproduced OAuth redirect hops restarting the timeout:
four 100 ms responses succeeded against a scaled 300 ms budget. Images likewise
used a fresh client timeout per hop, and probes excluded DNS. The user approved
total deadlines of 5 seconds for probes, 20 seconds for preview images and
30 seconds per OAuth HTTP operation. net/deadline.rs now encloses each complete
operation, including DNS queueing/resolution, redirects and response reads;
probes finish at headers. Expiry drops owned work, but running OS DNS work keeps
its existing bounded permit until it exits. The separate five-minute interactive
sign-in allowance and AI/MCP streaming lifetimes remain unchanged. Tests cover
combined phases, already-expired work, dropped ownership, real redirect delays
and a stalled response body whose socket closes at the deadline.

Settings endpoint Test results now belong to the exact URL draft and latest
invocation. Reproductions cover editing the URL, changing away and back, reversed
completion order and unmount. This fixes displayed-result ownership without adding
native probe cancellation or admission policies. Native AI/MCP response metadata
also carries the canonical HTTP status reason; an empty-body error now gives SDK
consumers its description instead of an empty statusText. Custom server reason
text and full browser Fetch parity are not claimed.

Validation: all 5,072 frontend tests in 544 files and 1,500 native tests pass
(three native tests ignored). Types, lint (80 existing warnings), all-target Clippy
with warnings denied, production build, startup graph, size, formatting and whitespace
checks pass. Client JS measures 2,829,276 compressed bytes, 124 bytes over pass 84;
the measured budget is 2,829,280 bytes. Startup and terminal budgets are unchanged.
No dependency or persistent task was added. These are macOS arm64 results only.
Logs: /tmp/oarlock-review85-{frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
Reproductions: /tmp/oarlock-review85-{deadline-before,ping-before,response-before}.log.
Focused checks: /tmp/oarlock-review85-{deadline-after,deadline-core,response-after}.log.
No commit or push. Existing Git publication, Undo, Windows staged-write/restoration
and platform release blockers remain open. Probe lifetime/admission and remaining
HTTP consumer behavior are follow-up review coverage.


Review 86 continued into probe lifetimes and request admission. A real loopback
HTTP reproduction opened 17 simultaneous endpoint probes because lm_ping bypassed
request ownership/capacity; a hook regression showed card unmount sent no native
cancellation. The user approved page-generation ownership, cancellation on URL
change/retest/card close/reload and a separate eight-probe app-wide limit.

net/probe.rs now registers probes under the existing page-generation lock before
DNS/HTTP work, rejects excess starts with a busy error and retires them through
page cleanup. The endpointProbe frontend helper uses an exact request ID and
separate registration acknowledgment; cancellation that overtakes admission is
repeated after acknowledgment. Endpoint cards abort previous work on URL change,
retest and unmount. Collapsing a custom endpoint card also cancels its probe,
because collapse leaves the component mounted. Existing total five-second probe
deadlines and bounded system DNS remain in force. DNS already running in the OS
still retains its permit until it exits. No dependency, persistent timer or queue
was added; probe capacity is separate from chat.

AI/MCP upload bodies previously copied before page/capacity admission. The shared
admit_request_body helper now reserves ownership before body decoding/copying and
a bad body releases the guard. Tests cover stale pages, full capacity and failed
body decoding. This bounds native handoff copies, not Tauri's incoming IPC buffers
or frontend upload preparation. Native probe tests verify cross-window limits,
retired admission, cancellation before first I/O, socket closure and slot recovery.
Frontend tests cover delayed acknowledgment, cancellation during initialization,
late completion, retests, URL changes, collapse and unmount.

Validation: all 5,078 frontend tests in 545 files and 1,503 native tests pass
(three native tests ignored). Types, lint (80 existing warnings), all-target Clippy
with warnings denied, production build, startup graph, size, formatting and whitespace
checks pass. Client JS measures 2,829,636 compressed bytes, 360 bytes over pass 85;
the measured allowance is 2,829,640 bytes. Startup/terminal budgets are unchanged.
These are macOS arm64 results only. Logs:
/tmp/oarlock-review86-{frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
Before-fix evidence: /tmp/oarlock-review86-{probe-ui-before,probe-native-before}.log.
Focused checks: /tmp/oarlock-review86-{probe-ui-after,probe-native-after,probe-final,upload-after}.log.
No commit or push. Existing Git publication, Undo, Windows staged writes/restoration
and platform blockers remain open. Automatic MCP OAuth metadata-probe ownership
and admission are separate follow-up coverage; endpoint probes do not certify them.


Review 87 moved into automatic MCP metadata discovery. A Settings regression
started all 17 configured discoveries simultaneously and sent no cancellation on
unmount. Native discovery had no page ownership. The user approved page ownership,
cancellation on close/reload, server disable/edit and sign-in/sign-out, a separate
eight-discovery app-wide cap, a bounded Settings queue and explicit Retry.

mcp/oauth/probe.rs owns the bounded native registry. Admission uses NetworkPages;
cancellation and publication share the registry lock. Page retirement and config
commits cancel affected work; queued stale pages cannot register. Discovery checks
the saved global URL/revision/enabled state and project trust/entry identity, then
revalidates before publication. Frontend metadataProbe uses exact request identities
and repeats cancellation after delayed admission acknowledgment. DiscoveryQueue
tracks at most 256 current candidates (the native status query's existing limit),
starts eight at once, and counts cancelled running work until it settles. URL/config
changes, disabled/removed servers, Settings teardown and auth actions cancel obsolete
work. Failures stay visible with Retry rather than restarting on every auth event.
Errors are scoped to their configuration and removed when obsolete. Effect teardown
and restart are covered. No dependency or recurring timer was added.

A real local HTTP fixture also reproduced 503 being accepted as absent metadata.
Metadata fetches now reject HTTP 5xx/429; automatic discovery propagates request and
parse errors instead of marking them probed successfully. Tests retain 404 absence
behavior. Interactive sign-in, refresh and the five-minute browser allowance remain
separate. External project-file changes are revalidated at publication; immediate
cancellation of every external mutation during network I/O is not claimed.

Validation: all 5,092 frontend tests in 547 files and 1,507 native tests pass
(three native tests ignored). Types, lint (80 existing warnings), all-target Clippy
with warnings denied, production build, startup graph, size, formatting and whitespace
checks pass. Client JS is 2,830,882 compressed bytes, 1,246 bytes over pass 86;
the measured allowance is 2,830,890 bytes. Startup/terminal budgets are unchanged.
These are macOS arm64 results only. Logs:
/tmp/oarlock-review87-{frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
Before-fix evidence: /tmp/oarlock-review87-{probes-before,metadata-before}.log.
Focused checks: /tmp/oarlock-review87-{probes-after,native-after,metadata-after}.log.
No commit or push. Existing Git publication, Undo, Windows staged writes/restoration
and platform blockers remain open. OAuth token-read failures/recovery and remaining
metadata parsing are the next fresh coverage targets.


Review 88 paused AI changes at the user's request. A bounded stability check of
recent HTTP/probe/MCP Settings work passed 59 tests; the full suite also covers
those changes. Unreviewed OAuth token-read/recovery and metadata parsing remain
explicitly deferred. A possible replacement backend is not evidence of a fix.

Fresh non-AI review reproduced LSP attachment after Disable during startup.
The user approved window/page and configuration-generation ownership. Native
lsp/ownership.rs reserves pending starts, rejects retired generations and binds
send/kill to the owning page. Reload/close invalidate reservations and detach that
window's registered sessions for asynchronous process termination. Spawn checks
its reservation before process creation and publishes only into the still-live
page/reservation; a late child is killed. Existing process-group supervision is
unchanged, with no new guarantee for deliberately detached descendants or OS
binary/environment lookup cancellation. Native page ownership reuses the existing
NetworkPages delivery so queued old-page commands cannot fetch a replacement token.

Frontend Disable, Restart, custom-server edits and shell changes invalidate pending
starts. Pending transports close immediately, late spawn replies are killed, and
old exit callbacks cannot remove replacement sessions. Native generations reject
queued stale starts and monotonic retirement preserves newer generations. Refcounts,
the existing four-session cap, idle timeout and crash backoff are unchanged.
Malformed percent escapes now return no file path; definition/reference navigation
normalizes unknown server payloads and rejects invalid URI/range/start coordinates.
No dependencies, timers or background work for unused features were added.

Validation: 5,100 frontend tests in 548 files, 1,509 tests in the full native run
(three ignored), and the final 46-test native LSP run including an additional
real-process cross-window cleanup test pass. Types, lint (80 existing warnings),
all-target Clippy, formatting, whitespace, build, startup graph and size checks
pass. Client JS is 2,831,448 compressed bytes; the measured allowance is 2,831,450.
Startup/terminal budgets are unchanged. These are macOS arm64 checks; platform
limitations are tracked in docs/pr-1-review-coverage.md.
Pass 88 logs: /tmp/oarlock-review88-{ai-stability,lsp,frontend-tests,rust-tests,native-lsp,types,lint,clippy,build,dist,size}.log.
The existing Git/Undo/Windows/platform release blockers remain open. No commit or push.


Review 89 kept AI on hold and moved from LSP lifecycle into protocol correctness,
editor navigation and terminal link parsing. The library resolves initialization
failures after calling onError, so a resolved initializePromise now also requires
client.ready before publishing running state. Failure closes the session and uses
the existing crash-recovery policy. A crash timer from an older configuration cannot
trigger reacquisition in the replacement generation.

A real-client fixture reproduced duplicate, conflicting responses to server
configuration requests. The transport now consumes requests it handles rather than
passing them to the library's generic null responder. Requests arriving before the
spawn acknowledgment wait for the session ID. Navigation results and picker callbacks
are bound to a view-plugin lifetime, so closing or removing the originating binding
cannot open a file from its delayed response. References on the same line retain
their distinct columns. Terminal file links reject malformed percent escapes;
relative links under Windows UNC paths preserve the server/share root, including
parent traversal at the share boundary. No dependency was added.

Controlled IPC fixtures also reproduced out-of-order LSP writes and 257 concurrent
writes against a stalled target. The proposed ordered writer with 256 pending
messages / 16 MiB, a 30-second write deadline and visible Restart on failure is held
for the user's architecture decision. Two reproductions in transport.test.ts are
explicitly skipped for that pending work, not claimed as fixes. Validation: 5,107 frontend tests in 549 files pass with those two skips; 1,510
native tests pass with three ignored. Types, lint (80 existing warnings), Clippy,
formatting, whitespace, build, startup graph and size checks pass. Client JS is
2,831,648 compressed bytes, 200 bytes above pass 88; the allowance is 2,831,650.
Startup/terminal budgets are unchanged. These are macOS arm64 results; Windows UNC
paths were tested as pure parsing, not Windows runtime certification. See
docs/pr-1-review-coverage.md for limits and release blockers.
Pass 89 evidence: /tmp/oarlock-review89-{before,protocol-before,admission-before,references-before,terminal-before,lsp,terminal-after,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
No commit or push.


Review 90 implemented the approved LSP writer policy from pass 89. OrderedLspWriter
serializes outbound IPC acknowledgments, with at most 256 messages / 16 MiB of UTF-8
payload including the in-flight message. Its byte counter handles surrogate pairs
and unpaired surrogates without allocating another encoded document. Overflow,
write rejection or a 30-second stall closes the transport, releases queued strings
and timers, terminates the native session and publishes a stopped reason with the
existing Restart action. Late acknowledgments, failures and native exit events
cannot resurrect work or overwrite that failure. No idle timer or dependency was
added; the writer is allocated only on first use.

Native LspSession independently enforces one active writer, a 16 MiB message cap
and a 30-second deadline. Its permit stays owned by the blocking worker until that
worker exits; a timed-out caller cannot admit another writer behind a stuck pipe.
The failure reason is saved before terminating the process. Existing process-tree
termination and page/window admission remain unchanged. The byte cap describes
payload, not aggregate memory used by strings, serialization and framing.

Stopped sessions now require explicit Restart or a configuration change, rather
than becoming eligible after crash history ages out. Starting a healthy root does
not clear a stopped root's recovery display. Tests cover ordering, byte/count
admission, timeout, close, late completion, failure isolation, explicit recovery,
and native blocked-pipe termination. Both held pass 89 tests are enabled and pass.
Validation: all 5,117 frontend tests in 550 files and 1,513 native tests pass
(three native tests ignored; no frontend skips). Types, lint (80 existing warnings),
Clippy, formatting, whitespace, build, startup graph and size checks pass. Client JS
is 2,832,284 compressed bytes, 636 bytes above pass 89; the allowance is 2,832,290.
Startup/terminal budgets are unchanged. These are macOS arm64 checks; platform
limits remain recorded in docs/pr-1-review-coverage.md.
Logs: /tmp/oarlock-review90-{lsp,native-lsp,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
AI stays on hold. Existing release blockers remain; no commit or push.


Review 91 kept AI on hold, checked the ordered LSP writer (88 focused tests pass)
and moved into terminal links and clipboard lifetimes. A delayed empty keyboard
clipboard read queried pasteEventsWanted after controller disposal; the actual
model asserts live ownership there. The handler now checks controller/model lifetime
before consulting paste modes. A read during a pending text clipboard write could
also retain the old image after the write completed. Text writes now invalidate
image-read caching in finally, matching the existing image-write completion rule.

Three controlled ownership failures are held for two user architecture decisions:
(1) a Local terminal file click can authorize/stat in Debian after an environment
switch during its awaits; (2) approving one program's clipboard prompt approves
another program because every pending read is merged; (3) an old OSC52 read can
send clipboard text to a restarted PTY through the reused BoundedPtyWriter. The
proposed fixes bind/cancel link operations on navigation and bind clipboard prompts
and replies to the exact terminal generation, cancelling on restart/close/permission
changes. No such ownership change was implemented without the requested answers.
Three reproduction tests are explicitly skipped for these unresolved release risks.
A separate 20,000-request prompt burst passed; suspected recursive overflow was not
reproduced and is not claimed as a bug or fix.

Validation: 5,120 frontend tests in 550 files pass with those three skips; 1,513
native tests pass with three ignored. Types, lint (80 existing warnings), Clippy,
formatting, whitespace, build, startup graph and size checks pass. Client JS is
2,832,288 compressed bytes within the unchanged 2,832,290-byte limit; startup and
terminal budgets are unchanged. These are macOS arm64 checks, not cross-platform
runtime certification. See docs/pr-1-review-coverage.md for remaining blockers.
Logs: /tmp/oarlock-review91-{ownership-before,clipboard-before,clipboard-after,prompt-burst-before,restart-before,terminal,lsp,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
No AI production edits, commit or push.


Review 92 implemented the user's approved link and clipboard ownership decisions.
Terminal clicks capture their space, environment, cwd and terminal generation before
lazy imports. Committed tab/space changes permanently revoke earlier clicks, including
away-and-back navigation; restart and close revoke terminal link work. Shell exit
ends clipboard/input work while retaining clickable scrollback links. Every
later async boundary checks ownership before navigation or focus. The file opener
uses the captured space and avoids implicit reauthorization through the current
window. WSL tilde links obtain that distribution's home only when needed.

Clipboard prompts share one promise only for matching owner, protocol/selection or
MIME request and program. Kitty matching uses the original name, not its sanitized
label. OSC52 cannot identify an authenticated program. Terminal end cancels prompts
and replies; synchronous clipboard-read preference changes revoke reads even if the
setting changes away and back before React effects run. Held reads in a live terminal
receive denial on permission cancellation. Late data never reaches a replacement
PTY. Linux middle-click also retains its input controller and terminal generation.
Already-issued native calls cannot be undone; later steps and results are suppressed.

A separate regression exposed main.rs:42:7 being misclassified as an external URL.
The parser now recognizes positioned bare filenames without changing supported URL
schemes. All three held pass 91 reproductions are enabled and pass.

Validation: 5,137 frontend tests in 551 files (131 focused terminal tests), 1,513
native tests with three ignored, types, lint (80 existing warnings), Clippy,
production build, startup graph, formatting and whitespace pass. Total client JS
is 2,833,038 gzip bytes (+750), budget 2,833,040; primary terminal JS is 93,000
(+444), budget 93,000. Startup budget is unchanged. No dependency, timer or per-frame
work was added. Two AbortControllers per terminal generation and one lazy-module
preferences subscription implement cancellation. These are macOS arm64 checks;
Git/Undo/Windows/platform release blockers remain in docs/pr-1-review-coverage.md.
Logs: /tmp/oarlock-review92-{diagnostic-before,terminal,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
AI stays on hold. No commit or push.


Review 93 kept AI on hold and moved into terminal clipboard writes. Controlled
regressions showed an OS image write failure silently substituting text, and
non-PNG conversion allocating a canvas despite exceeding the existing native image
limits. Native write errors now distinguish image-decode from clipboard-write
failure; fallback text remains available for unusable images but never hides an OS
commit failure. Conversion checks the existing 16,384-pixel side and 512 MiB RGBA
limits before allocating its canvas and closes the bitmap when rejected. This does
not bound the browser's initial image decoding allocation.

A real grayscale PNG also bypassed the decoded-byte limit during into_rgba8:
512 KiB of grayscale pixels passed a 1 MiB regression limit and expanded to 2 MiB.
Native decoding now checks the RGBA size before that expansion. Production's limit
remains 512 MiB. The test failed before the fix and passes after it.

Two controlled write-lifecycle reproductions remain held for user decisions:
a delayed program image still commits after terminal close; an older program image
can also overwrite a newer explicit Copy. The proposed terminal/page ownership and
native cross-window ordering policies are not implemented or claimed as fixes.
Their tests are explicitly skipped pending approval. Other-app clipboard writes
remain outside the proposed Oarlock ordering contract. Linux PRIMARY's existing
native dispatch ticket ordering was inspected, not removed or claimed broken.

Validation: 5,142 frontend tests in 551 files, with two held skips; 46 focused
terminal tests with those same skips; 1,515 native tests with three ignored. Types,
lint (80 existing warnings), Clippy, build, startup graph, formatting and whitespace
pass. Client JS is 2,833,165 gzip bytes (+127), budget 2,833,170; primary terminal JS
is 93,132 (+132), budget 93,140. Startup budget is unchanged. No dependency or timer
was added. Results are macOS arm64 only; existing release blockers remain recorded
in docs/pr-1-review-coverage.md. No AI production edits, commit or push.
Logs: /tmp/oarlock-review93-{clipboard-before,clipboard-after,native-before,terminal,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.


Review 94 implemented both user-approved clipboard write policies. Native
ClipboardWrites owns two latest tickets (clipboard and PRIMARY), per-page admission
sequences, and commit locks held only on blocking workers. Preparation has no OS
lock. Page validation and exact ticket consumption define the final irrevocable
commit point. Reload/close cleanup removes metadata without waiting for OS writes;
its slow-commit regression passes. A newer window's reservation supersedes older
uncommitted work, and delayed older requests within a page cannot re-admit after a
newer sequence. Cancel is exact, tickets are single-use, and stale pages cannot
start new work.

Frontend ClipboardWrite binds cancellation through late reservation replies and
conversion. Program writes capture their terminal generation; the last pending
value is prepared even while another conversion is running, so a newer explicit
Copy can supersede it. Bursts still coalesce before admission. Terminal close and
restart cancel writes; shell exit only ends input/reads and retains final program
writes until the model closes. Program callbacks from replaced generations are
ignored. Oarlock Copy buttons now use the coordinator; browser/menu Copy and Cut
announce an ordering barrier while retaining their native formats. Direct plugin
write permission and the old PRIMARY write IPC were removed.

Both held pass 93 reproductions are enabled and pass. Copies from other apps,
already-started OS calls and cross-window image-read cache coherence are not claimed
as covered. Native admission defines cross-window ordering. AI backend/request work
remains on hold; AI renderer and MCP log Copy buttons only use the shared transport.

Validation: 5,151 frontend tests in 552 files, 55 focused terminal/clipboard tests,
and 1,519 native tests (three ignored) pass. Types, lint (80 existing warnings),
Clippy, build, startup graph, formatting and whitespace pass. Total client JS is
2,834,365 gzip bytes (+1,200), budget 2,834,370; primary terminal JS is 93,367 (+235),
budget 93,370. Startup budget is unchanged. Writes add one native admission IPC
before commit; cancellation uses the exact ticket. No dependency or idle polling
was added. At most two tickets and two sequence entries per live page are retained;
program cancellation signals allocate lazily. macOS arm64 evidence only; existing
Git/Undo/Windows/platform blockers remain. No commit or push.
Logs: /tmp/oarlock-review94-{terminal,native,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.


Review 95 implemented the approved clipboard snapshot contract for macOS/Windows
and the GTK selection-notification path. It keeps AI execution on hold. Controlled
regressions showed cached PNG bytes surviving a shared Copy-button write and an
external clipboard replacement. Reads now return text plus image status under one
native revision, verify that revision before/after reading and encoding, and reuse
an image only when native verification confirms its exact version. The binary
response omits image bytes on reuse. macOS uses changeCount; Windows uses the system
clipboard sequence; zero/unavailable versions fail. Direct arboard access keeps
absence distinct from read errors, using the dependency already in the bundle.

The frontend retains at most one image capture in flight per page and one image
for one second, with a one-shot expiry while bytes are held. Queued image captures
check cancellation and use the latest cached version when admitted. Text-only
reads avoid image encoding. Page generations reject obsolete admission/results;
terminal cancellation drops delayed results. OS reads already in progress are not
claimed forcibly cancellable. Native menu paste uses its event's text/image types,
including image Files, and beforeinput no longer rereads unrelated image state.
Keyboard failures show a paste error; Kitty reads return io-error. Old unversioned
image/PRIMARY commands and plugin read permission were removed. Linux PRIMARY
keeps its 4 MiB limit. GTK capture has a five-second callback deadline, pixel packing
and PNG encoding run off the main thread, and the final revision is rechecked.

Linux qualification remains incomplete. GTK's supports_selection_notification is
false on Wayland, although focused data offers emit owner-change events. The
current guarded path therefore refuses unverified Wayland reads. A focused-read
lifetime policy versus a separate background clipboard service was asked before
expanding that behavior; no Wayland completion is claimed. Evidence:
https://raw.githubusercontent.com/GNOME/gtk/gtk-3-24/gdk/wayland/gdkdisplay-wayland.c
https://raw.githubusercontent.com/GNOME/gtk/gtk-3-24/gdk/wayland/gdkdevice-wayland.c
Linux compilation/display runtime and Windows runtime remain outstanding.

The review then moved into file drops. Two controlled lifecycle tests failed:
a retired terminal listener duplicated a paste after remount while registration
was pending, and a retired Explorer listener started authorizing/copying a drop.
Both callbacks now check their existing disposed flag before any action. This
preserves their existing lifecycle without a new architecture policy.

Validation: 5,163 frontend tests in 554 files, 126 focused clipboard/input/drop
tests, and 1,522 native tests (three ignored) pass. Types, lint (80 existing
warnings), Clippy, build, startup graph, formatting and whitespace pass. Client JS
is 2,834,706 gzip bytes (+341), budget 2,834,710; primary terminal JS is 93,924
(+557), budget 93,930. Startup remains within its unchanged 540,000-byte budget
at 251,076 bytes. The small budget increase covers snapshot decoding, ownership,
error handling and file-drop guards. Every capture adds a version-check IPC even
on image reuse; combined reads replace separate text/image calls. No new crate,
background polling or heavy eager frontend dependency was introduced. The image
expiry timer exists only while cached bytes are retained. macOS arm64 validation
only; Wayland and the existing Git/Undo/Windows/platform blockers remain. No commit
or push. Logs: /tmp/oarlock-review95-{cache-before,terminal,drop-before,drop-after,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log;
measurements: /tmp/oarlock-review95-size.json.


Review 96 implemented the user's Wayland keyboard-focus policy. Wayland bypasses
GTK's generic selection-notification capability check only through the focused
requesting window. Each such window lazily owns a native focus epoch, updated on
keyboard-focus transitions and retired on destruction. Its snapshot revision
combines the clipboard revision with that epoch, so another window or a
loss-and-regain cycle cannot reuse an earlier image or complete an earlier capture.
Pending GTK captures observe focus loss and destruction, return an error, and
remove their callback handlers and deadline. The persistent epoch also invalidates
results if focus changes while pixel encoding is already running; already-started
OS work/PNG encoding is not claimed forcibly interrupted. Native page ownership
still gates admission and completion. X11/macOS/Windows keep their existing policy.

Native snapshot headers identify focus-required reads. The frontend observes blur
for each unfinished read, including queue waits, and rejects a delayed Wayland
reply after focus loss even if the window has regained focus. It clears cached
image state on that rejection. The same delayed-reply test verifies other
platforms are not accidentally subject to the Wayland policy. The blur observer
is removed on success/error and does not run while no read is pending.

Validation: 5,165 frontend tests in 554 files and 1,524 native tests pass (three
ignored on macOS), plus types, lint (80 existing warnings), Clippy, build, startup
graph, formatting and whitespace checks. Two native focus-state regressions and
two frontend delayed-reply cases cover the new policy. The production Linux
clipboard module was also compiled against GTK 0.18.2 in a disposable Ubuntu
arm64 harness, with stubbed Tauri and image-encoding boundaries. Its checked-in display test
passed under Xvfb: real GTK focus notifications cancel a pending capture, release
handlers/timer, reject background ownership and invalidate the old epoch. A
second checked-in test passed under headless Weston with GDK_BACKEND=wayland,
confirming Wayland backend admission and refusal without keyboard focus despite
unsupported generic notifications. That intentionally seatless compositor emits
a GTK missing-seat diagnostic; it does not test focused desktop paste. The two
Linux display tests are explicitly ignored in ordinary headless test runs.

This is module compilation and GTK/display evidence, not a complete Linux Tauri
build or end-to-end Wayland clipboard certification. Focused text/image paste on
real Wayland desktops and Windows runtime checks remain outstanding. The test
container was removed after completion; only logs/harness files remain in /tmp.
No AI execution changes, new dependency package, polling or commit/push. Native
focus bookkeeping is allocated only after a Wayland read and removed with its
window. Total client JS is 2,834,877 gzip bytes (+171), budget 2,834,880; primary
terminal JS is 94,099 (+175), budget 94,100. The small measured increase covers the
frontend focus barrier; startup remains within its unchanged budget at 251,077
bytes. Existing Git/Undo/Windows/platform release blockers remain.
Logs: /tmp/oarlock-review96-{native-focus,focus-ui,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log;
Linux harness/logs: /tmp/oarlock-review96-linux/; measurements: /tmp/oarlock-review96-size.json.


Review 97 kept AI on hold, rechecked clipboard/focus regressions and moved into
terminal file drops and Explorer copy operations. A real /bin/sh regression proved
that a literal backslash in a dropped POSIX filename was consumed as shell syntax:
/tmp/a\b.txt became /tmp/ab.txt. The POSIX formatter now quotes backslashes;
Windows quoting is deliberately not generalized without the shell-policy decision.
The former drive-path test now expects quoting when running the POSIX formatter.

Controlled regressions also proved that source authorization could finish after
Explorer disposal or a workspace change and still dispatch fs_copy. Clipboard
paste now rechecks its existing isCurrent owner after authorization, and marks
copyStarted only immediately before dispatch. File-drop callbacks recheck disposal,
root and captured environment before dispatch. Already-dispatched copies retain
their original destination/environment. Tests cover disposal, an environment
change, cancelled clipboard paste and a successful current Explorer drop. This
repairs missing checks at an existing await boundary; it does not add a native
copy-cancellation protocol. Copy Relative Path now handles / and drive roots such
as C:/ without adding an extra slash and returning an absolute path instead.

A separate shell-ownership issue remains held. A Windows-formatter fixture fed to
real /bin/sh evaluated $(printf oarlock-probe) embedded after a filename prefix;
the returned filename contained the command's output. This is a controlled
Windows-format/POSIX-parser reproduction, not a Windows runtime test. The drop
formatter only knows the host OS, which cannot distinguish WSL/Git Bash,
PowerShell, cmd, or a nested/remote shell. The user was asked whether drops should
bind to the target terminal's shell/environment, translate host paths for WSL and
refuse unknown contexts, or disable shell path insertion for the release. No new
shell-identity protocol or global Windows quote change was made. The failing
regression is explicitly skipped while that architecture decision is pending;
this is a release risk, not a passing or fixed case.

Validation: 5,172 frontend tests pass in 554 files, with one held shell-policy test
skipped in a separate file. The focused set passes 44 tests with that same skip.
All 1,524 native tests pass (three ignored on macOS). Types, lint (80 existing
warnings), Clippy, build, startup graph, formatting and whitespace pass. Total
client JS is 2,834,922 gzip bytes (+45), budget 2,834,930; primary terminal JS is
unchanged at 94,099 and startup is 251,087 within its unchanged budget. No new
dependencies, timers, IPC calls or per-frame work were introduced. The current
Wayland/full-Linux-build, Windows, Git and Undo release-validation limitations
remain. No AI execution changes, commit or push.
Logs: /tmp/oarlock-review97-{quote-before,lifetime-before,relative-before,focused,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log;
measurements: /tmp/oarlock-review97-size.json.


Review 98 implemented the approved shell-aware terminal drop boundary and the
subsequently approved verified-command-bar restriction. Shell-path insertion now
requires a known command-bar argument boundary and its exact captured editor state.
Raw/ambiguous shell buffers and multiple selections are refused visibly. Paths use
POSIX, fish, PowerShell or cmd literal syntax; cmd expansion hazards are refused.
The formatter never derives dialect from the host OS. Native preparation binds the
original PTY's launched executable, foreground process group and window ownership;
unknown, replaced, nested or shared-group readers fail closed. macOS /bin/sh is a
launcher, so its selected /private/var/select/sh executable is captured at spawn.

WSL launch adds a random PID-bound marker. A bounded Linux helper verifies its
original shell executable and sole foreground-group ownership, translates host
paths through wslpath in that distribution, and verifies ownership again. Explorer
passes its captured source environment and cancels pointer drags when that scope
changes. Async frontend delivery captures terminal generation and navigation;
restart, close, navigation and changed editor state suppress stale insertion.
Registered OSC72 application drops retain their existing protocol. No AI execution
or backend changes; the composer drop wrapper only forwards source metadata to
its terminal fallback.

Five native regressions and real Linux PTY tests cover the shell checks. The Linux
harness initially reproduced a child sharing the original shell's group being
accepted; the final check rejects it. The full native suite also exposed macOS's
sh-launcher identity transition, now handled explicitly. Native tests wait for real
process transitions and clean up sessions on assertion failures. The Linux harness
lives in scripts/terminal-shell-drop/probe.py and ran in an offline, removed
container. Actual Windows/WSL path conversion, Windows shell launch wrappers and
fish/PowerShell desktop execution are not certified by that test.

The review moved into terminal regex search. A production search step using
(a+)+$ against 2,000 short nonmatching lines failed to return within the bounded
one-second reproduction process. A line budget does not interrupt regex backtracking
on the UI thread. The user was asked whether to isolate regex work in a disposable,
bounded worker or disable regex for this release. That architecture decision is
pending; no regex fix is claimed. scripts/terminal-shell-drop/regex-probe.mjs
retains the bounded reproduction. AI stays on hold.

Validation: 5,192 frontend tests, 1,529 native tests (three ignored), types, lint
(80 existing warnings), Clippy, build, startup graph, size and whitespace pass.
Touched frontend files are formatted; the full repository formatter reports
unrelated existing differences, recorded in docs/pr-1-review-coverage.md. Client JS
is 2,835,869 gzip bytes (+947), budget 2,835,870; primary terminal is 94,434 (+335),
budget 94,440; startup is 251,115 within its unchanged limit. No dependency, idle
timer or per-frame work is added. Drop formatting loads lazily and adds one native
preparation call per shell drop. A terminal holds a small launch descriptor and
one in-flight flag. The WSL helper has a four-second inner timeout and a five-second
host wait; cancelled UI owners cannot receive its results. Existing Git/Undo and
cross-platform release blockers remain. No commit or push.
Logs: /tmp/oarlock-review98-{focused,native-drop,linux-probe,frontend-tests,rust-tests,types,lint,clippy,build,dist,size,format,regex-before}.log;
measurements: /tmp/oarlock-review98-size.json.


Review 99 implements the approved terminal regex isolation. Regex compilation and
execution live only in a disposable worker; literal search retains its native
path. Each page admits four active workers, one batch per scan. Batches contain at
most 128 rows, 65,536 cells and 131,072 UTF-16 units; patterns have at most 4,096
units. A scan reads at most 8,388,608 units (16 MiB UTF-16) and lasts ten seconds;
each batch has a one-second deadline including startup and delivery. The existing
10,000-match cap remains. UI row extraction yields between rows after four
milliseconds. A regression also prevents one extra regex evaluation after the
match cap has already been reached.

Query changes, output changes, suspension, clearing and disposal revoke obsolete
work and terminate its worker. Streaming output debounces restart for 100 ms.
Completion also terminates the worker, with no idle worker or frame polling while
awaiting a batch. Failed scans clear partial highlights and show Search failed ·
Retry; renderer replacement and fresh output preserve the failure until explicit
Retry or a new query. Deadlines check both the timer and elapsed time at delivery.

The production-engine hostile-pattern probe remains responsive (91 heartbeat ticks
in 1,004 ms), terminates the worker, and succeeds on a subsequent ordinary search.
An isolated actual WKWebView loaded the Vite-built worker using tauri://localhost
and the production CSP; timeout and wide-cell recovery pass. Fixtures live in
scripts/terminal-search and scripts/terminal-shell-drop/regex-worker-probe.mjs.
This does not certify full Tauri integration or Windows/Linux webviews.

Validation: 5,217 frontend tests across 561 files, 1,529 native tests (three ignored),
types, lint (80 existing warnings), Clippy, build, startup graph and size pass.
Client JS is 2,838,056 gzip bytes (+2,187), budget 2,838,060; primary terminal is
95,788 (+1,354), budget 95,790; startup is 251,218 (+103), within its unchanged
budget. No new dependency, native IPC or idle worker. Unrelated formatter issues
and the existing Git/Undo/platform release blockers remain recorded in
docs/pr-1-review-coverage.md. AI stays on hold. No commit or push.
Logs: /tmp/oarlock-review99-{frontend-tests,final-focused,rust-tests,types,lint,clippy,build,dist,worker-real,webkit,format}.log;
measurements: /tmp/oarlock-review99-size.json.


Review 100 rechecked the terminal regex worker fixes and moved into editor search
and sidebar/palette query lifetimes. The shared useAsyncQuery hook now owns its
queued debounce: Retry consumes it, rather than dispatching an immediate request
and another when the timer fires. Effect cleanup invalidates the request generation
so replies after unmount cannot publish. Synchronous runner exceptions now enter
the same recoverable error path as rejected promises. Tests reproduced the duplicate
dispatch and two state writes after unmount before the fix; current regressions
also retain newer query results when older work completes.

Two broader issues await architecture decisions. Production editor MatchScan and
CodeMirror's regex cursor both exceeded a two-second external deadline on a roughly
1 KiB document with (a+)+$. Isolating only counting would leave navigation,
highlighting and Replace exposed. The user was asked whether to extend bounded
workers to all editor regex operations with document-version checks for replacement,
or disable editor regex for the release. No editor implementation was changed.
The safe reproduction launcher is documented in scripts/search-review/README.md.

A hook regression also retained Ubuntu results after switching to Debian at the
same /repo path, without issuing a new search. Results contain no environment,
while opening uses the current environment. The user was asked whether requests
and results should carry workspace identity, clear on navigation and cancel native
walks on close/supersession. That test is explicitly skipped pending the decision;
its failing run is retained. The small query-hook fixes do not cancel native walks.

Validation: 5,221 frontend tests across 562 files pass, one held workspace-search
regression skipped; 1,529 native tests pass, three ignored. Types, lint (80 existing
warnings), Clippy, build, startup graph and size pass. The first sandboxed frontend
run could not bind loopback servers; the full rerun with loopback access passed.
Client JS is 2,838,096 gzip bytes (+40), budget 2,838,100; primary terminal unchanged
at 95,788; startup 251,216 within its unchanged budget. One timer ref and callback
per mounted query hook, no dependency, IPC or idle work. Existing unrelated formatter
issues and release blockers remain in docs/pr-1-review-coverage.md. AI stays on hold.
No commit or push.
Logs: /tmp/oarlock-review100-{query-before,editor-before,focused,final-focused,frontend-tests,rust-tests,types,lint,clippy,build,dist,format}.log;
measurements: /tmp/oarlock-review100-size.json.


Review 101 implements the approved ordinary editor regex worker boundary and
project-search ownership. The editor panel, navigation/replace shortcuts,
highlights and match counts consume one result tied to the captured document and
query. Regex data lives in a separate field; CodeMirror's search state holds an
empty literal query, and external regex query effects are intercepted before view
updates. MatchScan now refuses all regex. Literal search retains its prior path.
Queued replacement also requires unchanged selection and current writable state.
Tests cover edits, new queries, selection changes, read-only changes, closing,
hiding and destruction. Failure clears highlights and offers Retry. Empty regex
mode stays selected without starting work. Automatic scans wait 100 ms; explicit
navigation and Retry start immediately.

Editor worker limits: four active per page, 4,096 pattern/replacement UTF-16 units,
8,388,608 document/output units (16 MiB), 10,000 matches and ten seconds total.
Exceeded limits report errors and never apply a partial Replace All. Select All
keeps the existing 1,000-selection cap. Whole-word boundaries use the owning
language's character categorizer. Worker code uses the existing CodeMirror query
semantics; it has no native APIs and is loaded only on regex use.

Project searches retain space/environment/root ownership and clear old results
on navigation, including identical paths in different distributions. An AbortSignal
owns preparation and each exact native request; admission is acknowledged separately
from completion so an early cancellation is retried. Native registration checks
the page generation; page reload/close invalidates ownership before cancellation.
A separate 16-request registry retains admission until blocking filesystem work
actually exits. Cancellation is cooperative between files and at matched lines;
blocked OS filesystem IO cannot be forcibly interrupted. Dispatch-order channel
supersession was removed so an old late request cannot cancel a newer one. Opening
a hit authorizes its original environment and rechecks ownership/root after the
await. The formerly held WSL regression is enabled and passing.

Vim uses a separate synchronous regex cursor. A real adapter reproduction exceeded
a two-second external deadline on the hostile pattern. The user was asked whether
to route Vim search/substitution to the safe panel, visibly refusing unsupported
search motions, or redesign the adapter asynchronously. That compatibility decision
is pending. No safe-Vim-regex claim is made and normal Vim editing was not changed.

Validation: 5,246 frontend tests across 567 files, no skips; 1,531 native tests,
three ignored; types, lint (80 existing warnings), Clippy, build, startup graph and
size pass. Isolated actual WKWebView verifies responsive hostile-regex termination,
recovery, highlights, Replace All and query interception under the app scheme/CSP.
It does not certify full Tauri or Windows/Linux webviews. Client JS is 2,860,386
gzip bytes (+22,290), budget 2,860,390; startup 251,243 within its unchanged budget;
primary terminal 95,785 within its unchanged budget. No added dependency or idle
workers. Existing formatter/platform/Git/Undo limitations remain in
docs/pr-1-review-coverage.md. AI stays on hold. No commit or push.
Fixtures: scripts/editor-search/README.md and scripts/search-review/README.md.
Logs: /tmp/oarlock-review101-{query,focused,frontend-tests,rust-tests,types,lint,clippy,build,dist,format,webkit,vim-before}.log;
measurements: /tmp/oarlock-review101-size.json.

### Review 102: compatible Vim continuations and terminal LazyVim

The user superseded the proposed safe-panel fallback: both built-in Vim commands
and terminal LazyVim/Neovim must remain supported. Approved pinned local forks of
the Vim core and CodeMirror adapter now live in packages/codemirror-vim-core and
packages/codemirror-vim. Upstream sources, licenses and compatibility corpus are
retained separately; see each UPSTREAM.md. No command was intentionally removed
or redirected. This remains upstream Vim emulation, not full Neovim semantics.

The functional core uses synchronous generator continuations until an operation
actually awaits search or a callback. The adapter runs user-pattern evaluation in
disposable workers, including search cursors/highlights, search motions/objects,
Ex address searches, global/vglobal, pattern sort and substitution. Input waits
in order behind suspended commands; because registers/macros are shared, the
queue spans editor views. At most 256 input entries wait. Ownership captures the
editor generation/document/editing permissions; resumed steps revalidate before
mutating. External edits/selection changes, document retargeting, hiding,
destruction and mode teardown cancel pending work. Cancellation does not roll
back prior macro edits over subsequent external edits. Public handleKey,
multiSelectHandleKey, handleEx and findKey can return promises; callers must await
them before reading final state. Application write/quit handlers return their save
promises and retain existing identity/close guards.

Workers share the ordinary Find/Replace four-worker budget. Limits are ten seconds
per command/worker; 4,096 UTF-16 units for patterns/replacement templates;
8,388,608 units for documents/results/replacement expansion; and 10,000 matches
or lines for regex range operations. Validation precedes expansion/serialization.
Worker documents get incremental changes during a command. Ordinary synchronous
keys allocate no worker or timer. Highlights debounce 100 ms and terminate work
when settled or superseded. Preview cancellation retains pending search operators.
Interactive dialogs close after external updates, never dispatch inside an editor
update; macro recording banners remain open while normal text input is recorded.

Review found and fixed fork regressions in recording banners and stale prompt
closure, plus upstream mapped-search macro history, duplicate substitution
completion and a shared highlight timer. The actual macOS WebKit fixture passes
21 focused cases without plugin errors, including ten-second hostile-pattern
timeout/recovery, macros, counts, operators, confirmations, ordered typing,
jumplist navigation, visual search objects and one-step substitution undo.
The adapted upstream corpus completes 715 cases against pristine and forked
packages: both pass 622 with no added failures. The remaining 93 baseline/fixture
failures still need investigation; this is not full Vim compatibility certification.

A separate real-Neovim PTY probe feeds output/query replies through the production
Ghostty WASM model and keys through GhosttyInputController. Installed LazyVim
16.0.1 with Neovim 0.12.6 passes startup, leader-ff picker, Escape, insert/motions,
ciw, :%s and :wq. Temporary XDG state/config/cache isolates the test; plugin updates
and missing-plugin installation are disabled. This does not certify every user
plugin/configuration, native app shortcuts, rendering or Windows/Linux behavior.

Validation: 5,361 frontend tests in 572 files; 1,531 native tests, three ignored;
types, lint (80 existing warnings), Clippy, build, startup graph and size pass.
Native production code is unchanged. Client JS 2,877,708 gzip bytes (+17,322),
budget 2,877,710; startup 251,242 and primary terminal 95,785 remain within unchanged
budgets. No added third-party runtime dependency. Fixtures and upgrade procedure:
scripts/vim-review/README.md. Logs: /tmp/oarlock-review102-*.log; comparison and
size JSON alongside. AI remains on hold. Existing Git/Undo/platform release
blockers remain in docs/pr-1-review-coverage.md. No commit or push.

### Review 103: Vim compatibility triage and browser preview lifetimes

Investigated review 102's 93 unexplained Vim failures. The corpus fixture had
different key precedence and selection support than the app: default shortcuts
intercepted Vim Ctrl keys and multiple selections were disabled. It now uses
Prec.highest(vim()), multiple selections, native Tab handling, layout measurement
between keys, stable line metrics and one-pixel tolerance for fractional glyph
rectangles versus integer scroll offsets. Static platform properties forward to
the actual adapter rather than being copied into an unrelated factory. The copy
case uses the platform's word-selection chord and distinct-event cleanup timing.
No corpus cases were removed. XML uses the same legacy stream parser as the app;
a structural HTML comparison is evidence about the missing tree, not a substitute
for XML support.

Two real defects were reproduced and fixed within the approved fork architecture:
visual-block space indentation now uses indentUnit instead of tabSize; explicit
scrollTo in a Vim operation suppresses that operation's automatic cursor reveal,
so z<CR>/z- retain the same alignment as zt/zb after moving to the first character.
Normal cursor reveal remains covered. Unit and actual WebKit regressions pass.

The same corrected 715-case corpus passes 703 pristine / 706 fork with no added
failures. Nine remain: six XML dit/dat cases require a structural tag tree; two
filetype tests reference CodeMirror 5's absent defineMode, and the actual adapter
also silently ignores setOption('mode'); one S-block indentation expectation
differs after malformed JavaScript `1hello{`. A valid-JavaScript S-block regression
passes. Asked the user before adding a shared per-document language override or
changing the XML parser; both changes are held pending decisions. This is not
complete Vim/Neovim parity. All 24 focused WebKit cases pass, including previous
worker cancellation/recovery, macro, prompt, queued input and undo regressions.

Moved into browser preview tabs. Controlled tests of PreviewAddressBar confirm
that a delayed port-5173 probe overrides newer manual port-8000 navigation, and
unmount does not abort the probe signal. Asked for visible-preview ownership with
cancellation on typing, navigation, newer checks, tab/space switch and close.
Production preview behavior is unchanged pending that decision. The explicit
failing reproductions are scripts/preview-review/port-probe.repro.tsx, run with
that directory's vitest.config.ts; they are deliberately outside the regular
passing suite and must be promoted when fixed. See its README for details.

Validation: 5,363 regular frontend tests in 573 files; 1,531 native tests, three
ignored; types, lint (80 existing warnings), Clippy, build, startup graph and size
pass. Native production code is unchanged. Client JS 2,877,721 gzip bytes (+13),
budget 2,877,730; startup 251,243 and primary terminal 95,785 within unchanged
budgets. No new dependency. Logs /tmp/oarlock-review103-*.log and comparison/size
JSON; scripts/vim-review/README.md records the corrected fixture. AI stays on hold.
Existing Git/Undo/platform release blockers remain. No commit or push.


### Review 104: document filetype, structural XML and preview ownership

Implemented the approved shared per-document language override using the existing
persisted tab override, retained through rename. Vim mode reads/writes bind to
that document; empty filetype means plain text and filetype&/ft& reset detection.
Highlighting, LSP/status and formatter selection use documentLanguage. Unknown
filename extensions retain custom LSP identities; explicit plain text disables
language services. Formatter IPC accepts a validated syntax extension hint only;
authorization and cwd still use the original document path. Changing language or
ownership rejects delayed formatter results and old LSP attachments.

XML now lazily loads @codemirror/lang-xml 6.1.0 with a structural tag tree.
Review of these fixes found a mount regression: CodeMirror creation can follow the
parent layout effect. Parser attachment now follows the actual creation callback,
clears obsolete syntax before paint, applies after child configuration, and rejects
stale resolution by generation. Destruction clears the created-view owner. An
actual React/CodeMirror WebKit fixture checks mount, replacement and disable.

Preview port checks belong to the visible preview and current navigation. Typing,
submit/reload, a new check, tab/space switch, move or close invalidates and aborts
the old operation. The 900 ms deadline remains; bodies are cancelled immediately
after reachability is known. No idle timers. Reproductions now run in the normal
suite; obsolete deliberately failing preview fixtures were removed.

Validation: 5,403 frontend tests in 580 files; 1,532 native tests, three ignored;
types, lint (79 existing warnings), Clippy, Rust formatting, whitespace, build,
startup graph and size pass. 27 actual WebKit cases pass without plugin errors.
715-case corpus: 709 baseline / 714 fork, no added failures. Both now use structural
XML; the CM5 defineMode setup is skipped only for CM6 while retaining assertions.
The one remaining case expects legacy indentation of malformed JavaScript; valid
JavaScript passes. Terminal LazyVim code was unchanged, so pass 102's smoke was not
repeated. No claim of full Vim parity or other-platform certification.

Total client JS 2,882,043 gzip bytes (+4,322), budget 2,882,050 for the approved lazy
XML dependency and fixes. Startup 251,045 (-198), primary terminal unchanged at
95,785; their budgets unchanged. Logs /tmp/oarlock-review104-*.log; coverage and
remaining blockers in docs/pr-1-review-coverage.md. AI remains on hold. No commit
or push.


### Review 105: theme persistence, CLI completion and native menu teardown

Moved to new non-AI sections after bounded checks of the previous language/preview
fixes. XML production code is unchanged. CLI `open --no-focus` must not wait for
requestAnimationFrame: a hidden window may never paint. The response follows tab
acceptance and queued editor navigation. Requests whose React bridge is disposed
cannot open tabs, including queued events and operations awaiting window focus;
they return frontend_unavailable. Native-menu callbacks similarly check their
bridge's stopped flag, including when listener registration settles after cleanup.
These enforce existing teardown/response contracts without changing the protocol.

Theme store read/modify/write transactions are not safe: two independent imports
lose one theme, and saving another theme can resurrect a concurrent deletion.
Two controlled reproductions invoke production functions against one mock shared
store. Proposed native transactional storage and revisioned snapshots await the
user's architecture decision. No production theme persistence changes were made.
Run the explicitly failing evidence with scripts/theme-review/vitest.config.ts;
it is outside the normal passing suite. Background import/removal and stale CLI
caller fallback were inspected but remain follow-up targets, not certified fixes.

Checks: 5,408 frontend tests in 582 files; 1,532 native tests, three ignored;
types, lint (79 existing warnings), Clippy, touched-file formatting, whitespace,
build, startup graph and size pass. Total JS 2,882,076 gzip bytes (+33), total budget
2,882,080 (+30); startup 251,072 (+27), terminal unchanged at 95,785. Their budgets
are unchanged. No dependencies, idle work or IPC round trips added. Native code
unchanged. Pass 104's WebKit/Vim corpus evidence was not rerun or recast as new
coverage. Logs /tmp/oarlock-review105-*.log. AI remains on hold; no commit or push.


### Review 106: native transactional custom themes

Implemented the approved theme-store ownership change. One native mutex serializes
per-ID upsert batches and deletion. The entire batch validates before committing;
last duplicate ID wins within a batch and later commits win for the same ID. Edits
to unrelated IDs cannot lose imports or resurrect deletions. Revisions advance
only after successful persistence; no-op deletion and empty batches do not advance.
The native store emits full revisioned snapshots, so the UI can accept skipped
revisions and ignore stale reads, events and command replies without another fetch.

The new oarlock-themes.json catalog migrates the existing custom-theme list once,
leaving oarlock-custom-themes.json unchanged. Both names are denied to the store
plugin, including get_store and case variants, so shutdown cannot rewrite them.
Malformed data, wrong schemas, duplicate IDs and read failures are errors, never
empty defaults. External changes after loading refuse further overwrites. Retry
recovers a repaired original file; a deliberately changed native snapshot requires
restart. Existing supported metadata and ACLs survive commits through the shared
conditional writer and its per-file lock; staging stays private and outside Git
worktrees. The writer's 50 MiB bound also limits the catalog. Unsupported safe-write
platforms fail explicitly; Windows theme migration/saves therefore share the
existing Windows staged-write release blocker. Built-in themes remain available.

The provider subscribes before reading, checks revisions and exposes readiness,
error and Retry. Custom-theme controls wait for successful loading, while built-in
theme choices remain usable. Failed deletion retains the selected theme; completion cannot reset a newer selection; failed
editor-file ingestion reports why the saved file was not applied. List edits
require one mutation IPC, with no JS read/modify/write or idle polling.

The two previously failing theme reproductions are replaced by native concurrency
and persistence tests plus frontend snapshot-order/recovery tests; see
scripts/theme-review/README.md. Validation: 5,413 frontend tests in 583 files;
1,540 native tests, three ignored; types, lint (79 existing warnings), Clippy,
formatting, whitespace, build, startup graph and size pass. macOS arm64 execution
only; no Windows/Linux runtime certification. Total client JS 2,880,576 gzip bytes
(-1,500), unchanged budget 2,882,080. Startup 251,032 (-40), primary terminal 95,786 (+1 from
chunk output), both within unchanged budgets. No dependency added. Logs
/tmp/oarlock-review106-*.log. AI remains on hold. No commit or push.


Explorer mutation policy (macOS release): rename, move and delete check authorized
entries and publish the existing document mutation events. They do not guarantee
against another same-user process replacing entries after those checks. macOS copy
stages privately outside worktrees on the destination filesystem and uses the native
metadata-preserving copy operation followed by a no-replace publication. Nested
links escaping authorized folders are refused; links are not traversed. A folder
copy reads entries as encountered, so concurrent external edits can produce mixed
versions. Copies are refused when a suitable private same-volume staging location
is unavailable. Linux rename, move and delete use the same checks; metadata-safe
copy remains unavailable there pending validation. Windows remains a later port.

Review follow-up: tab and active-tab mutations update their shared refs before
React publishes a render, so returned pane IDs and disposal do not depend on
when React runs an updater. Suspended Vim commands have a ten-second deadline;
retirement resets transient shared command state and stale continuations cannot
reset the next owner. Already-applied edits are not rolled back.

Theme imports save assets before a conditional selection; background kind and
image ID publish in one preference update. Background candidates use a shared
Web Lock and dated IDs; a later import removes old unselected candidates only
after a preference revision barrier. A missing selected theme is resolved against
fresh catalog and preference snapshots, reset to the built-in default and reported.
User-visible catalog entries are retained. The store-plugin alias boundary remains
under review as R216; the plugin still follows aliases on disk.

PTY startup carries the native page generation, and write, resize, close and
foreground checks require the owning window. Repository watches check the same
Git metadata authorization as Git operations. Explicit workspace opens recheck
path authorization rather than caching a spelling across later opens. Conditional
writes compare opened file identity against the pinned entry, including hard links.
