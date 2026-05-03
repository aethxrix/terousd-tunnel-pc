const api = window.terousd;

const elements = {
  configVersion: document.querySelector("#configVersion"),
  engineBadge: document.querySelector("#engineBadge"),
  statusBadge: document.querySelector("#statusBadge"),
  connectButton: document.querySelector("#connectButton"),
  duration: document.querySelector("#duration"),
  serverSelect: document.querySelector("#serverSelect"),
  bugHostSelect: document.querySelector("#bugHostSelect"),
  refreshButton: document.querySelector("#refreshButton"),
  selectedName: document.querySelector("#selectedName"),
  profileCount: document.querySelector("#profileCount"),
  noticeBox: document.querySelector("#noticeBox"),
  logBox: document.querySelector("#logBox")
};

let profiles = {
  version: 0,
  servers: [],
  bugHosts: [],
  counts: { proxyServers: 0, bugHosts: 0 }
};
let currentServers = [];
let tunnel = {
  running: false,
  startedAt: 0,
  profile: null
};
let lastLogId = 0;
let busy = false;
let logLines = [];
let updateCheckTimer = null;
let updateInFlight = false;
let lastConfigRefreshAt = 0;

const CONFIG_REFRESH_COOLDOWN_MS = 60 * 1000;

boot();

elements.refreshButton.addEventListener("click", () => refreshConfig());
elements.connectButton.addEventListener("click", () => toggleTunnel());
elements.serverSelect.addEventListener("change", () => {
  localStorage.setItem("terousd.pc.serverId", elements.serverSelect.value);
  updateSelectedName();
});
elements.bugHostSelect.addEventListener("change", () => {
  localStorage.setItem("terousd.pc.bugHostId", elements.bugHostSelect.value);
  renderServerOptions();
  updateSelectedName();
  render();
});

async function boot() {
  setBusy(true);
  try {
    const state = await api.state();
    tunnel = state.tunnel;
    await loadProfiles();
    if (profiles.servers.length === 0) {
      appendLog("Click UPDATE to download config.");
    }
    if (tunnel.running) {
      scheduleUpdateCheck();
    }
    appendLog("App ready.");
  } catch (error) {
    appendLog(error.message || String(error), "error");
  } finally {
    setBusy(false);
    render();
  }
  setInterval(tick, 1000);
  setInterval(pollLogs, 1200);
}

async function loadProfiles() {
  profiles = await api.listProfiles();
  renderProfiles();
}

async function refreshConfig(options = {}) {
  const now = Date.now();
  if (!options.inline && updateInFlight) {
    appendLog("Config update is already running.");
    return;
  }
  if (!options.inline && lastConfigRefreshAt && now - lastConfigRefreshAt < CONFIG_REFRESH_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((CONFIG_REFRESH_COOLDOWN_MS - (now - lastConfigRefreshAt)) / 1000);
    appendLog(`Config was just updated. Try again in ${waitSeconds}s.`);
    return;
  }
  updateInFlight = true;
  if (!options.inline) {
    setBusy(true);
  }
  try {
    appendLog("Downloading config from Cloudflare.");
    profiles = await api.refreshConfig();
    lastConfigRefreshAt = Date.now();
    renderProfiles();
    const serverCount = profiles.counts.proxyServers || profiles.servers.length || 0;
    const bugHostCount = profiles.counts.bugHosts || 0;
    appendLog(`Config updated: version ${formatConfigVersion(profiles.version)}, ${serverCount} servers, ${bugHostCount} bug hosts.`);
    if (serverCount === 0) {
      appendLog("No active servers are published. Add a server in admin, click Publish, then UPDATE again.", "error");
    }
  } catch (error) {
    if (options.inline) {
      throw error;
    }
    appendLog(error.message || String(error), "error");
  } finally {
    updateInFlight = false;
    if (!options.inline) {
      setBusy(false);
      render();
    }
  }
}

async function ensureEngine(options = {}) {
  if (!options.inline) {
    setBusy(true);
  }
  try {
    elements.engineBadge.textContent = "Installing";
    elements.engineBadge.className = "badge busy";
    const result = await api.ensureEngine();
    appendLog(`TUN ready: ${result.source}.`);
    elements.engineBadge.textContent = "TUN ready";
    elements.engineBadge.className = "badge good";
  } catch (error) {
    elements.engineBadge.textContent = "Engine";
    elements.engineBadge.className = "badge danger";
    if (options.inline) {
      throw error;
    }
    appendLog(error.message || String(error), "error");
  } finally {
    if (!options.inline) {
      setBusy(false);
    }
  }
}

