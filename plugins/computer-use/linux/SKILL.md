# Linux Computer Use

Use API/CLI and browser DOM tools when they can complete the task directly.
Call `computer_use_activate` to inspect actual desktop capabilities and load
the native tools. `computer_status` and `/computer status` are non-mutating.
An SSH shell or a running server alone does not establish a graphical session.

Select the exact application identity returned by `computer_list_apps`; Linux
identities use `linux.<executable-hash>` in the compatibility `bundleId` field.
Names must resolve uniquely. An application's PID and observation are required
to distinguish running instances. Follow ordinary app grants and approval policy;
`server --yolo` automatically approves app/action requests but cannot supply
missing system capabilities or bypass Portal consent.

## Observe and act

`computer_observe` defaults to `screenshot: "none"`. Prefer AT-SPI elements:
`computer_set_value` for editable text, `computer_perform_action` for an action
advertised on the element, or `computer_click` for an accessible button action.
Password text is omitted. Canvas/custom applications may expose little structure.
Request `screenshot: "required"` explicitly when pixels are needed, then inspect
the returned image with `read_image` and an image-capable model.

Observations are bounded. `elementsMode: "diff"` supplies changed elements and
removed indexes relative to `baseObservationId`. Retain unchanged rows, but use
the NEW observationId with elementIndex when acting. A targetHandle belongs only
to the exact observation that emitted it. Use `full: true` after context loss or
if the diff's base is unavailable. Never apply a delta to another application's
or session's state. Every action revalidates current state and returns an
observation; a timeout or missing visual change does not prove it had no effect.

X11 keyboard/coordinate input requires the exact observed window to be foreground.
It uses global desktop input and can race with a person; do not claim background
process targeting. Prefer accessibility actions while a person is using the
desktop. Window-relative coordinates refer to the observed window, NOT an
arbitrarily resized screenshot. X11 captures are clipped at desktop boundaries.
Their captureFrame identifies the captured screen rectangle; convert image
pixels using that frame and the image dimensions before issuing a
screen-coordinate action.

Use `scope` on `computer_observe` to select a windowTitle, name/role query, or a
subtree using rootObservationId + rootElementIndex. Bound limit, maxDepth and
maxScanNodes. Subtrees reduce traversal; filters alone may still scan many nodes.
Scope changes reset the delta base. Read metrics to identify expensive trees.

Use an action's `expect` predicate or `computer_wait_for` with `condition` to verify
an exact name/role, value/contains, exists, enabled or focused state. timeoutMs is
0–30000. Waits use accessibility events. A timeout is uncertain, not permission to
repeat a submit. Absence from a truncated tree cannot establish nonexistence.

Each action leases the desktop. For a multi-action sequence, use computer_control
acquire with ttlMs at most 60000, then release. Human /computer pause revokes agent
control across Hosts; /computer resume allows new leases. Observe again after
session, focus, Portal or helper changes. Locked/inactive sessions reject input.

On Wayland, use AT-SPI for advertised actions and editable text. Chromium HTML
fields may lack EditableText; prefer browser DOM tools. /computer connect requests
a Portal screen + keyboard + pointer session and may show OS consent; the user
command /computer connect-keyboard requests only keyboard access. Restore tokens
rotate. Never use root/uinput/XWayland as a fallback. Read explicit screenshots
with read_image. A stream image provides streamId and coordinateFrame: scale image
pixels to those logical dimensions and send coordinateSpace=stream plus that exact
streamId and observationId. Do not add window offsets. This requires allowAllApps
(server YOLO supplies it) and a foreground observed app. Screenshot Portal images
without a streamId cannot be coordinate targets. Reconnect after revocation; never
reuse an old image/stream identity. First-frame timeout is three seconds; cached
frames expire after two seconds without a new frame. A static source can therefore
report unavailable until it updates. Do not infer action failure from this.

For unattended Linux work, dscode server --yolo --desktop can own a private Xvfb
session. Launch apps with dscode desktop exec -- COMMAND. Display/WM recovery
invalidates observations and does not replay tasks or restart apps. Desktop
separation does not isolate filesystem/account permissions.

## Confirmation and recovery

Use `computer_confirm` immediately before a sensitive action, then repeat the
exact action with its one-use token and `sensitive: true`. YOLO automatically
answers this request; ordinary sessions retain their configured approval path.
Never replay an uncertain submit/send/delete. Reobserve after focus, target or
session changes. Cancellation stops the helper; reconnecting does not replay
input. A human can revoke Portal access independently of DSCODE's YOLO setting.
