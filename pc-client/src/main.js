const { app, BrowserWindow, ipcMain, Menu, Tray } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const ConfigRepository = require("./config/repository");
const SingBoxManager = require("./engine/singBoxManager");
const { isElevated, restartAsAdmin } = require("./system/windowsAdmin");
const UsageReporter = require("./usage/reporter");

let mainWindow;
let tray;
let repository;
let engine;
let usageReporter;
let forceQuit = false;
let usageConfirmTimer = null;
let usageHeartbeatTimer = null;
let usageConnectionConfirmed = false;
let showRequestTimer = null;
let lastShowRequestToken = "";

const USAGE_CONNECTED_CONFIRM_MS = 60 * 1000;
const USAGE_CONNECTED_HEARTBEAT_MS = 10 * 60 * 1000;
const SHOW_REQUEST_POLL_MS = 700;

if (process.platform === "win32") {
  app.setAppUserModelId("com.terousd.tunnel.pc");
}

let singleInstanceLock = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: "#101314",
    title: "Terousd Tunnel PC",
    icon: path.join(__dirname, "..", "assets", "terousd-logo.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "ui", "index.html")).catch((error) => {
    showStartupError(error);
  });
  mainWindow.on("close", (event) => {
    if (forceQuit) {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });
}

app.whenReady().then(async () => {
  if (process.platform === "win32" && !shouldSkipAdminForDev() && !await isElevated()) {
    if (await signalExistingInstance()) {
      app.exit(0);
      return;
    }
    try {
      await restartAsAdmin(adminLaunchPath(), ["--show"]);
    } catch {
      // If UAC is cancelled, close this non-elevated instance.
    }
    app.exit(0);
    return;
  }

  singleInstanceLock = app.requestSingleInstanceLock();
  if (!singleInstanceLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => showMainWindow());

  repository = new ConfigRepository(app);
  engine = new SingBoxManager(app);
  usageReporter = new UsageReporter(app);
  await engine.repairSystemState().catch(() => {});
  registerIpc();
  createTray();
  createWindow();
  startShowRequestWatcher();
});

app.on("activate", () => {
  if (mainWindow) {
    showMainWindow();
  } else {
    createWindow();
  }
});

app.on("window-all-closed", () => {
  // Keep the tunnel alive in the background after the window is closed.
});

app.on("before-quit", () => {
  forceQuit = true;
  stopShowRequestWatcher();
});

function createTray() {
  if (tray) {
    return;
  }
  const iconPath = path.join(__dirname, "..", "assets", "terousd-logo.ico");
  tray = new Tray(iconPath);
  tray.setToolTip("Terousd Tunnel PC");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show", click: () => showMainWindow() },
    {
      label: "Quit",
      click: async () => {
        forceQuit = true;
        reportUsageDisconnected();
        try {
          await engine.stop();
        } catch {
          // Quit should continue even if cleanup has already happened.
        }
        app.quit();
      }
    }
  ]));
  tray.on("double-click", () => showMainWindow());
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

async function signalExistingInstance() {
  const token = `${Date.now()}-${Math.random()}`;
  const requestFile = showRequestFile();
  const ackFile = showAckFile();
  try {
    await fs.mkdir(path.dirname(requestFile), { recursive: true });
    await fs.writeFile(requestFile, JSON.stringify({ token, at: Date.now() }), "utf8");
  } catch {
    return false;
  }

  const deadline = Date.now() + 900;
  while (Date.now() < deadline) {
    await delay(90);
    try {
      const ack = JSON.parse(await fs.readFile(ackFile, "utf8"));
      if (ack && ack.token === token) {
        return true;
      }
    } catch {
      // No running elevated instance answered yet.
    }
  }
  return false;
}

function startShowRequestWatcher() {
  stopShowRequestWatcher();
  showRequestTimer = setInterval(readShowRequest, SHOW_REQUEST_POLL_MS);
  readShowRequest();
}

function stopShowRequestWatcher() {
  if (showRequestTimer) {
    clearInterval(showRequestTimer);
    showRequestTimer = null;
  }
}

async function readShowRequest() {
  try {
    const request = JSON.parse(await fs.readFile(showRequestFile(), "utf8"));
    if (!request || !request.token || request.token === lastShowRequestToken) {
      return;
    }
    lastShowRequestToken = request.token;
    showMainWindow();
    await fs.writeFile(showAckFile(), JSON.stringify({ token: request.token, at: Date.now() }), "utf8");
  } catch {
    // Showing from a second launch is best effort.
  }
}

function showRequestFile() {
  return path.join(app.getPath("userData"), "show-request.json");
}

function showAckFile() {
  return path.join(app.getPath("userData"), "show-ack.json");
}

