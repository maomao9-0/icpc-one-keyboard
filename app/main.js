import { createLiveTime } from "./live.js";
import {
  durationFromFields,
  esc,
  primaryActionFor,
  remainingMs,
  sessionFingerprint,
  teammateEntries,
  trimmedActionNote,
} from "./helpers.js";
import { sessionPayload, sessionQuery } from "./security.js";
import { actionNoteLimit, api, app, defaults, state } from "./state.js";
import { viewMarkup } from "./views.js";

function render() {
  app.innerHTML = viewMarkup();
  if (state.ui.toast) {
    app.insertAdjacentHTML("beforeend", `<div class="toast" role="status" aria-live="polite">${esc(state.ui.toast)}</div>`);
  }
  updateLiveRegions();
}

async function call(body) {
  state.network.writeInFlight += 1;
  state.network.pollGeneration += 1;
  state.network.busy = true;
  render();
  try {
    const res = await fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    state.network.syncIssue = "";
    if (body.action === "leave") {
      resetToHome();
      return data;
    }
    setSession(data.session, data.code);
    return data;
  } catch (err) {
    if (err.message.includes("You were removed from this session") || err.message === "Session access denied") {
      resetToHome();
      toast(err.message, true, true);
      return;
    }
    toast(err.message, true);
  } finally {
    state.network.writeInFlight = Math.max(0, state.network.writeInFlight - 1);
    state.network.busy = false;
    if (!editingModal()) render();
  }
}

