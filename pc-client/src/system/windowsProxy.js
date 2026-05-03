const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");

const INTERNET_SETTINGS = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

async function restoreProxy(backupFile) {
  assertWindows();
  let backup;
  try {
    backup = JSON.parse(await fs.readFile(backupFile, "utf8"));
  } catch {
    return;
  }

  const proxyEnable = Number(backup.ProxyEnable || 0) ? 1 : 0;
  const proxyServer = escapePs(backup.ProxyServer || "");
  const proxyOverride = escapePs(backup.ProxyOverride || "");
  await runPowerShell(`
    Set-ItemProperty -Path '${INTERNET_SETTINGS}' -Name ProxyEnable -Type DWord -Value ${proxyEnable}
    Set-ItemProperty -Path '${INTERNET_SETTINGS}' -Name ProxyServer -Type String -Value '${proxyServer}'
    Set-ItemProperty -Path '${INTERNET_SETTINGS}' -Name ProxyOverride -Type String -Value '${proxyOverride}'
    ${notifyProxyChangedScript()}
  `);
  await fs.rm(backupFile, { force: true });
}

function notifyProxyChangedScript() {
  return `
    Add-Type -Namespace Native -Name WinInet -MemberDefinition @'
      [System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError = true)]
      public static extern bool InternetSetOption(System.IntPtr hInternet, int dwOption, System.IntPtr lpBuffer, int dwBufferLength);
'@
    [Native.WinInet]::InternetSetOption([System.IntPtr]::Zero, 39, [System.IntPtr]::Zero, 0) | Out-Null
    [Native.WinInet]::InternetSetOption([System.IntPtr]::Zero, 37, [System.IntPtr]::Zero, 0) | Out-Null
  `;
}

function runPowerShell(script) {
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
        resolve(String(stdout || "").trim());
      }
    );
  });
}

function escapePs(value) {
  return String(value || "").replace(/'/g, "''");
}

function assertWindows() {
  if (process.platform !== "win32") {
    throw new Error("Windows proxy control is only available on Windows.");
  }
}

module.exports = {
  restoreProxy
};
