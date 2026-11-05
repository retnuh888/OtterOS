const { app, BrowserWindow, session, ipcMain } = require("electron");
const path = require("path");

const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let windowRef = null;

function attachBrowserSession() {
  const guest = session.fromPartition("persist:otter-web");
  guest.setUserAgent(browserUserAgent);
  guest.setPermissionRequestHandler((_contents, permission, callback) => {
    const allowed = new Set(["media", "geolocation", "notifications", "fullscreen", "pointerLock", "clipboard-read", "clipboard-sanitized-write", "idle-detection", "midi", "midiSysex"]);
    callback(allowed.has(permission));
  });
}

function createWindow() {
  attachBrowserSession();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });
  windowRef = win;
  win.once("ready-to-show", () => {
    win.maximize();
    win.show();
  });
  win.loadURL(process.env.OTTER_URL || "http://127.0.0.1:41773/");
  win.on("closed", () => {
    windowRef = null;
  });
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (_attachEvent, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (contents.getType() === "webview" && /^https?:/i.test(url)) {
      contents.hostWebContents.send("otter-new-tab", url);
    }
    return { action: "deny" };
  });
});

ipcMain.handle("otter-capture", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  return win.webContents.capturePage().then((image) => image.toPNG().toString("base64"));
});

app.whenReady().then(() => {
  if (!gotLock) return;
  app.userAgentFallback = browserUserAgent;
  createWindow();
});

app.on("second-instance", () => {
  if (!windowRef) return;
  if (windowRef.isMinimized()) windowRef.restore();
  windowRef.focus();
  windowRef.reload();
});

app.on("before-quit", () => {
  try { session.defaultSession.flushStorageData(); } catch (error) {}
});

app.on("window-all-closed", () => {
  app.quit();
});
