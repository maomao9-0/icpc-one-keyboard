const app = document.querySelector("#app");
const api = "/api/session";
const defaults = { durationMs: 5 * 60 * 60 * 1000 };
const actionNoteLimit = 140;
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const liveTickSafetyMs = 20;
const requestExpiryRefreshDelayMs = 150;
const memberPresenceMs = 10 * 1000;

const state = {
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

function fmtClock(ms) {
  const safe = Math.max(0, ms);
  const h = Math.floor(safe / 3600000);
  const m = Math.floor((safe % 3600000) / 60000);
  const s = Math.floor((safe % 60000) / 1000);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function durationParts(ms) {
  const safe = Math.max(0, Number(ms) || defaults.durationMs);
  return {
    hours: Math.floor(safe / 3600000),
    minutes: Math.floor((safe % 3600000) / 60000),
    seconds: Math.floor((safe % 60000) / 1000),
  };
}

function durationFromFields(data) {
  return ((Number(data.hours) || 0) * 3600 + (Number(data.minutes) || 0) * 60 + (Number(data.seconds) || 0)) * 1000;
}

function at(event) {
  if (event?.timestampMode === "relative") {
    return `T+${fmtClock(event.clockMs)}`;
  }
  return timeFormatter.format(new Date(event?.clockMs || event?.time || Date.now()));
}

function remainingMsAt(session, now = Date.now()) {
  const base = Number(session?.remainingMs ?? session?.durationMs ?? defaults.durationMs);
  if (!session?.timerRunning || !session.runningSince) return Math.max(0, base);
  return Math.max(0, base - (now - session.runningSince));
}

function remainingMs(session) {
  return remainingMsAt(session);
}

function requestCountdownSeconds(req, now = Date.now()) {
  return Math.max(0, Math.ceil(Math.max(0, Number(req?.expiresAt || 0) - now) / 1000));
}

function nextClockBoundary(ms, now = Date.now()) {
  const safe = Math.max(0, Number(ms) || 0);
  if (!safe) return Infinity;
  const until = safe % 1000 || 1000;
  return now + until + liveTickSafetyMs;
}

function memberPresenceDeadline(seenAt, now = Date.now()) {
  const until = Number(seenAt || 0) + memberPresenceMs - now;
  if (until <= 0) return Infinity;
  return now + until + liveTickSafetyMs;
}

function sessionMemberEntries(session) {
  return Object.entries(session?.members || {}).map(([clientId, member]) => ({
    clientId,
    name: member.name,
    seenAt: Number(member.seenAt || 0),
  }));
}

function teammateSort(left, right) {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.clientId.localeCompare(right.clientId);
}

function memberPresence(member, now = Date.now()) {
  const online = now - member.seenAt < memberPresenceMs;
  return {
    online,
    text: online ? "online" : "idle",
    deadline: online ? memberPresenceDeadline(member.seenAt, now) : Infinity,
  };
}

function duration(ms = 0) {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }
  return `${Math.round(ms / 60000)}m`;
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
    const params = new URLSearchParams({
      code: state.identity.code,
      clientId: state.identity.clientId,
      name: state.identity.name,
    });
    const res = await fetch(`${api}?${params}`);
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
    if (state.network.syncIssue !== issue) {
      state.network.syncIssue = issue;
      if (!editingModal()) render();
    }
  }
}

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
  return {
    action: "leave",
    code: state.identity.code,
    clientId: state.identity.clientId,
    name: state.identity.name,
  };
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
  state.lifecycle.leaveSent = false;
  history.replaceState(null, "", "/");
  render();
}

function sendLeave() {
  const payload = leavePayload();
  if (!payload || state.lifecycle.leaveSent) return;
  state.lifecycle.leaveSent = true;
  const body = JSON.stringify(payload);
  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon(api, blob)) return;
  }
  fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

function joinView() {
  return `
    <section class="panel hero center">
      <p class="brand">ICPC practice control</p>
      <h1 class="title">One Keyboard</h1>
      <p class="subtitle">Create a tiny shared room, claim the keyboard when you are driving, and leave a readable audit trail for the whole team.</p>
      <form class="join" data-form="join">
        <label class="field">
          <span class="sr-only">Your name</span>
          <input name="name" placeholder="Your name…" value="${esc(state.identity.name)}" autocomplete="name" required>
        </label>
        <label class="field">
          <span class="sr-only">Session code</span>
          <input name="code" placeholder="Session code… e.g. AB2CDE" value="${esc(state.identity.code)}" maxlength="6" inputmode="text" autocomplete="off" spellcheck="false">
        </label>
        <div class="split">
          <button class="btn primary" name="intent" value="create" ${state.network.busy ? "disabled" : ""}>Create Session</button>
          <button class="btn ghost" name="intent" value="join" ${state.network.busy ? "disabled" : ""}>Join Session</button>
        </div>
      </form>
    </section>
  `;
}

