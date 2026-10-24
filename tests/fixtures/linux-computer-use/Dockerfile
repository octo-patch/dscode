FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0 at-spi2-core \
    dbus-x11 xvfb openbox xdotool x11-utils xauth \
    gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-tools \
    chromium mousepad thunar python3-pyqt5 pipewire wireplumber \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/dscode-electron --no-audit --no-fund electron@45.0.0 \
    && node /opt/dscode-electron/node_modules/electron/install.js
ENV DISPLAY=:97 XDG_SESSION_TYPE=x11 NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge
WORKDIR /work
