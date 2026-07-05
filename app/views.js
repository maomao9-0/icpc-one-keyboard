import { actionNoteLimit, state } from "./state.js";
import {
  actionNoteHint,
  actionNoteLabel,
  actionNotePlaceholder,
  at,
  duration,
  durationParts,
  esc,
  fmtClock,
  memberPresence,
  primaryActionFor,
  primaryActionLabel,
  remainingMs,
  requestCountdownSeconds,
  teammateEntries,
} from "./helpers.js";

export function viewMarkup() {
  return state.session ? mainView() : joinView();
}

function joinView() {
  return `
    <section class="panel hero center">
      <p class="brand">ICPC practice</p>
      <h1 class="title">One Keyboard</h1>
      <p class="subtitle">Create a shared room, claim the keyboard when you are typing, and leave a readable audit trail for the whole team.</p>
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
  const session = state.session;
  const action = primaryActionFor(state.identity.clientId, session);
  const free = action === "claim";
  const latest = session.events.at(-1);
  const left = remainingMs(session);
  const timerLabel = session.timerRunning ? "Stop timer" : "Start timer";
  return `
    <div class="topbar">
      <div>
        <div class="brand">One Keyboard</div>
        <div>Signed in as <strong>${esc(state.identity.name)}</strong>${state.network.syncIssue ? ` <span class="error">Sync issue</span>` : ""}</div>
      </div>
      <div class="topbar-actions">
        <span class="code">${session.code}</span>
        <button class="btn icon" type="button" data-action="settings" aria-label="Settings">${settingsIcon()}</button>
      </div>
    </div>
    <section class="status-grid">
      <article class="panel status-card">
        <div>
          <p class="label">Keyboard status</p>
          <h1 class="holder ${free ? "free" : ""}">${free ? "Unused" : esc(session.holder.name)}</h1>
        </div>
        <div class="action-stack">
          ${actionNoteComposer(action)}
          <button class="btn primary main" type="button" data-action="primary" ${state.network.busy ? "disabled" : ""}>${primaryActionLabel(action)}</button>
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
          <p class="last">${session.timerRunning ? "Contest timer is running." : "Timer is paused."}</p>
        </section>
        <section class="panel tile">
          <p class="label">Last action</p>
          <details data-audit-log ${state.ui.auditOpen ? "open" : ""}>
            <summary class="last">${latest ? esc(latest.message) : "No keyboard activity yet."}</summary>
            <div class="log scroll-log">${logRows(session)}</div>
          </details>
        </section>
        <section class="panel tile compact teammates-card">
          <div class="teammates-head">
            <p class="label">TEAMMATES</p>
          </div>
          <div class="members">${teammateRows(session)}</div>
        </section>
      </aside>
    </section>
    ${requestPopup(session)}
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
    .map((event) => `<div class="log-row"><span>${at(event)}</span><span><strong>${esc(event.name)}</strong> ${esc(event.text)}${event.durationMs ? ` for ${duration(event.durationMs)}` : ""}</span></div>`)
    .join("");
}

function settingsView() {
  const session = state.session;
  const parts = durationParts(session.durationMs);
  const link = `${location.origin}/?code=${session.code}`;
  return `
    <div class="modal" data-action="close-settings">
      <section class="panel modal-card" role="dialog" aria-modal="true" aria-label="Settings" data-stop>
        <div class="modal-head">
          <h2>Settings</h2>
          <button class="btn ghost" type="button" data-action="close-settings">Close</button>
        </div>
        <form class="settings" data-form="save-settings">
          <label class="setting-row"><span>Name</span><input name="name" value="${esc(state.identity.name)}" readonly></label>
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
  const hasHold = state.session?.holder?.clientId === state.identity.clientId;
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
          You will leave <strong>${esc(state.session.code)}</strong> and return to the create / join screen.
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

function teammateRows(session) {
  const now = Date.now();
  const members = teammateEntries(session);
  if (!members.length) return `<div class="member muted">No teammates yet.</div>`;
  return members.map((member) => teammateRow(member, session, now)).join("");
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

function requestPopup(session) {
  const request = session.pendingRequest;
  if (!request || session.holder?.clientId !== state.identity.clientId) return "";
  return `
    <section class="request-pop panel" role="dialog" aria-label="Keyboard request">
      <div>
        <p class="label">Keyboard request</p>
        <strong>${esc(request.name)}</strong> wants the keyboard.
        ${request.note ? `<p class="request-note">${esc(request.note)}</p>` : ""}
        <span class="last">Auto-rejects in <span data-request-countdown>${requestCountdownSeconds(request)}</span>s.</span>
      </div>
      <div class="split">
        <button class="btn primary" type="button" data-action="request-accept">Release to ${esc(request.name)}</button>
        <button class="btn ghost" type="button" data-action="request-reject">Reject</button>
      </div>
    </section>
  `;
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
