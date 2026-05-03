const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("terousd", {
  state: () => ipcRenderer.invoke("app:state"),
  refreshConfig: () => ipcRenderer.invoke("config:refresh"),
  checkConfigUpdate: () => ipcRenderer.invoke("config:check-update"),
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  ensureEngine: () => ipcRenderer.invoke("engine:ensure"),
  restartAsAdmin: () => ipcRenderer.invoke("app:restart-admin"),
  connect: (selection) => ipcRenderer.invoke("tunnel:connect", selection),
  disconnect: () => ipcRenderer.invoke("tunnel:disconnect"),
  tunnelStatus: () => ipcRenderer.invoke("tunnel:status"),
  logsSince: (lastId) => ipcRenderer.invoke("logs:since", lastId),
  clearLogs: () => ipcRenderer.invoke("logs:clear")
});
