const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.commandLine.appendSwitch('force-renderer-accessibility');
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  app.setAccessibilitySupportEnabled(true);
  const window = new BrowserWindow({ width: 800, height: 600, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.loadFile(path.join(__dirname, 'page.html'));
});
app.on('window-all-closed', () => app.quit());
