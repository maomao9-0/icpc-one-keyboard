export const app = document.querySelector("#app");
export const api = "/api/session";
export const defaults = { durationMs: 5 * 60 * 60 * 1000 };
export const actionNoteLimit = 140;
export const liveTickSafetyMs = 20;
export const requestExpiryRefreshDelayMs = 150;
export const memberPresenceMs = 10 * 1000;

function createClientKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const state = {
  identity: {
    clientId: local("clientId", crypto.randomUUID()),
    clientKey: local("clientKey", createClientKey()),
    name: local("name", ""),
    code: new URLSearchParams(location.search).get("code")?.toUpperCase() || "",
  },
  session: null,
  sessionFingerprint: "",
  network: {
    busy: false,
    syncIssue: "",
    pollGeneration: 0,
    writeInFlight: 0,
  },
  notifications: {
    askedPermission: false,
    lastSeenEvent: "",
  },
  lifecycle: {
    leaveSent: false,
  },
  ui: {
    settingsOpen: false,
    auditOpen: false,
    actionNote: "",
    actionNoteOpen: false,
    leaveOpen: false,
    kickTarget: null,
    toast: "",
  },
};

localStorage.setItem("clientId", state.identity.clientId);
localStorage.setItem("clientKey", state.identity.clientKey);

function local(key, fallback) {
  const value = localStorage.getItem(key);
  return value || fallback;
}
