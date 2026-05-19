const { execFile } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");

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

async function backupDns(backupFile) {
  assertWindows();
  if (!backupFile) {
    return;
  }
  try {
    await fs.access(backupFile);
    return;
  } catch {
    // Keep the first backup from a tunnel session so repair can restore the
    // user's original DNS even if the app restarts while Windows is poisoned.
  }

  const script = `
    $items = @()
    $adapters = Get-NetAdapter -ErrorAction SilentlyContinue |
      Where-Object { $_.Status -eq 'Up' -and $_.InterfaceAlias -and $_.InterfaceAlias -notlike 'TerousdTun*' -and $_.InterfaceAlias -notlike 'Loopback*' }
    foreach ($adapter in $adapters) {
      $dnsRows = Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue
      foreach ($dns in $dnsRows) {
        $items += [pscustomobject]@{
          interfaceAlias = $adapter.InterfaceAlias
          interfaceIndex = $adapter.ifIndex
          addressFamily = $dns.AddressFamily
          serverAddresses = @($dns.ServerAddresses)
        }
      }
    }
    $items | ConvertTo-Json -Compress -Depth 5
  `;
  const stdout = await runPowerShell(script);
  const parsed = parseJsonArray(stdout);
  await fs.mkdir(path.dirname(backupFile), { recursive: true });
  await fs.writeFile(backupFile, JSON.stringify({
    createdAt: new Date().toISOString(),
    adapters: parsed
  }, null, 2), "utf8");
}

async function restoreDns(backupFile) {
  assertWindows();
  if (!backupFile) {
    return;
  }
  let backup;
  try {
    backup = JSON.parse(await fs.readFile(backupFile, "utf8"));
  } catch {
    await cleanupTunnelNetworkState().catch(() => {});
    await flushDns().catch(() => {});
    await fs.rm(backupFile, { force: true }).catch(() => {});
    return;
  }

  const adapters = Array.isArray(backup?.adapters) ? backup.adapters : [];
  const payload = escapePs(JSON.stringify(adapters));
  await runPowerShell(`
    $items = '${payload}' | ConvertFrom-Json
    if ($null -eq $items) { $items = @() }
    if ($items -isnot [System.Array]) { $items = @($items) }
    foreach ($group in ($items | Group-Object interfaceIndex)) {
      $item = @($group.Group)[0]
      $index = [int]$item.interfaceIndex
      $addresses = @($group.Group | ForEach-Object { @($_.serverAddresses) } | Where-Object { $_ })
      $adapter = Get-NetAdapter -InterfaceIndex $index -ErrorAction SilentlyContinue
      if (-not $adapter -and $item.interfaceAlias) {
        $adapter = Get-NetAdapter -InterfaceAlias $item.interfaceAlias -ErrorAction SilentlyContinue
      }
      if (-not $adapter) { continue }
      try {
        if ($addresses.Count -gt 0) {
          Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ServerAddresses $addresses -ErrorAction Stop
        } else {
          Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ResetServerAddresses -ErrorAction Stop
        }
      } catch {
        try {
          Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ResetServerAddresses -ErrorAction SilentlyContinue
        } catch {}
      }
    }
  `);
  await cleanupTunnelNetworkState().catch(() => {});
  await flushDns().catch(() => {});
  await fs.rm(backupFile, { force: true });
}

async function cleanupTunnelNetworkState() {
  assertWindows();
  const script = `
    $tunAdapters = Get-NetAdapter -ErrorAction SilentlyContinue |
      Where-Object { $_.InterfaceAlias -like 'TerousdTun*' }
    foreach ($adapter in $tunAdapters) {
      Get-NetRoute -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue |
        Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
      Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ResetServerAddresses -ErrorAction SilentlyContinue
      Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -InterfaceMetric 9999 -ErrorAction SilentlyContinue
    }
  `;
  await runPowerShell(script);
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

function parseJsonArray(value) {
  if (!String(value || "").trim()) {
    return [];
  }
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [parsed];
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
  backupDns,
  cleanupTunnelNetworkState,
  cleanupOrphanEngines,
  flushDns,
  prepareForTunnel,
  restoreDns,
  waitForDefaultInterface,
  waitForProxyPort
};