async function toggleTunnel() {
  if (tunnel.running) {
    await disconnect();
    return;
  }
  await connect();
}

async function connect() {
  const selectedBug = getSelectedBug();
  if (serverRequiredFor(selectedBug) && !elements.serverSelect.value) {
    appendLog("Choose a server first.", "error");
    return;
  }
  setBusy(true);
  try {
    await resetLogsForNewConnection();
    appendLog("Connecting.");
    tunnel = await api.connect({
      serverId: elements.serverSelect.value,
      bugHostId: elements.bugHostSelect.value
    });
    appendLog("Connected.");
    scheduleUpdateCheck();
  } catch (error) {
    const message = error.message || String(error);
    appendLog(message, "error");
    if (message.toLowerCase().includes("administrator")) {
      appendLog("Windows admin permission is needed. Reopen the app and approve the prompt.");
      try {
        await api.restartAsAdmin();
      } catch (adminError) {
        appendLog(adminError.message || String(adminError), "error");
      }
      return;
    }
    tunnel = await api.tunnelStatus();
  } finally {
    setBusy(false);
    render();
  }
}

async function disconnect() {
  clearUpdateCheck();
  setBusy(true);
  try {
    appendLog("Disconnecting.");
    tunnel = await api.disconnect();
    appendLog("Disconnected.");
  } catch (error) {
    appendLog(error.message || String(error), "error");
  } finally {
    setBusy(false);
    render();
  }
}

function scheduleUpdateCheck() {
  clearUpdateCheck();
  updateCheckTimer = window.setTimeout(() => {
    updateCheckTimer = null;
    checkConfigUpdate();
  }, 60 * 1000);
}

function clearUpdateCheck() {
  if (updateCheckTimer) {
    window.clearTimeout(updateCheckTimer);
    updateCheckTimer = null;
  }
}

async function checkConfigUpdate() {
  try {
    appendLog("Checking config version.");
    const result = await api.checkConfigUpdate();
    if (result.available) {
      appendLog(`Config ${formatConfigVersion(result.remoteVersion)} is available. Press UPDATE to download.`);
      return;
    }
    appendLog(`Config ${formatConfigVersion(result.currentVersion)} is current.`);
  } catch (error) {
    appendLog(`Config update check failed: ${error.message || String(error)}`, "error");
  }
}

function renderProfiles() {
  fillSelect(elements.bugHostSelect, profiles.bugHosts, "No host");
  restoreSelection(elements.bugHostSelect, "terousd.pc.bugHostId");
  renderServerOptions();

  elements.configVersion.textContent = `Config ${formatConfigVersion(profiles.version)}`;
  elements.profileCount.textContent = `${profiles.counts.proxyServers || profiles.servers.length || 0} servers`;
  if (profiles.notice && profiles.notice.noticeEnabled) {
    elements.noticeBox.textContent = profiles.notice.noticeMessage;
    elements.noticeBox.classList.remove("hidden");
  } else {
    elements.noticeBox.classList.add("hidden");
  }
  updateSelectedName();
}

function renderServerOptions() {
  const selectedBug = getSelectedBug();
  if (selectedBug.connectMode === "proxy") {
    currentServers = [];
    fillSelect(elements.serverSelect, [{ id: "", name: "Included" }], "Included");
    elements.serverSelect.value = "";
    return;
  }

  currentServers = serversForSelectedBug(selectedBug);
  fillSelect(elements.serverSelect, currentServers, "No server");
  restoreSelection(elements.serverSelect, "terousd.pc.serverId");
  if (elements.serverSelect.value && !currentServers.some((item) => item.id === elements.serverSelect.value)) {
    elements.serverSelect.value = currentServers[0] ? currentServers[0].id : "";
  }
}

function fillSelect(select, items, emptyLabel) {
  select.replaceChildren();
  if (!items.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.append(option);
    return;
  }
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    select.append(option);
  }
}

function restoreSelection(select, key) {
  const saved = localStorage.getItem(key);
  if (!saved) {
    return;
  }
  for (const option of select.options) {
    if (option.value === saved) {
      select.value = saved;
      return;
    }
  }
}