function mainView() {
  const s = state.session;
  const holder = s.holder;
  const action = primaryAction(s);
  const free = action === "claim";
  const left = remainingMs(s);
  const latest = s.events.at(-1);
  const label = primaryActionLabel(action);
  const timerLabel = s.timerRunning ? "Stop timer" : "Start timer";
  return `
    <div class="topbar">
      <div>
        <div class="brand">One Keyboard</div>
        <div>Signed in as <strong>${esc(state.identity.name)}</strong>${state.network.syncIssue ? ` <span class="error">Sync issue</span>` : ""}</div>
      </div>
      <div class="topbar-actions">
        <span class="code">${s.code}</span>
        <button class="btn icon" type="button" data-action="settings" aria-label="Settings">${settingsIcon()}</button>
      </div>
    </div>
    <section class="status-grid">
      <article class="panel status-card">
        <div>
          <p class="label">Keyboard status</p>
          <h1 class="holder ${free ? "free" : ""}">${free ? "Unused" : esc(holder.name)}</h1>
        </div>
        <div class="action-stack">
          ${actionNoteComposer(action)}
          <button class="btn primary main" type="button" data-action="primary" ${state.network.busy ? "disabled" : ""}>${label}</button>
        </div>
      </article>
      <aside class="side">
        <section class="panel tile">
          <p class="label">Timer</p>
          <div class="timer" data-timer>${fmtClock(left)}</div>
          <div class="timer-actions">
            <button class="btn ghost" type="button" data-action="timer-toggle">${timerLabel}</button>
            <button class="btn ghost" type="button" data-action="timer-reset">Reset</button>
          </div>
          <p class="last">${s.timerRunning ? "Contest timer is running." : "Timer is paused."}</p>
        </section>
        <section class="panel tile">
          <p class="label">Last action</p>
          <details data-audit-log ${state.ui.auditOpen ? "open" : ""}>
            <summary class="last">${latest ? esc(latest.message) : "No keyboard activity yet."}</summary>
            <div class="log scroll-log">${logRows(s)}</div>
          </details>
        </section>
        <section class="panel tile compact teammates-card">
          <div class="teammates-head">
            <p class="label">TEAMMATES</p>
          </div>
          <div class="members">${teammateRows(s)}</div>
        </section>
      </aside>
    </section>
    ${requestPopup(s)}
    ${state.ui.leaveOpen ? leaveView() : ""}
    ${state.ui.kickTarget ? kickView() : ""}
    ${state.ui.settingsOpen ? settingsView() : ""}
  `;
}

function logRows(session) {
  if (!session.events.length) return `<div class="log-row"><span>--</span><span>No entries.</span></div>`;
  return session.events
    .slice()
    .reverse()
    .map((e) => `<div class="log-row"><span>${at(e)}</span><span><strong>${esc(e.name)}</strong> ${esc(e.text)}${e.durationMs ? ` for ${duration(e.durationMs)}` : ""}</span></div>`)
    .join("");
}

function settingsView() {
  const s = state.session;
  const link = `${location.origin}/?code=${s.code}`;
  const parts = durationParts(s.durationMs);
  return `
    <div class="modal" data-action="close-settings">
      <section class="panel modal-card" role="dialog" aria-modal="true" aria-label="Settings" data-stop>
        <div class="modal-head">
          <h2>Settings</h2>
          <button class="btn ghost" type="button" data-action="close-settings">Close</button>
        </div>
        <form class="settings" data-form="save-settings">
          <label class="setting-row"><span>Name</span><input name="name" value="${esc(state.identity.name)}" autocomplete="name" required></label>
          <label class="setting-row"><span>Join link</span><input name="link" value="${esc(link)}" readonly></label>
          <div class="split">
            <button class="btn ghost" type="button" data-action="copy-code">Copy Code</button>
            <button class="btn ghost" type="button" data-action="copy-link">Copy Link</button>
          </div>
          <div class="setting-row">
            <span>Duration</span>
            <div class="duration-grid">
              <label><input name="hours" type="number" min="0" max="24" step="1" value="${parts.hours}"><small>hours</small></label>
              <label><input name="minutes" type="number" min="0" max="59" step="1" value="${parts.minutes}"><small>minutes</small></label>
              <label><input name="seconds" type="number" min="0" max="59" step="1" value="${parts.seconds}"><small>seconds</small></label>
            </div>
          </div>
          <p class="last">Changing duration resets the timer to the new full length.</p>
          <button class="btn primary">Save settings</button>
        </form>
      </section>
    </div>
  `;
}

