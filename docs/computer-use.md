# Computer Use

Computer Use observes and operates local application windows through macOS
Accessibility or Linux AT-SPI, with screenshot artifacts for visual evidence. Prefer a connector,
API, CLI or browser tool when one can complete the task directly.

For unattended terminal/server use, [`dscode server --yolo`](remote-runtime.md#unattended-yolo-server)
preauthorizes application access and automatically answers sensitive-action
confirmation requests. OS Accessibility and Screen Recording permissions still
apply; on Linux, graphical-session access and Portal consent still apply.
The separate experimental Desktop Host described below retains its own
permission setup.

## Linux terminal and server

The Linux terminal/server uses a persistent Python helper for AT-SPI, X11 and
Wayland Portal access. `/computer status` reports the actual display, accessibility,
input, capture, desktop-session and control-lease capabilities. Load `computer-use`
or call `computer_use_activate` to expose the operating tools. Reactivate after
session resume if the tools are absent. Missing dependencies leave coding available.

On Debian/Ubuntu, install the basic desktop dependencies:

```bash
sudo apt-get install python3 python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0 at-spi2-core xdotool x11-utils
```

Wayland capture additionally requires PipeWire, `xdg-desktop-portal`, the compositor's
Portal backend, `gir1.2-gstreamer-1.0`, `gir1.2-gst-plugins-base-1.0`,
`gstreamer1.0-pipewire` and `gstreamer1.0-plugins-base`. System GI packages must be
available to `/usr/bin/python3`. An ordinary Host needs the graphical user's display
variables and session D-Bus connection. An SSH shell alone does not provide a desktop.

| Capability | X11 | Wayland |
| --- | --- | --- |
| Structure, queries and subtrees | AT-SPI | AT-SPI where exposed by the application |
| Element actions and Unicode editing | AT-SPI actions / EditableText | AT-SPI actions / EditableText |
| Keyboard shortcuts | XTEST, foreground window only | Authorized RemoteDesktop Portal |
| Coordinate click, drag and scroll | XTEST, foreground window only | Authorized screen stream with logical dimensions |
| Explicit screenshot | Visible window rectangle | Latest PipeWire frame, or separate Screenshot Portal |

Use the exact `linux.<executable-hash>` identity returned by `computer_list_apps`
in the compatibility `bundleId` grant field. PID and observation IDs identify the
running instance. Ordinary sessions retain app grants and sensitive-action
confirmation; server YOLO preauthorizes those requests. Chromium HTML inputs may
lack AT-SPI EditableText: use browser DOM tools for web editing. Password text is
omitted from observations.

### Read less and verify the result

`computer_observe` defaults to `screenshot: "none"`. Its optional `scope` can select
an exact `windowTitle`, filter by `name` and `role`, or traverse a subtree using
`rootObservationId` and `rootElementIndex` from an observation owned by this agent.
`exact: false` enables case-insensitive name substring matching. Bound work with
`limit`, `maxDepth` and `maxScanNodes`. For example:

```json
{"app":{"pid":1234},"scope":{"name":"Save","role":"push button","limit":5}}
```

A name filter bounds returned rows but can still scan the tree; selecting a subtree
also reduces traversal. Results include visited/returned node counts, elapsed time
and cache status. Scope changes reset the delta base. Subsequent observations emit
changed rows, removed indexes and `baseObservationId`; use the new observation ID
with retained element indexes. Opaque handles belong to their original observation.
Request `full: true` after losing the base. Actions always revalidate fresh state.

Mutation tools accept `expect` and `timeoutMs`, for example
`"expect":{"name":"Saved","role":"label"}`. `computer_wait_for` accepts the same
predicate as `condition`. Predicates combine exact `name`/`role`, `value`, value
`contains`, `enabled`, `focused` and `exists` fields. Waits use accessibility events
with a bounded fallback read; the default is 10 seconds, maximum 30 seconds.
Absence cannot be established from a truncated tree. The result distinguishes
`satisfied` from `timeout`. Timeout does not establish that a submit failed and
never triggers an automatic action replay.

### Desktop control and recovery

Every action takes a desktop lease shared by DSCODE helpers for the same OS user
and display. `computer_control` with `operation: "acquire"` reserves control for a
multi-action sequence; `ttlMs` is 1,000–60,000 ms. Reacquiring renews it; `release` ends
it. Postcondition waits retain their action's lease. Reads remain available to
other agents. Expiry, helper exit and process crashes free control. Containers
controlling the same display must also share `/tmp/dscode-computer-<uid>`; separate
filesystem namespaces do not share a lease.

`/computer pause` revokes agent control on that desktop across Hosts; `/computer
resume` permits new leases. This does not lock out a person or other desktop
software. A dispatched action cannot be undone by pausing. When logind reports a
locked/inactive session, new input is refused. Session changes, helper restarts
and Portal reconnects invalidate old observations. Unknown session state is
reported as unknown, rather than asserted to be unlocked.

For an agent-only desktop on a Linux server, install `xvfb openbox dbus-x11 xauth`
in addition to the basic packages, then run:

```bash
dscode server --port 3000 --yolo --desktop
dscode desktop status
dscode desktop exec -- chromium --user-data-dir=/path/to/agent-profile
dscode desktop stop
```

`--desktop` starts an authenticated private Xvfb display, Openbox and a dedicated
session bus. `dscode server install --port 3000 --yolo --desktop` persists the option
in a Linux user service. `desktop start` can start it without a server. A supervisor
restarts the display/window manager after failure and changes its generation so
agents must reobserve. It does not replay tasks or restart application processes.
Stopping the server leaves the desktop running; stop it explicitly when finished.
A desktop is separate from the person's display, but shares the same OS account
and filesystem permissions. It is not a VM, container or separate security account.

### Wayland authorization and image coordinates

`/computer connect` requests a combined RemoteDesktop/ScreenCast session;
`/computer connect-keyboard` requests keyboard access only. OS consent still applies
in YOLO mode. Supported backends store and rotate private restore tokens under
`$XDG_STATE_HOME/dscode/computer-use/portal.json` (default `~/.local/state/...`).
`DSCODE_LINUX_COMPUTER_STATE` overrides that directory. Revocation/restart requires
reconnection. DSCODE never falls back to root, uinput or XWayland input.

Request `screenshot: "required"` and inspect its artifact with `read_image`.
Follow-up actions refresh structure without taking another screenshot. X11 images
include `captureFrame` in global screen coordinates. They show visible pixels,
including occluding windows; XTEST input requires the same observed window to stay
foreground.

**Wayland stream capture and pointer control are experimental:** the Portal
contracts are tested, but native desktop visual/input qualification remains
incomplete. See the verification record for the tested environments.

Wayland stream captures include `streamId`, image dimensions, `coordinateFrame`
(logical stream dimensions) and `frameAgeMs`. Use `scope.streamId` to select a
stream. Map image pixels into that stream's logical dimensions; send
`coordinateSpace: "stream"` and the exact `streamId` from the referenced screenshot.
Never add an AT-SPI window offset. Stream input addresses the desktop and requires
`allowAllApps` (provided by server YOLO). Missing logical dimensions disable pointer
mapping. A separate Screenshot Portal image has no action mapping. Capture keeps
only the latest frame and discards it when the stream closes. Cached frames are
reused for at most two seconds; an inactive source, including a completely static
desktop, can require a screen update or reconnect before another screenshot.
The first-frame deadline is three seconds.

The automated fixtures cover real GTK, Qt, Chromium, Electron, Mousepad and Thunar
applications, the actual Harness Host, private-desktop recovery and Portal lifecycle.
The benchmark measures scripted task success, traversal counts, backend bytes and
five-sample P95 latency; it does not measure model tokens or inference quality.
Native compositor and mixed-DPI coverage is tracked in the
[verification record](verification.md#linux-computer-use--2026-10-23-unreleased).

## Experimental Desktop adapter

The [combined Desktop package](browser-use.md#install-the-experimental-combined-desktop-package)
includes an experimental native adapter. It requires macOS 14 or later; the
packaged helper supports Apple Silicon and Intel. Other platforms keep the Host
available and report Computer Use as unsupported, without exposing its tools.

In a DSCODE session, load the `dscode-computer-use` skill before using native tools.
Loading the exact bundled skill activates app discovery, observation, click,
value entry, typing, keyboard, scrolling, dragging, advertised Accessibility
actions, bounded waits and sensitive-action confirmation. Native Standard
sessions do not receive this skill or its tools. A successful skill load is
restored from persisted session history; unloading the plugin removes its tools
from open agents, and reloading restores them where that history permits.

`/computer` or `/computer status` checks helper health and reports Accessibility
and Screen Recording permissions. A healthy helper can still report a missing
OS permission. It does not change those permissions or application grants.

The current qualification covers helper integrity and initialization, app
discovery, progressive activation, native session resume, Standard isolation,
denied unconfigured app access, and live-plugin unload/reload on Host versions
`0.2.0-rc.2` and `0.2.1-alpha.1`. The tested helper reported Accessibility denied.
**Reading application windows, screenshot capture and input actions have not yet
been qualified in the Desktop adapter.** Their presence in the tool catalog does
not establish that those operations work on your machine.

## Application and OS permissions

There are two independent permission layers:

- macOS Accessibility and Screen Recording govern the native process. Grant them
  through System Settings when you choose to permit these capabilities. Use
  `/computer` to recheck after changing permissions or restarting Desktop.
- DSCODE app read/control grants select which applications a session may use.
  Missing grants follow the session's approval policy. A rejected request stays
  rejected for that session and scope. With prompts disabled, missing grants are
  denied without a user dialog; full filesystem access does not grant app access.

The Desktop entry is `dscode-desktop-computer-use`. Its profile configuration can
grant exact bundle IDs. For example, this grants read access only to TextEdit:

```yaml
- id: dscode-desktop-computer-use
  config:
    allowAllApps: false
    observationTtlMs: 30000
    grants:
      - bundleId: com.apple.TextEdit
        read: true
        control: false
```

Restart Desktop after editing the profile configuration. `control: true` also
permits reading that app. Wildcard bundle IDs are rejected. Defaults grant no
applications and preserve the user's foreground app for both pointer and
keyboard input. The adapter uses the Host's configuration directly and does not
install the upstream plugin's retired Settings API or its old Web settings page.

## Observation and image evidence

Actions require a fresh observation ID. Element indices belong to that
observation; opaque target handles permit only validated, unambiguous rebinding.
Successful actions return fresh state. Sensitive actions require a one-use
confirmation tied to the app, observation and exact action; a changed target
requires fresh confirmation.

Screenshots are stored as workspace image artifacts. Use the Host's `read_image`
tool and an image-capable model to inspect the returned path. Missing model image
support is a separate limitation from Screen Recording permission. The Desktop
adapter does not require the separate upstream Vision Toolkit plugin.

The macOS terminal installation continues to use its existing `computer-use`
skill and upstream bundle. The Linux terminal integration is described above.
Desktop-specific activation, configuration and qualification do not change those
terminal integrations.
