const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("otterDesktop", {
  onNewTab(callback) {
    ipcRenderer.on("otter-new-tab", (_event, url) => callback(url));
  },
  capture() {
    return ipcRenderer.invoke("otter-capture");
  }
});