function leaveView() {
  const s = state.session;
  const hasHold = Boolean(s?.holder?.clientId === state.identity.clientId);
  return `
    <div class="modal leave-modal" data-action="close-leave">
      <section class="panel modal-card leave-card" role="dialog" aria-modal="true" aria-label="Leave session" data-stop>
        <div class="modal-head leave-head">
          <div>
            <p class="label">Leave session</p>
            <h2>Return to home?</h2>
          </div>
        </div>
        <p class="leave-copy">
          You will leave <strong>${esc(s.code)}</strong> and return to the create / join screen.
          ${hasHold ? "The keyboard will be released for the rest of the team." : "Your presence will be removed from the session."}
        </p>
        <div class="split">
          <button class="btn ghost" type="button" data-action="close-leave">Stay</button>
          <button class="btn primary danger" type="button" data-action="confirm-leave">Leave session</button>
        </div>
      </section>
    </div>
  `;
}

function kickView() {
  const target = state.ui.kickTarget;
  return `
    <div class="modal kick-modal" data-action="close-kick">
      <section class="panel modal-card kick-card" role="dialog" aria-modal="true" aria-label="Kick teammate" data-stop>
        <div class="modal-head leave-head">
          <div>
            <p class="label">Recovery action</p>
            <h2>Kick ${esc(target.name)}?</h2>
          </div>
        </div>
        <p class="leave-copy">
          This removes <strong>${esc(target.name)}</strong> from <strong>${esc(state.session.code)}</strong>.
        </p>
        <div class="split">
          <button class="btn ghost" type="button" data-action="close-kick">Cancel</button>
          <button class="btn primary danger" type="button" data-action="confirm-kick">Kick teammate</button>
        </div>
      </section>
    </div>
  `;
}

function settingsIcon() {
  return `
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20">
      <g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <path d="M4 6h8"/>
        <path d="M4 12h16"/>
        <path d="M12 18h8"/>
      </g>
      <circle cx="16" cy="6" r="2.25" fill="var(--paper)" stroke="currentColor" stroke-width="1.8"/>
      <circle cx="9" cy="12" r="2.25" fill="var(--paper)" stroke="currentColor" stroke-width="1.8"/>
      <circle cx="8" cy="18" r="2.25" fill="var(--paper)" stroke="currentColor" stroke-width="1.8"/>
    </svg>
  `;
}

function teammateRows(session) {
  const now = Date.now();
  const members = teammateEntries(session);
  if (!members.length) return `<div class="member muted">No teammates yet.</div>`;
  return members.map((member) => teammateRow(member, session, now)).join("");
}

function teammateEntries(session) {
  return sessionMemberEntries(session).sort(teammateSort);
}

function teammateRow(member, session, now = Date.now()) {
  const presence = memberPresence(member, now);
  const holder = session.holder?.clientId === member.clientId ? " holder-tag" : "";
  const self = member.clientId === state.identity.clientId;
  return `
    <div class="member${holder}${self ? " self" : ""}">
      <span>
        ${esc(member.name)}
      </span>
      ${
        self
          ? '<button class="member-leave" type="button" data-action="leave-session">Leave</button>'
          : `
            <span class="member-tools">
              <button class="member-kick" type="button" data-action="kick-member" data-client-id="${esc(member.clientId)}">Kick</button>
              <small data-member-status="${member.clientId}">${presence.text}</small>
            </span>
          `
      }
    </div>
  `;
}

function isCurrentMember(session = state.session) {
  return Boolean(session?.members?.[state.identity.clientId]);
}

function requestPopup(session) {
  const req = session.pendingRequest;
  if (!req || session.holder?.clientId !== state.identity.clientId) return "";
  const left = Math.max(0, Math.ceil((req.expiresAt - Date.now()) / 1000));
  return `
    <section class="request-pop panel" role="dialog" aria-label="Keyboard request">
      <div>
        <p class="label">Keyboard request</p>
        <strong>${esc(req.name)}</strong> wants the keyboard.
        ${req.note ? `<p class="request-note">${esc(req.note)}</p>` : ""}
        <span class="last">Auto-rejects in <span data-request-countdown>${left}</span>s.</span>
      </div>
      <div class="split">
        <button class="btn primary" type="button" data-action="request-accept">Release to ${esc(req.name)}</button>
        <button class="btn ghost" type="button" data-action="request-reject">Reject</button>
      </div>
    </section>
  `;
}

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function primaryAction(session = state.session) {
  const holder = session?.holder;
  if (!holder) return "claim";
  return holder.clientId === state.identity.clientId ? "release" : "request";
}

