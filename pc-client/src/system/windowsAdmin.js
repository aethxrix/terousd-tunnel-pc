const { execFile } = require("node:child_process");

function isElevated() {
  if (process.platform !== "win32") {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile("net.exe", ["session"], { windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

function restartAsAdmin(exePath, args = []) {
  const argumentList = Array.isArray(args) && args.length
    ? ` -ArgumentList ${args.map((arg) => `'${escapePs(arg)}'`).join(",")}`
    : "";
  const script = `Start-Process -FilePath '${escapePs(exePath)}'${argumentList} -Verb RunAs`;
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

function escapePs(value) {
  return String(value || "").replace(/'/g, "''");
}

module.exports = {
  isElevated,
  restartAsAdmin
};
