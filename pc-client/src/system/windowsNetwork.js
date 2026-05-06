const { execFile } = require("node:child_process");
const net = require("node:net");

const NETWORK_READY_TIMEOUT_MS = 25 * 1000;
const PROXY_READY_TIMEOUT_MS = 7 * 1000;
const TCP_CHECK_TIMEOUT_MS = 2500;
const RETRY_DELAY_MS = 900;

async function prepareForTunnel(profile) {
  assertWindows();
  const defaultInterface = await waitForDefaultInterface();
  await waitForProxyPort(profile);
  await flushDns().catch(() => {});
  return { defaultInterface };
}

async function cleanupOrphanEngines(engineDir) {
  assertWindows();
  const normalized = String(engineDir || "").trim();
  if (!normalized) {
    return;
  }
  const script = `
    $engineDir = '${escapePs(normalized)}'
    Get-CimInstance Win32_Process -Filter "Name = 'sing-box.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($engineDir, [System.StringComparison]::OrdinalIgnoreCase)) -or
        ($_.CommandLine -and $_.CommandLine.IndexOf($engineDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
      } |
      ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
  `;
  await runPowerShell(script).catch(() => {});
}

async function waitForDefaultInterface(timeoutMs = NETWORK_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const found = await readDefaultInterface();
      if (found) {
        return found;
      }
    } catch (error) {
      lastError = error.message || String(error);
    }
    await delay(RETRY_DELAY_MS);
  }
  throw new Error(lastError || "Windows network is not ready yet. Wait a few seconds after reboot, then press START again.");
}

function readDefaultInterface() {
  const script = `
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.InterfaceAlias -and $_.InterfaceAlias -notlike 'TerousdTun*' -and $_.InterfaceAlias -notlike 'Loopback*' } |
      Sort-Object RouteMetric, InterfaceMetric |
      Select-Object -First 1
    if (-not $route) { exit 2 }
    $adapter = Get-NetAdapter -InterfaceIndex $route.ifIndex -ErrorAction SilentlyContinue
    if (-not $adapter -or $adapter.Status -ne 'Up') { exit 3 }
    [pscustomobject]@{
      interfaceAlias = $route.InterfaceAlias
      interfaceIndex = $route.ifIndex
      nextHop = $route.NextHop
    } | ConvertTo-Json -Compress
  `;
  return runPowerShell(script).then((stdout) => {
    const parsed = JSON.parse(stdout);
    return String(parsed.interfaceAlias || "").trim();
  }).catch((error) => {
    if (error.code === 2 || error.code === 3) {
      return "";
    }
    throw error;
  });
}

async function waitForProxyPort(profile, timeoutMs = PROXY_READY_TIMEOUT_MS) {
  const host = String(profile?.host || profile?.bugHost || profile?.remoteProxyHost || "").trim();
  const port = Number.parseInt(String(profile?.port || profile?.remoteProxyPort || ""), 10);
  if (!host || !Number.isFinite(port) || port <= 0) {
    throw new Error("Proxy profile is missing host or port.");
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      await checkTcp(host, port);
      return;
    } catch (error) {
      lastError = error.message || String(error);
      await delay(RETRY_DELAY_MS);
    }
  }
  throw new Error(`Proxy server is not reachable yet (${host}:${port}). Check internet, then press START again.${lastError ? ` ${lastError}` : ""}`);
}

function checkTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const finish = (error) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    socket.setTimeout(TCP_CHECK_TIMEOUT_MS);
    socket.once("connect", () => finish());
    socket.once("timeout", () => finish(new Error("TCP connection timed out.")));
    socket.once("error", finish);
  });
}

function flushDns() {
  return new Promise((resolve) => {
    execFile("ipconfig.exe", ["/flushdns"], { windowsHide: true }, () => resolve());
  });
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error((stderr || error.message || "").trim());
          wrapped.code = error.code;
          reject(wrapped);
          return;
        }
        resolve(String(stdout || "").trim());
      }
    );
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapePs(value) {
  return String(value || "").replace(/'/g, "''");
}

function assertWindows() {
  if (process.platform !== "win32") {
    throw new Error("Windows network preparation is only available on Windows.");
  }
}

module.exports = {
  cleanupOrphanEngines,
  flushDns,
  prepareForTunnel,
  waitForDefaultInterface,
  waitForProxyPort
};