function primaryActionLabel(action) {
  return {
    claim: "Claim keyboard",
    release: "Release keyboard",
    request: "Request keyboard",
  }[action];
}

function actionNoteLabel(action) {
  return {
    claim: "Optional claim note",
    release: "Optional release note",
    request: "Optional request note",
  }[action];
}

function actionNotePlaceholder(action) {
  return {
    claim: "Optional note… Taking over to debug input parsing",
    release: "Optional note… Handing off with the timer paused",
    request: "Optional note… Need the keyboard for problem C",
  }[action];
}

function actionNoteHint(action) {
  return {
    claim: "Shown in team activity if you claim the keyboard.",
    release: "Shown in team activity if you release the keyboard.",
    request: "Shown in team activity and in the holder’s request popup.",
  }[action];
}

function actionNoteComposer(action) {
  const open = state.ui.actionNoteOpen;
  return `
    <div class="action-note${open ? " open" : ""}">
      <button
        class="note-toggle"
        type="button"
        data-action="toggle-note"
        aria-expanded="${open ? "true" : "false"}"
        aria-controls="action-note-field"
      >${state.ui.actionNote ? "Edit note" : "Add note…"}</button>
      ${
        open
          ? `
            <label class="note-field" for="action-note-field">
              <span class="sr-only">${actionNoteLabel(action)}</span>
              <textarea id="action-note-field" name="actionNote" rows="2" maxlength="${actionNoteLimit}" autocomplete="off" placeholder="${esc(actionNotePlaceholder(action))}" aria-label="${actionNoteLabel(action)}">${esc(state.ui.actionNote)}</textarea>
            </label>
            <div class="note-meta">
              <span>${actionNoteHint(action)}</span>
              ${
                state.ui.actionNote
                  ? '<button class="note-clear" type="button" data-action="clear-note">Clear</button>'
                  : ""
              }
            </div>
          `
          : ""
      }
    </div>
  `;
}

function currentActionNote() {
  return String(state.ui.actionNote || "").trim().slice(0, actionNoteLimit);
}

const liveTime = {
  timeoutId: null,
  frameId: null,
  expiryPolledRequestId: "",
  lastTexts: new Map(),

  cancel() {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
  },

  resetExpiryPoll() {
    this.expiryPolledRequestId = "";
  },

  refresh() {
    this.cancel();
    if (document.hidden) return;
    this.frameId = requestAnimationFrame(() => {
      this.frameId = null;
      this.flush();
    });
  },

  flush() {
    if (document.hidden) return;
    const now = Date.now();
    const deadlines = [];
    const rendered = [
      renderContestTimer(now),
      renderRequestCountdown(now),
      renderMemberPresence(now),
    ];

    for (const result of rendered) {
      if (!result) continue;
      for (const update of result.updates) {
        if (!update.el) continue;
        const cacheKey = update.key;
        if (this.lastTexts.get(cacheKey) === update.text) continue;
        update.el.textContent = update.text;
        this.lastTexts.set(cacheKey, update.text);
      }
      if (Number.isFinite(result.deadline)) deadlines.push(result.deadline);
      if (result.expiredRequestId && result.expiredRequestId !== this.expiryPolledRequestId) {
        this.expiryPolledRequestId = result.expiredRequestId;
        setTimeout(() => {
          void poll();
        }, requestExpiryRefreshDelayMs);
      }
    }

    const nextDeadline = Math.min(...deadlines, Infinity);
    if (!Number.isFinite(nextDeadline)) return;
    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      if (document.hidden) return;
      this.frameId = requestAnimationFrame(() => {
        this.frameId = null;
        this.flush();
      });
    }, Math.max(0, nextDeadline - Date.now()));
  },
};

function render() {
  app.innerHTML = state.session ? mainView() : joinView();
  if (state.ui.toast) {
    app.insertAdjacentHTML("beforeend", `<div class="toast" role="status" aria-live="polite">${esc(state.ui.toast)}</div>`);
  }
  updateLiveRegions();
}

