const fs = require("node:fs/promises");
const path = require("node:path");
const firebaseProject = require("./firebaseProject");

const NONE_BUG_ID = "__none__";

class ConfigRepository {
  constructor(app) {
    this.dataDir = app.getPath("userData");
    this.cacheFile = path.join(this.dataDir, "profiles-cache.json");
    this.legacyEncryptedCacheFile = path.join(this.dataDir, "profiles-cache.encrypted.json");
  }

  async refresh() {
    const remote = await this.fetchRemoteConfig(true);
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.cacheFile, JSON.stringify(remote, null, 2), "utf8");
    await fs.rm(this.legacyEncryptedCacheFile, { force: true }).catch(() => {});
    return this.listForUi(remote);
  }

  async checkForUpdate() {
    const remote = await this.fetchRemoteConfig(false);
    const local = await this.loadCached();
    const currentVersion = cleanVersion(local.version);
    const remoteVersion = cleanVersion(remote.version);
    return {
      available: remoteVersion > currentVersion,
      currentVersion,
      remoteVersion,
      publishedAt: String(remote.publishedAt || ""),
      notice: normalizeNotice(remote.notice)
    };
  }

  async loadCached() {
    try {
      const text = await fs.readFile(this.cacheFile, "utf8");
      return normalizeCache(JSON.parse(text));
    } catch {
      await fs.rm(this.legacyEncryptedCacheFile, { force: true }).catch(() => {});
      return emptyCache();
    }
  }

  async listForUi(cache = null) {
    const loaded = normalizeCache(cache || await this.loadCached());
    const proxyServers = loaded.servers.filter((profile) => isDirectProxyProfile(profile) && hasProxyAddress(profile));
    return {
      version: loaded.version || 0,
      publishedAt: loaded.publishedAt || "",
      notice: loaded.notice || normalizeNotice(null),
      servers: proxyServers.map(publicProfile),
      bugHosts: proxyServers.length ? [publicProfile(allProxyHost())] : [],
      counts: {
        allServers: loaded.servers.length,
        proxyServers: proxyServers.length,
        bugHosts: proxyServers.length ? 1 : 0
      }
    };
  }

  async composeProfile(serverId) {
    const cache = await this.loadCached();
    const server = cache.servers.find((item) => item.id === serverId);
    if (!server) {
      throw new Error("Choose a server first.");
    }
    if (!isDirectProxyProfile(server)) {
      throw new Error("This PC app supports only HTTP and SOCKS5 proxy servers.");
    }
    return directProxyResult(directProxyProfile(server, allProxyHost()), server, allProxyHost());
  }

  async fetchRemoteConfig(bustCache) {
    const url = firestoreDocumentUrl(
      firebaseProject.publicConfigCollection,
      firebaseProject.publicConfigDocument
    );
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Cache-Control": bustCache ? "no-cache" : "max-age=30"
      }
    });
    if (!response.ok) {
      throw new Error(`Config server returned ${response.status}.`);
    }
    const document = await response.json();
    if (!document.fields) {
      return emptyCache();
    }
    return normalizeCache(firestoreToPlain({ mapValue: { fields: document.fields } }));
  }
}

function firestoreDocumentUrl(collection, document) {
  const db = encodeURIComponent(firebaseProject.databaseId);
  const base = `https://firestore.googleapis.com/v1/projects/${firebaseProject.projectId}/databases/${db}/documents/${collection}/${document}`;
  const query = new URLSearchParams({ key: firebaseProject.apiKey });
  return `${base}?${query}`;
}

function firestoreToPlain(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if ("stringValue" in value) return String(value.stringValue || "");
  if ("integerValue" in value) return Number(value.integerValue || 0);
  if ("doubleValue" in value) return Number(value.doubleValue || 0);
  if ("booleanValue" in value) return value.booleanValue === true;
  if ("timestampValue" in value) return String(value.timestampValue || "");
  if ("nullValue" in value) return null;
  if (value.arrayValue) {
    return (value.arrayValue.values || []).map(firestoreToPlain);
  }
  if (value.mapValue) {
    const output = {};
    const fields = value.mapValue.fields || {};
    for (const [key, child] of Object.entries(fields)) {
      output[key] = firestoreToPlain(child);
    }
    return output;
  }
  return null;
}

function normalizeCache(cache) {
  const value = cache && typeof cache === "object" ? cache : {};
  return {
    version: cleanVersion(value.version),
    publishedAt: String(value.publishedAt || value.updatedAt || ""),
    notice: normalizeNotice(value.notice),
    servers: sortProfiles((value.servers || []).map(normalizeProfile).filter((profile) => profile.active))
  };
}

function emptyCache() {
  return normalizeCache({
    version: 0,
    publishedAt: "",
    notice: normalizeNotice(null),
    servers: []
  });
}

function directProxyResult(profile, server, bug) {
  return {
    profile,
    server: server ? publicProfile(server) : null,
    bugHost: publicProfile(bug)
  };
}

