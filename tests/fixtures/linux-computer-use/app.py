import os
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib

window = Gtk.Window(title="DSCODE Linux Fixture")
if os.environ.get("DSCODE_WAYLAND_FIXTURE"):
    window.set_decorated(False)
window.set_default_size(480, 260)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
entry = Gtk.Entry()
entry.get_accessible().set_name("Fixture input")
button = Gtk.Button(label="Apply fixture")
label = Gtk.Label(label="Waiting")
password = Gtk.Entry()
password.set_visibility(False)
password.set_text("fixture-secret-must-not-appear")
delayed = Gtk.Button(label="Delayed fixture")
delayed.connect("clicked", lambda *_: GLib.timeout_add(200, lambda: (label.set_text("Delayed complete"), False)[1]))
for widget in [entry, button, label, password, delayed]:
    box.pack_start(widget, False, False, 0)
window.add(box)
button.connect("clicked", lambda *_: label.set_text("Applied: " + entry.get_text()))
window.connect("destroy", Gtk.main_quit)
window.show_all()
if os.environ.get("DSCODE_WAYLAND_FIXTURE"):
    window.fullscreen()
window.present()
if os.environ.get("DSCODE_WAYLAND_FIXTURE"):
    # KWin's virtual output is damage-driven; give the screencast real repaints.
    import time
    animation = Gtk.DrawingArea()
    animation.set_size_request(20, 10)
    def draw(_widget, context):
        context.set_source_rgb((time.monotonic() % 1), 0.5, 0.5)
        context.paint()
    animation.connect("draw", draw)
    box.pack_start(animation, False, False, 0)
    animation.show()
    GLib.timeout_add(100, lambda: (animation.queue_draw(), True)[1])
if os.environ.get("DSCODE_LARGE_FIXTURE"):
    large = Gtk.Window(title="Large fixture")
    rows = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    for i in range(300):
        rows.add(Gtk.Label(label=f"Unrelated row {i}"))
    large.add(rows)
    large.show_all()
    window.present()
GLib.timeout_add(1000, lambda: (open("/tmp/dscode-gtk-ready", "w").write(str(os.getpid())), False)[1])
Gtk.main()
