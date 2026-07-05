export const app = document.querySelector("#app");
export const api = "/api/session";
export const defaults = { durationMs: 5 * 60 * 60 * 1000 };
export const actionNoteLimit = 140;
export const liveTickSafetyMs = 20;
export const requestExpiryRefreshDelayMs = 150;
export const memberPresenceMs = 10 * 1000;

export const state = {
  identity: {
    clientId: local("clientId", crypto.randomUUID()),
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

function local(key, fallback) {
  const value = localStorage.getItem(key);
  return value || fallback;
}
