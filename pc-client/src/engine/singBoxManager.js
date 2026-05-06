const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { buildSingBoxTunConfig } = require("./singBoxConfig");
const { isElevated } = require("../system/windowsAdmin");
const windowsNetwork = require("../system/windowsNetwork");
const windowsProxy = require("../system/windowsProxy");

const SING_BOX_RELEASE_API = "https://api.github.com/repos/SagerNet/sing-box/releases/latest";

class SingBoxManager {
  constructor(app) {
    this.dataDir = app.getPath("userData");
    this.engineDir = path.join(this.dataDir, "engines", "sing-box");
    this.runtimeDir = path.join(this.dataDir, "runtime");
    this.proxyBackupFile = path.join(this.dataDir, "windows-proxy-backup.json");
    this.process = null;
    this.requestedProfile = null;
    this.runningProfile = null;
    this.runningNetwork = null;
    this.startedAt = 0;
    this.lastError = "";
    this.stopping = false;
    this.restartAttempts = 0;
    this.logs = [];
    this.nextLogId = 1;
  }

  async ensureEngine() {
    const local = path.join(this.engineDir, "sing-box.exe");
    if (await fileExists(local)) {
      this.log("info", "TUN engine is ready.");
      return { ready: true, path: local, source: "local" };
    }

    const onPath = await findOnPath("sing-box.exe");
    if (onPath) {
      this.log("info", "Using sing-box from PATH.");
      return { ready: true, path: onPath, source: "path" };
    }

    this.log("info", "Downloading TUN engine.");
    await this.downloadSingBox(local);
    this.log("info", "TUN engine installed.");
    return { ready: true, path: local, source: "download" };
  }

  async repairSystemState() {
    await windowsNetwork.cleanupOrphanEngines(this.engineDir);
    await windowsProxy.restoreProxy(this.proxyBackupFile).catch(() => {});
    await windowsNetwork.flushDns().catch(() => {});
  }

  async start(profile) {
    if (process.platform !== "win32") {
      throw new Error("Full VPN mode is only available on Windows.");
    }
    if (!await isElevated()) {
      const error = new Error("Full VPN mode needs administrator permission.");
      error.requiresAdmin = true;
      throw error;
    }
    if (this.process) {
      await this.stop();
    }

    this.requestedProfile = profile;
    this.restartAttempts = 0;
    this.lastError = "";
    await this.repairSystemState();
    this.log("info", "Checking Windows network.");
    const network = await windowsNetwork.prepareForTunnel(profile);
    this.runningNetwork = network;
    if (network.defaultInterface) {
      this.log("info", `Using network adapter: ${network.defaultInterface}.`);
    }
    const engine = await this.ensureEngine();
    try {
      return await this.startProcess(engine.path, profile, optionsWithNetwork(primaryTunOptions(), network));
    } catch (error) {
      this.log("error", `${error.message || String(error)} Retrying with compatibility mode.`);
      await this.cleanupExitedProcess();
      return this.startProcess(engine.path, profile, optionsWithNetwork(fallbackTunOptions(), network));
    }
  }

