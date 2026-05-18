const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const firebaseProject = require("../config/firebaseProject");

class UsageReporter {
  constructor(app) {
    this.dataDir = app.getPath("userData");
    this.installFile = path.join(this.dataDir, "pc-install-id.txt");
    this.installIdPromise = null;
  }

  async recordSeen(connected = false) {
    const now = new Date();
    const payload = {
      installId: await this.installId(),
      connected: connected === true,
      connectionConfirmed: connected === true,
      lastSeen: now
    };
    if (connected) {
      payload.lastConnectedAt = now;
    } else {
      payload.lastDisconnectedAt = now;
    }
    await this.patch(payload);
  }

  async recordConfigDownload(version, connected = false) {
    const now = new Date();
    const payload = {
      installId: await this.installId(),
      connected: connected === true,
      connectionConfirmed: connected === true,
      lastSeen: now,
      lastConfigDownloadAt: now,
      lastConfigDownloadVersion: cleanVersion(version)
    };
    if (connected) {
      payload.lastConnectedAt = now;
    } else {
      payload.lastDisconnectedAt = now;
    }
    await this.patch(payload);
  }

  async recordConnected(connected) {
    const now = new Date();
    const payload = {
      installId: await this.installId(),
      connected: connected === true,
      connectionConfirmed: connected === true,
      lastSeen: now
    };
    if (connected) {
      payload.lastConnectedAt = now;
    } else {
      payload.lastDisconnectedAt = now;
    }
    await this.patch(payload);
  }

  async patch(payload) {
    const installId = await this.installId();
    const fields = firestoreFields(payload);
    const mask = Object.keys(fields).map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join("&");
    const db = encodeURIComponent(firebaseProject.databaseId);
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseProject.projectId}/databases/${db}/documents/${firebaseProject.usageCollection}/${encodeURIComponent(installId)}?key=${firebaseProject.apiKey}&${mask}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Usage update failed (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    }
  }

  async installId() {
    if (!this.installIdPromise) {
      this.installIdPromise = this.readOrCreateInstallId();
    }
    return this.installIdPromise;
  }

  async readOrCreateInstallId() {
    try {
      const value = String(await fs.readFile(this.installFile, "utf8") || "").trim();
      if (/^pc-[a-f0-9-]{36}$/i.test(value)) {
        return value.toLowerCase();
      }
    } catch {
      // Missing install id is expected on first run.
    }
    const installId = `pc-${crypto.randomUUID()}`;
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.installFile, installId, "utf8");
    return installId;
  }
}

function firestoreFields(payload) {
  const fields = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "boolean") {
      fields[key] = { booleanValue: value };
    } else if (typeof value === "number") {
      fields[key] = { integerValue: String(Math.floor(value)) };
    } else if (value instanceof Date) {
      fields[key] = { timestampValue: value.toISOString() };
    } else {
      fields[key] = { stringValue: String(value == null ? "" : value) };
    }
  }
  return fields;
}

function cleanVersion(value) {
  const version = Math.floor(Number(value || 0));
  return version > 0 && version <= 999999 ? version : 0;
}

module.exports = UsageReporter;
