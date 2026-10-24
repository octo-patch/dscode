"""Bounded latest-frame PipeWire reader; never send a video stream to the model."""
import os
import time
import gi


class StreamCapture:
    def __init__(self, fd, node, properties):
        gi.require_version("Gst", "1.0")
        gi.require_version("GstVideo", "1.0")
        from gi.repository import Gst, GstVideo, GLib, GdkPixbuf
        Gst.init(None)
        self.Gst, self.Video, self.GLib, self.Pixbuf = Gst, GstVideo, GLib, GdkPixbuf
        self.fd, self.frame = fd, None
        self.pipeline = Gst.Pipeline.new(None)
        source = Gst.ElementFactory.make("pipewiresrc")
        convert = Gst.ElementFactory.make("videoconvert")
        caps = Gst.ElementFactory.make("capsfilter")
        self.sink = Gst.ElementFactory.make("appsink")
        if any(element is None for element in [source, convert, caps, self.sink]):
            raise RuntimeError("Install GStreamer PipeWire, base plugins and GstVideo introspection for stream capture.")
        source.set_property("fd", fd)
        if properties.get("pipewire-serial") is not None and source.find_property("target-object"):
            source.set_property("target-object", str(properties["pipewire-serial"]))
        else:
            source.set_property("path", str(node))
        caps.set_property("caps", Gst.Caps.from_string("video/x-raw,format=RGBA"))
        self.sink.set_property("max-buffers", 1)
        self.sink.set_property("drop", True)
        self.sink.set_property("sync", False)
        self.sink.set_property("async", False)
        for element in [source, convert, caps, self.sink]:
            self.pipeline.add(element)
        if not source.link(convert) or not convert.link(caps) or not caps.link(self.sink):
            raise RuntimeError("Could not link PipeWire capture pipeline.")
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            self.pipeline.set_state(Gst.State.NULL)
            raise RuntimeError("Could not start PipeWire capture.")

    def close(self):
        self.pipeline.set_state(self.Gst.State.NULL)
        self.frame = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def screenshot(self, destination):
        if self.fd is None:
            raise RuntimeError("The PipeWire capture is closed. Reconnect and reobserve.")
        error = self.pipeline.get_bus().pop_filtered(self.Gst.MessageType.ERROR | self.Gst.MessageType.EOS)
        if error:
            self.close()
            raise RuntimeError("The PipeWire stream ended. Reconnect and reobserve before acting.")
        # Some source removals pause rather than EOS on older PipeWire versions.
        # Bound reuse so a disconnected source cannot serve an image indefinitely.
        sample = self.sink.emit("try-pull-sample", 300 * self.Gst.MSECOND if self.frame else 3 * self.Gst.SECOND)
        if sample:
            info = self.Video.VideoInfo.new_from_caps(sample.get_caps())
            if not info or info.width <= 0 or info.height <= 0 or info.width * info.height > 16777216 or info.size > 134217728:
                raise RuntimeError("PipeWire frame exceeds capture limits.")
            buffer = sample.get_buffer()
            ok, mapped = buffer.map(self.Gst.MapFlags.READ)
            if not ok:
                raise RuntimeError("PipeWire frame is not CPU-readable.")
            try:
                data = self.GLib.Bytes.new(mapped.data)
            finally:
                buffer.unmap(mapped)
            self.frame = self.Pixbuf.Pixbuf.new_from_bytes(data, self.Pixbuf.Colorspace.RGB, True, 8, info.width, info.height, info.stride[0])
            self.captured_at = time.monotonic()
        if self.frame is None:
            error = self.pipeline.get_bus().pop_filtered(self.Gst.MessageType.ERROR)
            if error:
                message, _debug = error.parse_error()
                raise RuntimeError(f"PipeWire capture failed: {message.message}")
            raise RuntimeError("No PipeWire frame arrived within the capture deadline.")
        if time.monotonic() - self.captured_at > 2:
            self.close()
            raise RuntimeError("No fresh PipeWire frame for 2 seconds; the source may be static or disconnected. Reobserve after a screen update or reconnect.")
        ok, png = self.frame.save_to_bufferv("png", [], [])
        if not ok or len(png) > 33554432:
            raise RuntimeError("Encoded PipeWire screenshot exceeds 32 MiB.")
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(png)
        return {"path": destination, "width": self.frame.get_width(), "height": self.frame.get_height(),
                "frameAgeMs": round((time.monotonic() - self.captured_at) * 1000)}