function adminLaunchPath() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return process.env.PORTABLE_EXECUTABLE_FILE;
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR && process.env.PORTABLE_EXECUTABLE_APP_FILENAME) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, process.env.PORTABLE_EXECUTABLE_APP_FILENAME);
  }
  return app.getPath("exe");
}

function shouldSkipAdminForDev() {
  return process.defaultApp && process.env.TEROUSD_SKIP_ADMIN === "1";
}

function showStartupError(error) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const message = escapeHtml(error && error.message ? error.message : String(error || "Unknown error"));
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Terousd Tunnel PC</title>
        <style>
          body { margin: 0; background: #101314; color: #eef6f4; font: 15px "Segoe UI", Arial, sans-serif; }
          main { max-width: 680px; padding: 32px; }
          h1 { margin: 0 0 12px; font-size: 22px; }
          p { color: #cfe0dc; line-height: 1.5; }
          code { display: block; margin-top: 16px; padding: 12px; background: #0c0f10; border: 1px solid #314043; border-radius: 6px; white-space: pre-wrap; }
        </style>
      </head>
      <body>
        <main>
          <h1>Terousd Tunnel PC could not load</h1>
          <p>Close the app from the tray, then open the Desktop shortcut again.</p>
          <code>${message}</code>
        </main>
      </body>
    </html>
  `)}`).catch(() => {});
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function registerIpc() {
  ipcMain.handle("app:state", async () => ({
    platform: process.platform,
    appVersion: app.getVersion(),
    tunnel: engine.status()
  }));

  ipcMain.handle("config:refresh", async () => {
    const result = await repository.refresh();
    usageReporter.recordConfigDownload(result.version).catch(() => {});
    return result;
  });
  ipcMain.handle("config:check-update", async () => repository.checkForUpdate());
  ipcMain.handle("profiles:list", async () => repository.listForUi());
  ipcMain.handle("engine:ensure", async () => engine.ensureEngine());
  ipcMain.handle("app:restart-admin", async () => {
    await restartAsAdmin(adminLaunchPath());
    app.quit();
    return true;
  });

  ipcMain.handle("tunnel:connect", async (_event, selection) => {
    engine.clearLogs();
    const candidates = await repository.composeProfileCandidates(selection.serverId, selection.bugHostId);
    if (!candidates.length) {
      throw new Error("Choose a server first.");
    }
    let lastError = null;
    let composed = null;
    let status = null;
    for (let index = 0; index < candidates.length; index += 1) {
      composed = candidates[index];
      if (index > 0) {
        engine.log("info", `Trying backup server: ${composed.server?.name || composed.profile.name || "Proxy"}.`);
      }
      try {
        status = await engine.start(composed.profile);
        break;
      } catch (error) {
        lastError = error;
        if (error.requiresAdmin) {
          throw error;
        }
        await engine.stop().catch(() => {});
        if (index < candidates.length - 1) {
          engine.log("error", `${error.message || String(error)} Switching server.`);
          continue;
        }
      }
    }
    if (!status) {
      throw lastError || new Error("Connection failed.");
    }
    scheduleUsageConnected();
    return { ...status, selection: composed };
  });

  ipcMain.handle("tunnel:disconnect", async () => {
    reportUsageDisconnected();
    const status = await engine.stop();
    return status;
  });
  ipcMain.handle("tunnel:status", async () => engine.status());
  ipcMain.handle("logs:since", async (_event, lastId) => engine.logsSince(lastId));
  ipcMain.handle("logs:clear", async () => {
    engine.clearLogs();
    return true;
  });
}

function scheduleUsageConnected() {
  stopUsageHeartbeat();
  usageConnectionConfirmed = false;
  usageConfirmTimer = setTimeout(() => {
    usageConfirmTimer = null;
    if (!isTunnelRunning()) {
      return;
    }
    usageConnectionConfirmed = true;
    usageReporter.recordConnected(true).catch(() => {});
    usageHeartbeatTimer = setInterval(() => {
      if (!isTunnelRunning()) {
        reportUsageDisconnected();
        return;
      }
      usageReporter.recordConnected(true).catch(() => {});
    }, USAGE_CONNECTED_HEARTBEAT_MS);
  }, USAGE_CONNECTED_CONFIRM_MS);
}

function stopUsageHeartbeat() {
  if (usageConfirmTimer) {
    clearTimeout(usageConfirmTimer);
    usageConfirmTimer = null;
  }
  if (usageHeartbeatTimer) {
    clearInterval(usageHeartbeatTimer);
    usageHeartbeatTimer = null;
  }
}

function reportUsageDisconnected() {
  const shouldReport = usageConnectionConfirmed;
  stopUsageHeartbeat();
  usageConnectionConfirmed = false;
  if (shouldReport) {
    usageReporter.recordConnected(false).catch(() => {});
  }
}

function isTunnelRunning() {
  return !!(engine && engine.status().running);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