  async startProcess(enginePath, profile, tunOptions) {
    const config = buildSingBoxTunConfig(profile, tunOptions);
    await fs.mkdir(this.runtimeDir, { recursive: true });
    const configPath = path.join(this.runtimeDir, "sing-box-tun.json");
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    await checkConfig(enginePath, configPath);

    this.log("info", "Starting full VPN mode.");
    const child = spawn(enginePath, ["run", "-c", configPath], {
      cwd: path.dirname(enginePath),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.process = child;
    this.runningProfile = {
      id: profile.id,
      name: profile.name || "Proxy",
      mode: "tun"
    };
    this.startedAt = Date.now();

    child.stdout.on("data", (data) => this.log("core", cleanLog(data)));
    child.stderr.on("data", (data) => this.log("core", cleanLog(data)));
    child.on("exit", (code, signal) => {
      const ranForMs = this.startedAt ? Date.now() - this.startedAt : 0;
      const message = this.stopping
        ? "Full VPN mode stopped."
        : `TUN engine exited${code == null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`;
      const shouldRestart = !this.stopping && this.requestedProfile && ranForMs > 5000;
      this.log(this.stopping ? "info" : "error", message);
      if (this.process === child) {
        this.process = null;
        this.runningProfile = null;
        if (!shouldRestart) {
          this.runningNetwork = null;
        }
        this.startedAt = 0;
      }
      if (shouldRestart) {
        this.restartAfterUnexpectedExit(enginePath, this.requestedProfile);
      }
    });

    await delay(2200);
    if (!this.process || child.exitCode !== null) {
      throw new Error("TUN engine exited before the tunnel was ready.");
    }

    this.log("info", "Full VPN mode enabled.");
    return this.status();
  }

  async stop() {
    this.stopping = true;
    this.requestedProfile = null;
    const child = this.process;
    if (child) {
      this.log("info", "Stopping full VPN mode.");
      child.kill();
      await waitForExit(child, 3500);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
    this.process = null;
    this.runningProfile = null;
    this.runningNetwork = null;
    this.startedAt = 0;
    await windowsNetwork.flushDns().catch(() => {});
    this.stopping = false;
    return this.status();
  }

  async cleanupExitedProcess() {
    const child = this.process;
    if (child && child.exitCode === null) {
      child.kill();
      await waitForExit(child, 1200);
    }
    this.process = null;
    this.runningProfile = null;
    this.runningNetwork = null;
    this.startedAt = 0;
  }

  restartAfterUnexpectedExit(enginePath, profile) {
    if (this.restartAttempts >= 2) {
      this.log("error", "TUN engine stopped repeatedly. Please press START again.");
      this.requestedProfile = null;
      return;
    }
    this.restartAttempts += 1;
    const attempt = this.restartAttempts;
    this.log("info", `Restarting TUN engine (${attempt}/2).`);
    setTimeout(() => {
      if (this.stopping || this.process || !this.requestedProfile) {
        return;
      }
      const options = optionsWithNetwork(
        attempt === 1 ? fallbackTunOptions() : lastResortTunOptions(),
        this.runningNetwork || {}
      );
      this.startProcess(enginePath, profile, options).catch((error) => {
        this.log("error", `TUN restart failed: ${error.message || String(error)}`);
        this.restartAfterUnexpectedExit(enginePath, profile);
      });
    }, 1500);
  }

  status() {
    return {
      running: !!this.process,
      profile: this.runningProfile,
      startedAt: this.startedAt,
      lastError: this.lastError,
      network: this.runningNetwork,
      ports: { tun: "TerousdTun" }
    };
  }

  logsSince(id = 0) {
    return this.logs.filter((item) => item.id > Number(id || 0));
  }

  clearLogs() {
    this.logs = [];
    this.nextLogId = 1;
  }

  async openEngineFolder() {
    await fs.mkdir(this.engineDir, { recursive: true });
    return this.engineDir;
  }

  async downloadSingBox(localPath) {
    await fs.rm(this.engineDir, { recursive: true, force: true });
    await fs.mkdir(this.engineDir, { recursive: true });
    const releaseResponse = await fetch(SING_BOX_RELEASE_API, {
      headers: { "User-Agent": "Terousd-Tunnel-PC" }
    });
    if (!releaseResponse.ok) {
      throw new Error(`Could not read sing-box release metadata (${releaseResponse.status}).`);
    }
    const release = await releaseResponse.json();
    const asset = (release.assets || []).find((item) => /windows-amd64\.zip$/i.test(item.name));
    if (!asset || !asset.browser_download_url) {
      throw new Error("Could not find a Windows amd64 sing-box release asset.");
    }

    const zipPath = path.join(this.engineDir, "sing-box.zip");
    await downloadFile(asset.browser_download_url, zipPath);
    await expandZip(zipPath, this.engineDir);
    await fs.rm(zipPath, { force: true });

    const extracted = await findExecutable(this.engineDir, "sing-box.exe");
    if (!extracted) {
      throw new Error("sing-box download completed, but sing-box.exe was not found.");
    }
    if (extracted !== localPath) {
      await fs.copyFile(extracted, localPath);
    }
  }

  log(level, message) {
    const lines = cleanLog(message).split(/\n+/).map((line) => line.trim()).filter(Boolean);
    for (const clean of lines) {
      if (!shouldStoreLog(level, clean)) {
        continue;
      }
      this.logs.push({
        id: this.nextLogId++,
        at: new Date().toISOString(),
        level,
        message: clean
      });
      if (this.logs.length > 250) {
        this.logs.splice(0, this.logs.length - 250);
      }
    }
  }
}

function shouldStoreLog(level, message) {
  if (level !== "core") {
    return true;
  }
  const lower = message.toLowerCase();
  if (lower.includes("accepted")
      || lower.includes("from 127.0.0.1")
      || lower.includes("dns query")
      || lower.includes("dns: exchange failed")
      || lower.includes("process dns packet")
      || lower.includes("udp is not supported by outbound")
      || lower.includes("inbound/")
      || lower.includes("outbound/")) {
    return false;
  }
  return lower.includes("error")
    || lower.includes("failed")
    || lower.includes("refused")
    || lower.includes("timeout")
    || lower.includes("warn")
    || lower.includes("fatal");
}

function downloadFile(url, target) {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Terousd-Tunnel-PC" }
      });
      if (!response.ok || !response.body) {
        reject(new Error(`Download failed (${response.status}).`));
        return;
      }
      const file = await fs.open(target, "w");
      const stream = file.createWriteStream();
      stream.on("error", reject);
      stream.on("finish", async () => {
        await file.close();
        resolve();
      });
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          stream.end();
          break;
        }
        stream.write(Buffer.from(value));
      }
    } catch (error) {
      reject(error);
    }
  });
}

function expandZip(zipPath, destination) {
  const script = `Expand-Archive -LiteralPath '${escapePs(zipPath)}' -DestinationPath '${escapePs(destination)}' -Force`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || "").trim()));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function findOnPath(executable) {
  return new Promise((resolve) => {
    execFile("where.exe", [executable], { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }
      resolve(String(stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "");
    });
  });
}

async function findExecutable(root, executable) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === executable.toLowerCase()) {
      return candidate;
    }
    if (entry.isDirectory()) {
      const found = await findExecutable(candidate, executable);
      if (found) {
        return found;
      }
    }
  }
  return "";
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function checkConfig(enginePath, configPath) {
  return new Promise((resolve, reject) => {
    execFile(
      enginePath,
      ["check", "-c", configPath],
      { cwd: path.dirname(enginePath), windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`TUN config check failed: ${cleanLog(stderr || stdout || error.message)}`));
          return;
        }
        resolve();
      }
    );
  });
}

function primaryTunOptions() {
  return {
    interfaceName: "TerousdTun",
    strictRoute: true,
    stack: "gvisor"
  };
}

function fallbackTunOptions() {
  return {
    interfaceName: "TerousdTun",
    strictRoute: false,
    stack: "mixed"
  };
}

function lastResortTunOptions() {
  return {
    interfaceName: "TerousdTun2",
    strictRoute: false,
    stack: "system"
  };
}

function optionsWithNetwork(options, network = {}) {
  return {
    ...options,
    defaultInterface: network.defaultInterface || ""
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanLog(data) {
  return String(data || "")
    .replace(/\r/g, "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
}

function escapePs(value) {
  return String(value || "").replace(/'/g, "''");
}

module.exports = SingBoxManager;