function directProxyProfile(source, parent) {
  const profile = normalizeProfile({});
  const method = proxyMethodFor(source);
  const socksProxy = method === "socks5-proxy";
  profile.id = valueOr(source.id, method);
  profile.name = displayName(source);
  profile.protocol = socksProxy ? "socks5" : "http";
  profile.host = valueOr(source.host, source.remoteProxyHost);
  profile.port = valueOr(source.port, source.remoteProxyPort);
  profile.username = source.username;
  profile.password = source.password;
  profile.methodType = method;
  profile.bugType = method;
  profile.bugHost = profile.host;
  profile.remoteProxyPort = profile.port;
  profile.iconKey = valueOr(source.iconKey, parent ? parent.iconKey : "");
  profile.iconUrl = valueOr(source.iconUrl, parent ? parent.iconUrl : "");
  profile.description = valueOr(source.description, parent ? parent.description : "");
  profile.active = source.active && (!parent || parent.active);
  return profile;
}

function normalizeProfile(value = {}) {
  return {
    id: stringValue(value.id),
    name: stringValue(value.name),
    protocol: valueOr(stringValue(value.protocol), "http"),
    host: stringValue(value.host),
    port: stringValue(value.port),
    username: stringValue(value.username),
    password: stringValue(value.password),
    methodType: stringValue(value.methodType),
    bugType: stringValue(value.bugType),
    bugHost: stringValue(value.bugHost),
    remoteProxyHost: stringValue(value.remoteProxyHost),
    remoteProxyPort: stringValue(value.remoteProxyPort),
    iconKey: stringValue(value.iconKey),
    iconUrl: stringValue(value.iconUrl),
    description: stringValue(value.description),
    sortOrder: Number.isFinite(Number(value.sortOrder)) ? Number(value.sortOrder) : 0,
    active: value.active !== false
  };
}

function publicProfile(profile) {
  const normalized = normalizeProfile(profile);
  return {
    id: normalized.id,
    name: displayName(normalized),
    protocol: proxyProtocol(normalized),
    host: normalized.host,
    port: normalized.port,
    description: normalized.description,
    iconKey: normalized.iconKey,
    iconUrl: normalized.iconUrl,
    method: methodForBug(normalized),
    connectMode: connectMode(normalized),
    sortOrder: normalized.sortOrder
  };
}

function allProxyHost() {
  return normalizeProfile({
    id: NONE_BUG_ID,
    name: "HTTP/SOCKS5",
    protocol: "proxy",
    bugType: "proxy-all",
    active: true
  });
}

function methodForBug(profile) {
  if (!profile) {
    return "";
  }
  const type = String(valueOr(profile.bugType, profile.methodType)).trim().toLowerCase();
  if (type === "proxy-all") return "proxy-all";
  if (type === "socks" || type === "socks5" || type === "socks5-proxy") return "socks5-proxy";
  return "http-proxy";
}

function proxyProtocol(profile) {
  const value = valueOr(profile.protocol, valueOr(profile.bugType, profile.methodType)).trim().toLowerCase();
  return value.includes("socks") ? "socks5" : "http";
}

function proxyMethodFor(profile) {
  return proxyProtocol(profile) === "socks5" ? "socks5-proxy" : "http-proxy";
}

function isDirectProxyProfile(profile) {
  if (!profile) {
    return false;
  }
  const protocol = String(profile.protocol || "").trim().toLowerCase();
  const method = String(valueOr(profile.methodType, profile.bugType)).trim().toLowerCase();
  return protocol === "http"
    || protocol === "http-proxy"
    || protocol === "socks"
    || protocol === "socks5"
    || protocol === "socks5-proxy"
    || method === "http-proxy"
    || method === "socks5-proxy";
}

function hasProxyAddress(profile) {
  const host = valueOr(profile.host, profile.remoteProxyHost);
  const port = Number.parseInt(valueOr(profile.port, profile.remoteProxyPort), 10);
  return hasValue(host) && Number.isFinite(port) && port > 0;
}

function connectMode(profile) {
  if (profile.id === NONE_BUG_ID || methodForBug(profile) === "proxy-all") {
    return "proxy-all";
  }
  return "proxy";
}

function sortProfiles(items) {
  return [...items].sort((left, right) => {
    const leftOrder = left.sortOrder > 0 ? left.sortOrder : Number.MAX_SAFE_INTEGER;
    const rightOrder = right.sortOrder > 0 ? right.sortOrder : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return displayName(left).localeCompare(displayName(right));
  });
}

function normalizeNotice(value) {
  const notice = value && typeof value === "object" ? value : {};
  const enabled = notice.noticeEnabled === true && hasValue(notice.noticeMessage);
  return {
    noticeEnabled: enabled,
    noticeTitle: stringValue(notice.noticeTitle || (enabled ? "Notice" : "")),
    noticeMessage: enabled ? stringValue(notice.noticeMessage) : "",
    noticeButton: valueOr(stringValue(notice.noticeButton), "OKAY"),
    noticeVersion: Number(notice.noticeVersion || 0)
  };
}

function displayName(profile) {
  return valueOr(profile.name, profile.protocol ? proxyProtocol(profile).toUpperCase() : "Proxy");
}

function cleanVersion(value) {
  const version = Math.floor(Number(value || 0));
  return version > 0 && version <= 999999 ? version : 0;
}

function hasValue(value) {
  return value != null && String(value).trim().length > 0;
}

function valueOr(value, fallback) {
  return hasValue(value) ? String(value).trim() : fallback || "";
}

function stringValue(value) {
  return value == null ? "" : String(value);
}

module.exports = ConfigRepository;
module.exports.NONE_BUG_ID = NONE_BUG_ID;