app.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  if (form.dataset.form === "join") {
    state.lifecycle.leaveSent = false;
    state.identity.name = data.name.trim();
    state.identity.code = String(data.code || "").trim().toUpperCase();
    localStorage.setItem("name", state.identity.name);
    if (event.submitter.value === "create") {
      call({ action: "create", clientId: state.identity.clientId, name: state.identity.name, durationMs: defaults.durationMs });
    } else {
      call({ action: "join", code: state.identity.code, clientId: state.identity.clientId, name: state.identity.name });
    }
    requestNotifications();
  }
  if (form.dataset.form === "save-settings") {
    state.identity.name = data.name.trim();
    localStorage.setItem("name", state.identity.name);
    call({
      action: "settings",
      code: state.identity.code,
      clientId: state.identity.clientId,
      name: state.identity.name,
      timerEnabled: true,
      durationMs: durationFromFields(data),
    });
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
  if (action === "copy-code") copyText(state.identity.code, "Code copied.");
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
    await call({
      action: "timer",
      command: state.session.timerRunning ? "stop" : "start",
      code: state.identity.code,
      clientId: state.identity.clientId,
      name: state.identity.name,
    });
  }
  if (action === "timer-reset") {
    await call({ action: "timer", command: "reset", code: state.identity.code, clientId: state.identity.clientId, name: state.identity.name });
  }
  if (action === "request-accept") {
    await call({ action: "requestAccept", code: state.identity.code, clientId: state.identity.clientId, name: state.identity.name });
  }
  if (action === "request-reject") {
    await call({ action: "requestReject", code: state.identity.code, clientId: state.identity.clientId, name: state.identity.name });
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
      await call({
        action: "kick",
        code: state.identity.code,
        clientId: state.identity.clientId,
        name: state.identity.name,
        targetClientId: target.clientId,
      });
    }
    return;
  }
  if (action === "primary" && requireName()) {
    const next = primaryAction(state.session);
    const result = await call({
      action: next,
      code: state.identity.code,
      clientId: state.identity.clientId,
      name: state.identity.name,
      note: currentActionNote(),
    });
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

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  sendLeave();
});

render();
setInterval(poll, 1500);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    liveTime.cancel();
    return;
  }
  updateLiveRegions();
});

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

function sessionFingerprint(session) {
  if (!session) return "";
  const members = sessionMemberEntries(session)
    .sort((left, right) => left.clientId.localeCompare(right.clientId))
    .map(({ clientId, name }) => ({ clientId, name }));
  const events = (session.events || []).map(({ id, time, clientId, name, text, message, durationMs, timestampMode, clockMs }) => ({
    id,
    time,
    clientId,
    name,
    text,
    message,
    durationMs,
    timestampMode,
    clockMs,
  }));
  return JSON.stringify({
    code: session.code,
    clockMode: session.clockMode || "local",
    durationMs: session.durationMs,
    remainingMs: session.remainingMs,
    timerEnabled: Boolean(session.timerEnabled),
    timerRunning: Boolean(session.timerRunning),
    runningSince: session.runningSince || null,
    holder: session.holder ? { ...session.holder } : null,
    pendingRequest: session.pendingRequest
      ? {
          id: session.pendingRequest.id,
          clientId: session.pendingRequest.clientId,
          name: session.pendingRequest.name,
          note: session.pendingRequest.note || "",
          requestedAt: session.pendingRequest.requestedAt,
        }
      : null,
    members,
    events,
  });
}

function renderContestTimer(now) {
  const timer = document.querySelector("[data-timer]");
  const session = state.session;
  if (!timer || !session) return null;
  const left = remainingMsAt(session, now);
  return {
    updates: [{ key: "contest-timer", el: timer, text: fmtClock(left) }],
    deadline: session.timerRunning ? nextClockBoundary(left, now) : Infinity,
  };
}

function renderRequestCountdown(now) {
  const el = document.querySelector("[data-request-countdown]");
  const req = state.session?.pendingRequest;
  if (!el || !req) return null;
  const leftMs = Math.max(0, Number(req.expiresAt || 0) - now);
  const seconds = requestCountdownSeconds(req, now);
  return {
    updates: [{ key: "request-countdown", el, text: String(seconds) }],
    deadline: seconds > 0 ? nextClockBoundary(leftMs, now) : Infinity,
    expiredRequestId: seconds === 0 ? req.id : "",
  };
}

function renderMemberPresence(now) {
  const session = state.session;
  if (!session) return null;
  const updates = [];
  let deadline = Infinity;
  teammateEntries(session).forEach((member) => {
    const badge = document.querySelector(`[data-member-status="${member.clientId}"]`);
    if (!badge) return;
    const presence = memberPresence(member, now);
    updates.push({ key: `member-status:${member.clientId}`, el: badge, text: presence.text });
    deadline = Math.min(deadline, presence.deadline);
  });
  if (!updates.length) return null;
  return { updates, deadline };
}