async function poll() {
  if (!state.identity.code || !state.session) return;
  const generation = state.network.pollGeneration;
  const writeInFlight = state.network.writeInFlight;
  try {
    const res = await fetch(`${api}?${sessionQuery()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (writeInFlight > 0 || generation !== state.network.pollGeneration) return;
    const hadIssue = Boolean(state.network.syncIssue);
    state.network.syncIssue = "";
    const changed = setSession(data.session);
    if (state.session && !isCurrentMember()) {
      resetToHome();
      toast("You were removed from the session. Join again if needed.", false, true);
      return;
    }
    if ((changed || hadIssue) && !editingModal()) render();
  } catch (err) {
    const issue = err.message || "Could not sync session";
    if (issue.includes("You were removed from this session") || issue === "Session access denied") {
      resetToHome();
      toast(issue, true, true);
      return;
    }
    if (state.network.syncIssue !== issue) {
      state.network.syncIssue = issue;
      if (!editingModal()) render();
    }
  }
}

const liveTime = createLiveTime({ poll });

function setSession(session, code = session?.code) {
  const priorRequestId = state.session?.pendingRequest?.id || "";
  const nextFingerprint = sessionFingerprint(session);
  const changed = nextFingerprint !== state.sessionFingerprint;
  state.session = session;
  state.sessionFingerprint = nextFingerprint;
  state.identity.code = code || state.identity.code;
  if (state.identity.code) history.replaceState(null, "", `/?code=${state.identity.code}`);
  if (priorRequestId !== (state.session?.pendingRequest?.id || "")) {
    liveTime.resetExpiryPoll();
  }
  const latest = session?.events?.at(-1);
  if (latest && latest.id !== state.notifications.lastSeenEvent) {
    if (state.notifications.lastSeenEvent && latest.clientId !== state.identity.clientId) notify(latest.message);
    state.notifications.lastSeenEvent = latest.id;
  }
  updateLiveRegions();
  return changed;
}

function isCurrentMember(session = state.session) {
  return Boolean(session?.members?.[state.identity.clientId]);
}

function hasActiveOwnership(session = state.session) {
  return session?.holder?.clientId === state.identity.clientId;
}

function hasOngoingCountdown(session = state.session) {
  return Boolean(session?.timerRunning && remainingMs(session) > 0);
}

function shouldWarnOnExit() {
  return Boolean(state.session && (hasOngoingCountdown() || hasActiveOwnership()));
}

function notify(message) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("One Keyboard", { body: message });
  }
}

function requestNotifications() {
  if (!("Notification" in window) || state.notifications.askedPermission) return;
  state.notifications.askedPermission = true;
  if (Notification.permission === "default") Notification.requestPermission();
}

function toast(message, isError = false, immediate = false) {
  state.ui.toast = isError ? `Error: ${message}` : message;
  clearTimeout(toast.timer);
  if (immediate) {
    document.querySelector(".toast")?.remove();
    app.insertAdjacentHTML("beforeend", `<div class="toast" role="status" aria-live="polite">${esc(state.ui.toast)}</div>`);
  }
  toast.timer = setTimeout(() => {
    state.ui.toast = "";
    render();
  }, 2600);
}

function requireName() {
  if (state.identity.name.trim()) return true;
  const name = prompt("Your display name?");
  if (!name?.trim()) return false;
  state.identity.name = name.trim();
  localStorage.setItem("name", state.identity.name);
  return true;
}

function leavePayload() {
  if (!state.session || !state.identity.code || !state.identity.clientId || !state.identity.name) return null;
  return sessionPayload("leave");
}

function resetToHome() {
  state.session = null;
  state.sessionFingerprint = "";
  state.identity.code = "";
  state.ui.settingsOpen = false;
  state.ui.auditOpen = false;
  state.ui.actionNote = "";
  state.ui.actionNoteOpen = false;
  state.ui.leaveOpen = false;
  state.ui.kickTarget = null;
  history.replaceState(null, "", "/");
  render();
}

function editingModal() {
  const active = document.activeElement;
  return Boolean(active && active.closest?.(".modal"));
}

function updateLiveRegions() {
  liveTime.refresh();
}

function copyText(value, message) {
  toast(message, false, true);
  navigator.clipboard?.writeText(value)?.catch(() => toast("Could not copy.", true));
}

app.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  if (form.dataset.form === "join") {
    state.identity.name = data.name.trim();
    state.identity.code = String(data.code || "").trim().toUpperCase();
    localStorage.setItem("name", state.identity.name);
    if (event.submitter.value === "create") {
      call(sessionPayload("create", { name: state.identity.name, durationMs: defaults.durationMs }));
    } else {
      call(sessionPayload("join", { name: state.identity.name }));
    }
    requestNotifications();
  }
  if (form.dataset.form === "save-settings") {
    call(sessionPayload("settings", { timerEnabled: true, durationMs: durationFromFields(data) }));
    state.ui.settingsOpen = false;
  }
});

document.addEventListener("click", async (event) => {
  const actionNode = event.target.closest("button[data-action]") || (event.target.matches(".modal[data-action]") ? event.target : null);
  const action = actionNode?.dataset.action;
  if (!action) return;
  event.preventDefault();
  if (action === "settings") {
    state.ui.settingsOpen = true;
  }
  if (action === "close-settings") {
    state.ui.settingsOpen = false;
    render();
    return;
  }
  if (action === "leave-session") {
    state.ui.leaveOpen = true;
    render();
    return;
  }
  if (action === "close-leave") {
    state.ui.leaveOpen = false;
    render();
    return;
  }
  if (action === "kick-member") {
    const clientId = actionNode.dataset.clientId;
    const target = teammateEntries(state.session).find((member) => member.clientId === clientId);
    if (!target) {
      toast("That teammate is no longer in the session.", true);
      return;
    }
    state.ui.kickTarget = target;
    render();
    return;
  }
  if (action === "close-kick") {
    state.ui.kickTarget = null;
    render();
    return;
  }
  if (action === "copy-link") copyText(`${location.origin}/?code=${state.identity.code}`, "Link copied.");
  if (action === "toggle-note") {
    state.ui.actionNoteOpen = !state.ui.actionNoteOpen;
    render();
    if (state.ui.actionNoteOpen) document.querySelector('textarea[name="actionNote"]')?.focus();
    return;
  }
  if (action === "clear-note") {
    state.ui.actionNote = "";
    state.ui.actionNoteOpen = false;
    render();
    return;
  }
  if (action === "timer-toggle") {
    await call(sessionPayload("timer", { command: state.session.timerRunning ? "stop" : "start" }));
  }
  if (action === "timer-reset") {
    await call(sessionPayload("timer", { command: "reset" }));
  }
  if (action === "request-accept") {
    await call(sessionPayload("requestAccept"));
  }
  if (action === "request-reject") {
    await call(sessionPayload("requestReject"));
  }
  if (action === "confirm-leave") {
    state.ui.leaveOpen = false;
    render();
    const payload = leavePayload();
    if (payload) {
      await call(payload);
    }
    return;
  }
  if (action === "confirm-kick") {
    const target = state.ui.kickTarget;
    state.ui.kickTarget = null;
    render();
    if (target) {
      await call(sessionPayload("kick", { targetClientId: target.clientId }));
    }
    return;
  }
  if (action === "primary" && requireName()) {
    const next = primaryActionFor(state.identity.clientId, state.session);
    const result = await call(sessionPayload(next, { note: trimmedActionNote(state.ui.actionNote), name: state.identity.name }));
    if (result) {
      state.ui.actionNote = "";
      state.ui.actionNoteOpen = false;
    }
  }
  if (!editingModal()) render();
});

document.addEventListener("input", (event) => {
  if (event.target.matches('textarea[name="actionNote"]')) {
    state.ui.actionNote = String(event.target.value || "").slice(0, actionNoteLimit);
  }
});

document.addEventListener("toggle", (event) => {
  if (event.target.matches("details[data-audit-log]")) {
    state.ui.auditOpen = event.target.open;
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!shouldWarnOnExit()) return;
  event.preventDefault();
  event.returnValue = "";
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    liveTime.cancel();
    return;
  }
  updateLiveRegions();
});

render();
setInterval(poll, 1500);