function render() {
  const selectedBug = getSelectedBug();
  const hasConnectableSelection = serverRequiredFor(selectedBug) ? !!elements.serverSelect.value : selectedBug.connectMode === "proxy";
  elements.connectButton.disabled = busy || !hasConnectableSelection;
  elements.connectButton.textContent = tunnel.running ? "STOP" : "START";
  elements.connectButton.classList.toggle("stop", tunnel.running);
  elements.statusBadge.textContent = tunnel.running ? "Connected" : "Disconnected";
  elements.statusBadge.className = tunnel.running ? "badge good" : "badge danger";
  if (tunnel.running) {
    elements.engineBadge.textContent = "TUN live";
    elements.engineBadge.className = "badge good";
  }
  updateDuration();
  updateSelectedName();
}

function updateSelectedName() {
  const selectedBug = getSelectedBug();
  if (selectedBug.connectMode === "proxy") {
    elements.selectedName.textContent = selectedBug.name || "Included";
    return;
  }
  const selected = currentServers.find((item) => item.id === elements.serverSelect.value);
  elements.selectedName.textContent = selected ? selected.name : "No server";
}

async function tick() {
  try {
    tunnel = await api.tunnelStatus();
    render();
  } catch {
    updateDuration();
  }
}

async function pollLogs() {
  try {
    const logs = await api.logsSince(lastLogId);
    for (const entry of logs) {
      lastLogId = Math.max(lastLogId, entry.id);
      appendLog(entry.message, entry.level);
    }
  } catch {
    // Polling is best effort.
  }
}

async function resetLogsForNewConnection() {
  logLines = [];
  lastLogId = 0;
  elements.logBox.textContent = "";
  try {
    await api.clearLogs();
  } catch {
    // Clearing logs is cosmetic, so connect should continue.
  }
  logLines = [];
  lastLogId = 0;
  elements.logBox.textContent = "";
}

function updateDuration() {
  if (!tunnel.running || !tunnel.startedAt) {
    elements.duration.textContent = "00:00:00";
    return;
  }
  const elapsed = Math.max(0, Math.floor((Date.now() - tunnel.startedAt) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  elements.duration.textContent = [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function appendLog(message, level = "info") {
  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  const prefix = level === "error" ? "ERR" : level === "core" ? "CORE" : "INFO";
  const lines = String(message || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!shouldShowLog(line, level)) {
      continue;
    }
    logLines.push(`[${time}] ${prefix} ${line}`);
  }
  if (logLines.length > 120) {
    logLines = logLines.slice(logLines.length - 120);
  }
  elements.logBox.textContent = `${logLines.join("\n")}\n`;
  elements.logBox.scrollTop = elements.logBox.scrollHeight;
}

function setBusy(value) {
  busy = value;
  elements.refreshButton.disabled = value;
  elements.serverSelect.disabled = value || tunnel.running || getSelectedBug().connectMode === "proxy";
  elements.bugHostSelect.disabled = value || tunnel.running;
  const selectedBug = getSelectedBug();
  elements.connectButton.disabled = value || (serverRequiredFor(selectedBug) ? !elements.serverSelect.value : selectedBug.connectMode !== "proxy");
}

function formatConfigVersion(value) {
  const version = Math.floor(Number(value || 0));
  if (!Number.isFinite(version) || version <= 0) {
    return "0";
  }
  if (version >= 100) {
    const major = Math.floor(version / 100);
    const minor = String(version % 100).padStart(2, "0");
    return `${major}.${minor}`;
  }
  return String(version);
}

function getSelectedBug() {
  return profiles.bugHosts.find((item) => item.id === elements.bugHostSelect.value)
    || profiles.bugHosts[0]
    || { id: "", name: "Default", connectMode: "default" };
}

function serversForSelectedBug(bug) {
  if (bug.connectMode === "proxy-group") {
    return profiles.servers.filter((server) => server.connectMode === "proxy" && server.proxyGroupId === bug.id);
  }
  if (bug.connectMode === "proxy-all") {
    return profiles.servers.filter((server) => server.connectMode === "proxy");
  }
  return profiles.servers.filter((server) => server.connectMode === "proxy" && !server.proxyGroupId);
}

function serverRequiredFor(bug) {
  return bug.connectMode !== "proxy";
}

function shouldShowLog(message, level) {
  const text = String(message || "");
  if (level !== "core") {
    return true;
  }
  const lower = text.toLowerCase();
  if (lower.includes("accepted")
      || lower.includes("from 127.0.0.1")
      || lower.includes("process dns packet")
      || lower.includes(">> proxy")
      || lower.includes("tcp:")
      || lower.includes(":443")
      || lower.includes(":80")) {
    return false;
  }
  return lower.includes("error")
    || lower.includes("failed")
    || lower.includes("refused")
    || lower.includes("timeout")
    || lower.includes("warn");
}
