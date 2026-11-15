// Desktop shell for Skilandia: opens the built game (dist/) in its own window.
const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("node:path");

// The game is all WebGL. Chromium refuses WebGL on GPUs/drivers it has
// blocklisted (older laptops, some Intel/AMD drivers, VMs, remote desktop),
// which leaves only the HTML UI on screen. Use the GPU anyway, and fall back
// to software rendering (SwiftShader) if there is no usable GPU at all.
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");

// One copy of the game at a time; a second launch focuses the first window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    title: "Skilandia",
    backgroundColor: "#9cc4dc",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));

  // F11 toggles fullscreen; Ctrl+Shift+I opens dev tools for bug reports.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.control && input.shift && input.key.toLowerCase() === "i") {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Never navigate the game window away; open links in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
