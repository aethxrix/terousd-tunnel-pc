import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  where
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { adminEmails, firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const UNGROUPED_BUG_ID = "__none__";

const loginBtn = document.querySelector("#loginBtn");
const logoutBtn = document.querySelector("#logoutBtn");
const authState = document.querySelector("#authState");
const lockedPanel = document.querySelector("#lockedPanel");
const adminPanel = document.querySelector("#adminPanel");
const bugHostForm = document.querySelector("#bugHostForm");
const serverForm = document.querySelector("#serverForm");
const resetBugHostBtn = document.querySelector("#resetBugHostBtn");
const resetBtn = document.querySelector("#resetBtn");
const publishBtn = document.querySelector("#publishBtn");
const bugHostList = document.querySelector("#bugHostList");
const serverList = document.querySelector("#serverList");
const serverBugHostSelect = document.querySelector("#serverBugHostSelect");
const serverCount = document.querySelector("#serverCount");
const bugHostCount = document.querySelector("#bugHostCount");
const versionText = document.querySelector("#versionText");
const connectedNow = document.querySelector("#connectedNow");
const statusBox = document.querySelector("#status");
const formTitle = document.querySelector("#formTitle");
const bugHostFormTitle = document.querySelector("#bugHostFormTitle");

let bugHosts = [];
let servers = [];
let currentConfig = { version: 0 };
let usageTimer = null;

loginBtn.addEventListener("click", () => signInWithPopup(auth, new GoogleAuthProvider()).catch(showError));
logoutBtn.addEventListener("click", () => signOut(auth).catch(showError));
resetBugHostBtn.addEventListener("click", resetBugHostForm);
resetBtn.addEventListener("click", resetForm);
publishBtn.addEventListener("click", publishConfig);
bugHostForm.addEventListener("submit", saveBugHost);
serverForm.addEventListener("submit", saveServer);

onAuthStateChanged(auth, async (user) => {
  clearInterval(usageTimer);
  usageTimer = null;
  if (!user || !adminEmails.includes(user.email || "")) {
    loginBtn.classList.remove("hidden");
    logoutBtn.classList.add("hidden");
    lockedPanel.classList.remove("hidden");
    adminPanel.classList.add("hidden");
    authState.textContent = user ? "Not allowed" : "Signed out";
    bugHosts = [];
    servers = [];
    renderAll();
    return;
  }

  loginBtn.classList.add("hidden");
  logoutBtn.classList.remove("hidden");
  lockedPanel.classList.add("hidden");
  adminPanel.classList.remove("hidden");
  authState.textContent = user.email;
  await loadAll();
  usageTimer = setInterval(refreshUsage, 60 * 1000);
});

async function loadAll() {
  await Promise.all([loadBugHosts(), loadServers(), loadConfig(), refreshUsage()]);
  renderAll();
  setStatus("Ready.");
}

async function loadBugHosts() {
  const snapshot = await getDocs(query(collection(db, "pcBugHosts"), orderBy("sortOrder"), orderBy("name")));
  bugHosts = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

async function loadServers() {
  const snapshot = await getDocs(query(collection(db, "pcServers"), orderBy("sortOrder"), orderBy("name")));
  servers = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

async function loadConfig() {
  const snapshot = await getDoc(doc(db, "pcPublic", "config"));
  currentConfig = snapshot.exists() ? snapshot.data() : { version: 0 };
  versionText.textContent = formatVersion(currentConfig.version);
}

async function refreshUsage() {
  const cutoff = Timestamp.fromDate(new Date(Date.now() - 30 * 60 * 1000));
  const snapshot = await getDocs(query(collection(db, "usageUsers"), where("lastSeen", ">=", cutoff)));
  let count = 0;
  const now = Date.now();
  snapshot.forEach((item) => {
    if (isConnected(item.data(), now)) {
      count += 1;
    }
  });
  connectedNow.textContent = String(count);
}

async function saveBugHost(event) {
  event.preventDefault();
  const data = new FormData(bugHostForm);
  const id = String(data.get("id") || "").trim() || crypto.randomUUID();
  const bugHost = {
    id,
    name: cleanText(data.get("name")),
    sortOrder: cleanNumber(data.get("sortOrder")),
    active: data.get("active") === "on",
    updatedAt: serverTimestamp()
  };
  if (!bugHost.name) {
    setStatus("Bug host name is required.", "error");
    return;
  }
  await setDoc(doc(db, "pcBugHosts", id), bugHost, { merge: true });
  resetBugHostForm();
  await Promise.all([loadBugHosts(), loadServers()]);
  renderAll();
  setStatus("Bug host saved.");
}

async function saveServer(event) {
  event.preventDefault();
  const data = new FormData(serverForm);
  const id = String(data.get("id") || "").trim() || crypto.randomUUID();
  const server = {
    id,
    name: cleanText(data.get("name")),
    protocol: cleanProtocol(data.get("protocol")),
    bugHostId: cleanBugHostId(data.get("bugHostId")),
    host: cleanText(data.get("host")),
    port: cleanPort(data.get("port")),
    username: cleanText(data.get("username")),
    password: cleanText(data.get("password")),
    sortOrder: cleanNumber(data.get("sortOrder")),
    active: data.get("active") === "on",
    updatedAt: serverTimestamp()
  };
  if (!server.name || !server.host || !server.port) {
    setStatus("Name, host, and port are required.", "error");
    return;
  }
  await setDoc(doc(db, "pcServers", id), server, { merge: true });
  resetForm();
  await loadServers();
  renderAll();
  setStatus("Server saved.");
}

async function deleteBugHost(id) {
  await deleteDoc(doc(db, "pcBugHosts", id));
  const updates = servers
    .filter((server) => server.bugHostId === id)
    .map((server) => setDoc(doc(db, "pcServers", server.id), { bugHostId: "" }, { merge: true }));
  await Promise.all(updates);
  await Promise.all([loadBugHosts(), loadServers()]);
  renderAll();
  setStatus("Bug host deleted.");
}

async function deleteServer(id) {
  await deleteDoc(doc(db, "pcServers", id));
  await loadServers();
  renderAll();
  setStatus("Server deleted.");
}

async function publishConfig() {
  const activeBugHosts = bugHosts
    .filter((bugHost) => bugHost.active !== false)
    .map(publicBugHost)
    .filter((bugHost) => bugHost.name);
  const activeBugHostIds = new Set(activeBugHosts.map((bugHost) => bugHost.id));
  const activeServers = servers
    .filter((server) => server.active !== false)
    .map((server) => publicServer(server, activeBugHostIds))
    .filter((server) => server.host && server.port);
  const version = cleanNumber(currentConfig.version) + 1 || 1;
  await setDoc(doc(db, "pcPublic", "config"), {
    version,
    publishedAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
    bugHosts: activeBugHosts,
    servers: activeServers,
    notice: {
      noticeEnabled: false,
      noticeTitle: "",
      noticeMessage: "",
      noticeButton: "OKAY",
      noticeVersion: version
    }
  });
  await loadConfig();
  setStatus(`Published config ${formatVersion(version)}.`);
}

function renderAll() {
  renderBugHostSelect();
  renderBugHosts();
  renderServers();
}

function renderBugHostSelect() {
  const selected = serverBugHostSelect.value || UNGROUPED_BUG_ID;
  serverBugHostSelect.replaceChildren();
  serverBugHostSelect.append(optionFor(UNGROUPED_BUG_ID, "All / no bug host"));
  for (const bugHost of bugHosts) {
    serverBugHostSelect.append(optionFor(bugHost.id, bugHost.name || "Bug Host"));
  }
  serverBugHostSelect.value = [...serverBugHostSelect.options].some((item) => item.value === selected)
    ? selected
    : UNGROUPED_BUG_ID;
}

function renderBugHosts() {
  bugHostCount.textContent = String(bugHosts.length);
  bugHostList.replaceChildren();
  if (!bugHosts.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No bug hosts yet.";
    bugHostList.append(empty);
    return;
  }
  for (const bugHost of bugHosts) {
    const row = document.createElement("article");
    row.className = "server-row";
    row.innerHTML = rowTemplate();
    row.querySelector("strong").textContent = bugHost.name || "Bug Host";
    row.querySelector("span").textContent = `Name only${bugHost.sortOrder ? ` / order ${bugHost.sortOrder}` : ""}`;
    const pill = row.querySelector(".pill");
    pill.textContent = bugHost.active === false ? "OFF" : "ON";
    pill.classList.toggle("off", bugHost.active === false);
    row.querySelector('[data-action="edit"]').addEventListener("click", () => editBugHost(bugHost));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteBugHost(bugHost.id).catch(showError));
    bugHostList.append(row);
  }
}

function renderServers() {
  serverCount.textContent = String(servers.length);
  serverList.replaceChildren();
  if (!servers.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No servers yet.";
    serverList.append(empty);
    return;
  }
  for (const server of servers) {
    const bugName = bugHostName(server.bugHostId);
    const row = document.createElement("article");
    row.className = "server-row";
    row.innerHTML = rowTemplate();
    row.querySelector("strong").textContent = server.name || server.host || "Proxy";
    row.querySelector("span").textContent = `${cleanProtocol(server.protocol).toUpperCase()} ${server.host}:${server.port} / ${bugName}`;
    const pill = row.querySelector(".pill");
    pill.textContent = server.active === false ? "OFF" : "ON";
    pill.classList.toggle("off", server.active === false);
    row.querySelector('[data-action="edit"]').addEventListener("click", () => editServer(server));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteServer(server.id).catch(showError));
    serverList.append(row);
  }
}

function rowTemplate() {
  return `
    <div class="server-main">
      <strong></strong>
      <span></span>
    </div>
    <div class="server-actions">
      <span class="pill"></span>
      <button type="button" data-action="edit">Edit</button>
      <button type="button" data-action="delete" class="danger">Delete</button>
    </div>
  `;
}

function editBugHost(bugHost) {
  bugHostForm.elements.id.value = bugHost.id || "";
  bugHostForm.elements.name.value = bugHost.name || "";
  bugHostForm.elements.sortOrder.value = bugHost.sortOrder || "";
  bugHostForm.elements.active.checked = bugHost.active !== false;
  bugHostFormTitle.textContent = "Edit Bug Host";
}

function editServer(server) {
  serverForm.elements.id.value = server.id || "";
  serverForm.elements.name.value = server.name || "";
  serverForm.elements.protocol.value = cleanProtocol(server.protocol);
  serverForm.elements.bugHostId.value = cleanBugHostId(server.bugHostId);
  serverForm.elements.host.value = server.host || "";
  serverForm.elements.port.value = server.port || "";
  serverForm.elements.username.value = server.username || "";
  serverForm.elements.password.value = server.password || "";
  serverForm.elements.sortOrder.value = server.sortOrder || "";
  serverForm.elements.active.checked = server.active !== false;
  formTitle.textContent = "Edit Server";
}

function resetBugHostForm() {
  bugHostForm.reset();
  bugHostForm.elements.id.value = "";
  bugHostForm.elements.active.checked = true;
  bugHostFormTitle.textContent = "Add Bug Host";
}

function resetForm() {
  serverForm.reset();
  serverForm.elements.id.value = "";
  serverForm.elements.bugHostId.value = UNGROUPED_BUG_ID;
  serverForm.elements.active.checked = true;
  formTitle.textContent = "Add Server";
}

function publicBugHost(bugHost) {
  return {
    id: bugHost.id,
    name: cleanText(bugHost.name),
    bugType: "proxy-group",
    sortOrder: cleanNumber(bugHost.sortOrder),
    active: bugHost.active !== false
  };
}

function publicServer(server, activeBugHostIds) {
  const bugHostId = cleanBugHostId(server.bugHostId);
  return {
    id: server.id,
    name: cleanText(server.name),
    protocol: cleanProtocol(server.protocol),
    host: cleanText(server.host),
    port: cleanPort(server.port),
    username: cleanText(server.username),
    password: cleanText(server.password),
    proxyGroupId: activeBugHostIds.has(bugHostId) ? bugHostId : "",
    sortOrder: cleanNumber(server.sortOrder),
    active: server.active !== false
  };
}

function bugHostName(id) {
  const cleanId = cleanBugHostId(id);
  if (cleanId === UNGROUPED_BUG_ID) {
    return "All / no bug host";
  }
  const match = bugHosts.find((bugHost) => bugHost.id === cleanId);
  return match ? match.name : "Missing bug host";
}

function optionFor(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function isConnected(data, now) {
  if (data.connected !== true || data.connectionConfirmed !== true) return false;
  const connectedAt = toTime(data.lastConnectedAt || data.lastSeen);
  const seenAt = toTime(data.lastSeen || data.lastConnectedAt);
  const disconnectedAt = toTime(data.lastDisconnectedAt);
  return connectedAt && seenAt && now - seenAt <= 30 * 60 * 1000 && (!disconnectedAt || disconnectedAt <= connectedAt);
}

function toTime(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function cleanProtocol(value) {
  return String(value || "").toLowerCase().includes("socks") ? "socks5" : "http";
}

function cleanBugHostId(value) {
  const id = cleanText(value);
  return id && id !== UNGROUPED_BUG_ID ? id : UNGROUPED_BUG_ID;
}

function cleanText(value) {
  return String(value || "").trim();
}

function cleanPort(value) {
  const port = cleanNumber(value);
  return port > 0 && port <= 65535 ? String(port) : "";
}

function cleanNumber(value) {
  const number = Math.floor(Number(value || 0));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function formatVersion(value) {
  const version = cleanNumber(value);
  if (version >= 100) {
    return `${Math.floor(version / 100)}.${String(version % 100).padStart(2, "0")}`;
  }
  return String(version);
}

function setStatus(message, type = "info") {
  statusBox.textContent = message;
  statusBox.style.color = type === "error" ? "var(--red)" : "var(--muted)";
}

function showError(error) {
  setStatus(error.message || String(error), "error");
}
