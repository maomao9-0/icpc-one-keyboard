import { useEffect, useState } from "react";
import {
  CopyIcon,
  LeaveIcon,
  SettingsIcon,
} from "./components/Icons.jsx";
import { useSessionController } from "./hooks/useSessionController.js";
import { useLiveNow } from "./hooks/useLiveNow.js";
import {
  ACTION_NOTE_LIMIT,
  DEFAULT_DURATION_MS,
  actionLabel,
  durationFromFields,
  durationParts,
  eventTime,
  formatClock,
  formatCountdown,
  formatDuration,
  isOnline,
  memberEntries,
  primaryAction,
  remainingMs,
  requestSeconds,
} from "./lib/session.js";

const noteCopy = {
  claim: [
    "Optional claim note",
    "Optional note… Taking over to debug input parsing",
    "Shown in team activity if you claim the keyboard.",
  ],
  release: [
    "Optional release note",
    "Optional note… Handing off with the timer paused",
    "Shown in team activity if you release the keyboard.",
  ],
  request: [
    "Optional request note",
    "Optional note… Need the keyboard for problem C",
    "Shown in team activity and in the holder’s request popup.",
  ],
};

export default function App() {
  const controller = useSessionController();
  const {
    identity,
    session,
    busy,
    syncIssue,
    toast,
    call,
    poll,
    updateIdentity,
    requestNotifications,
  } = controller;
  const [modal, setModal] = useState(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const now = useLiveNow(session, poll);

  useEffect(() => {
    const warn = (event) => {
      const holder = session?.holder?.clientId === identity.clientId;
      if (!holder && !(session?.timerRunning && remainingMs(session) > 0))
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [
    identity.clientId,
    session?.holder?.clientId,
    session?.timerRunning,
    session?.runningSince,
    session?.remainingMs,
  ]);

  const submitJoin = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    const code = String(form.get("code") || "")
      .trim()
      .toUpperCase();
    updateIdentity({ name, code });
    // The payload must use the submitted values, not the asynchronous state update.
    const action =
      event.nativeEvent.submitter?.value === "create" ? "create" : "join";
    const result = await call(action, {
      name,
      code,
      ...(action === "create" ? { durationMs: DEFAULT_DURATION_MS } : {}),
    });
    if (result) requestNotifications();
  };

  const act = async () => {
    const action = primaryAction(identity.clientId, session);
    const result = await call(action, {
      name: identity.name,
      note: note.trim().slice(0, ACTION_NOTE_LIMIT),
    });
    if (result) {
      setNote("");
      setNoteOpen(false);
    }
  };

  if (!session)
    return (
      <main className="shell">
        <JoinView identity={identity} busy={busy} onSubmit={submitJoin} />
        {toast && <Toast text={toast} />}
      </main>
    );

  const action = primaryAction(identity.clientId, session);
  return (
    <main className="shell">
      <div className="topbar">
        <div className="topbar-copy">
          <div className="brand">One Keyboard</div>
          <div className="signed-in">
            Signed in as <strong>{identity.name}</strong>
            {syncIssue ? (
              <>
                {" "}
                <span className="error" role="status">
                  Sync issue
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="topbar-actions">
          <span className="code-chip">
            <span className="code-label">Session</span>
            <span className="code">{session.code}</span>
          </span>
          <button
            className="btn utility-btn icon"
            type="button"
            onClick={() => setModal("settings")}
          >
            <SettingsIcon />
            <span>Settings</span>
          </button>
        </div>
      </div>
      <section className="status-grid">
        <article className="panel status-card">
          <div>
            <p className="label">Keyboard status</p>
            <h1 className={`holder ${action === "claim" ? "free" : ""}`}>
              {action === "claim" ? "Unused" : session.holder.name}
            </h1>
          </div>
          <div className="action-stack">
            <NoteComposer
              action={action}
              open={noteOpen}
              note={note}
              onToggle={() => setNoteOpen((open) => !open)}
              onChange={setNote}
              onClear={() => {
                setNote("");
                setNoteOpen(false);
              }}
            />
            <button
              className="btn primary main"
              type="button"
              disabled={busy}
              onClick={act}
            >
              {actionLabel(action)}
            </button>
          </div>
        </article>
        <aside className="side">
          <Timer session={session} now={now} busy={busy} onCall={call} />
          <Audit session={session} open={auditOpen} onToggle={setAuditOpen} />
          <Members
            session={session}
            clientId={identity.clientId}
            now={now}
            onLeave={() => setModal("leave")}
            onKick={(member) => setModal({ type: "kick", member })}
          />
        </aside>
      </section>
      {session.pendingRequest &&
      session.holder?.clientId === identity.clientId ? (
        <RequestPopup
          request={session.pendingRequest}
          now={now}
          busy={busy}
          onCall={call}
        />
      ) : null}
      {modal === "settings" ? (
        <Settings
          session={session}
          name={identity.name}
          busy={busy}
          onClose={() => setModal(null)}
          onSave={async (values) => {
            const result = await call("settings", {
              timerEnabled: true,
              durationMs: durationFromFields(values),
            });
            if (result) setModal(null);
          }}
          onCopy={() => void copyLink(session.code, controller.showToast)}
        />
      ) : null}
      {modal === "leave" ? (
        <Confirm
          kind="leave"
          session={session}
          clientId={identity.clientId}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={() => {
            setModal(null);
            void call("leave");
          }}
        />
      ) : null}
      {modal?.type === "kick" ? (
        <Confirm
          kind="kick"
          session={session}
          target={modal.member}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={() => {
            const targetClientId = modal.member.clientId;
            setModal(null);
            void call("kick", { targetClientId });
          }}
        />
      ) : null}
      {toast && <Toast text={toast} />}
    </main>
  );
}

function JoinView({ identity, busy, onSubmit }) {
  return (
    <section className="panel hero center">
      <p className="brand">ICPC practice</p>
      <h1 className="title">One Keyboard</h1>
      <p className="subtitle">
        Create a shared room, claim the keyboard when you are typing, and leave
        a readable audit trail for the whole team.
      </p>
      <form className="join" onSubmit={onSubmit}>
        <label className="field">
          <span className="sr-only">Your name</span>
          <input
            name="name"
            placeholder="Your name…"
            defaultValue={identity.name}
            autoComplete="name"
            required
          />
        </label>
        <label className="field">
          <span className="sr-only">Session code</span>
          <input
            name="code"
            placeholder="Session code… e.g. AB2CDE"
            defaultValue={identity.code}
            maxLength="6"
            autoComplete="off"
            spellCheck="false"
          />
        </label>
        <div className="split">
          <button
            className="btn primary"
            name="intent"
            value="create"
            disabled={busy}
          >
            Create Session
          </button>
          <button
            className="btn ghost"
            name="intent"
            value="join"
            disabled={busy}
          >
            Join Session
          </button>
        </div>
      </form>
    </section>
  );
}

function Timer({ session, now, busy, onCall }) {
  return (
    <section className="panel tile">
      <p className="label">Timer</p>
      <div className="timer" data-timer>
        {formatCountdown(remainingMs(session, now))}
      </div>
      <div className="timer-actions">
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() =>
            void onCall("timer", {
              command: session.timerRunning ? "stop" : "start",
            })
          }
        >
          {session.timerRunning ? "Stop timer" : "Start timer"}
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => void onCall("timer", { command: "reset" })}
        >
          Reset
        </button>
      </div>
      <p className="last">
        {session.timerRunning
          ? "Contest timer is running."
          : "Timer is paused."}
      </p>
    </section>
  );
}

function Audit({ session, open, onToggle }) {
  const latest = session.events.at(-1);
  return (
    <section className="panel tile">
      <p className="label">Last action</p>
      <details
        data-audit-log
        open={open}
        onToggle={(event) => onToggle(event.currentTarget.open)}
      >
        <summary className="last">
          {latest?.message || "No keyboard activity yet."}
        </summary>
        <div className="log scroll-log">
          {session.events.length ? (
            [...session.events].reverse().map((event) => (
              <div className="log-row" key={event.id}>
                <span>{eventTime(event)}</span>
                <span>
                  <strong>{event.name}</strong> {event.text}
                  {event.durationMs
                    ? ` for ${formatDuration(event.durationMs)}`
                    : ""}
                </span>
              </div>
            ))
          ) : (
            <div className="log-row">
              <span>--</span>
              <span>No entries.</span>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}

function Members({ session, clientId, now, onLeave, onKick }) {
  const members = memberEntries(session);
  return (
    <section className="panel tile compact teammates-card">
      <div className="teammates-head">
        <p className="label">Teammates</p>
      </div>
      <div className="members">
        {members.map((member) => {
          const self = member.clientId === clientId;
          return (
            <div
              className={`member ${session.holder?.clientId === member.clientId ? "holder-tag" : ""} ${self ? "self" : ""}`}
              key={member.clientId}
            >
              <span>{member.name}</span>
              {self ? (
                <button
                  className="member-action member-leave"
                  type="button"
                  onClick={onLeave}
                >
                  <LeaveIcon />
                  <span>Leave</span>
                </button>
              ) : (
                <span className="member-tools">
                  <button
                    className="member-kick"
                    type="button"
                    data-client-id={member.clientId}
                    onClick={() => onKick(member)}
                  >
                    Kick
                  </button>
                  <small data-member-status={member.clientId}>
                    {isOnline(member, now) ? "online" : "idle"}
                  </small>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function NoteComposer({ action, open, note, onToggle, onChange, onClear }) {
  const [label, placeholder, hint] = noteCopy[action];
  return (
    <div className={`action-note ${open ? "open" : ""}`}>
      <button
        className="note-toggle"
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="action-note-field"
      >
        {note ? "Edit note" : "Add note…"}
      </button>
      {open ? (
        <>
          <label className="note-field" htmlFor="action-note-field">
            <span className="sr-only">{label}</span>
            <textarea
              id="action-note-field"
              name="actionNote"
              rows="2"
              maxLength={ACTION_NOTE_LIMIT}
              value={note}
              onChange={(event) =>
                onChange(event.target.value.slice(0, ACTION_NOTE_LIMIT))
              }
              autoComplete="off"
              placeholder={placeholder}
              aria-label={label}
            />
          </label>
          <div className="note-meta">
            <span>{hint}</span>
            {note ? (
              <button className="note-clear" type="button" onClick={onClear}>
                Clear
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function RequestPopup({ request, now, busy, onCall }) {
  return (
    <section
      className="request-pop panel"
      role="dialog"
      aria-label="Keyboard request"
    >
      <div>
        <p className="label">Keyboard request</p>
        <strong>{request.name}</strong> wants the keyboard.
        {request.note ? <p className="request-note">{request.note}</p> : null}
        <span className="last">
          Auto-rejects in{" "}
          <span data-request-countdown>{requestSeconds(request, now)}</span>s.
        </span>
      </div>
      <div className="split">
        <button
          className="btn primary"
          type="button"
          disabled={busy}
          onClick={() => void onCall("requestAccept")}
        >
          Release to {request.name}
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => void onCall("requestReject")}
        >
          Reject
        </button>
      </div>
    </section>
  );
}

function Settings({ session, name, busy, onClose, onSave, onCopy }) {
  useEscape(onClose);
  const parts = durationParts(session.durationMs);
  return (
    <div
      className="modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="panel modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="modal-head">
          <h2>Settings</h2>
          <button
            className="btn ghost"
            type="button"
            onClick={onClose}
            autoFocus
          >
            Close
          </button>
        </div>
        <form
          className="settings"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(Object.fromEntries(new FormData(event.currentTarget)));
          }}
        >
          <div className="setting-row">
            <span>Name</span>
            <output className="setting-value">{name}</output>
          </div>
          <div className="setting-row">
            <span>Join link</span>
            <div className="setting-value-row">
              <output className="setting-value">{`${location.origin}/?code=${session.code}`}</output>
              <button
                className="btn setting-copy-btn"
                type="button"
                onClick={onCopy}
                aria-label="Copy join link"
                title="Copy join link"
              >
                <CopyIcon />
              </button>
            </div>
          </div>
          <div className="setting-row">
            <span>Duration</span>
            <div className="duration-grid">
              <label>
                <input
                  name="hours"
                  type="number"
                  min="0"
                  max="24"
                  step="1"
                  defaultValue={parts.hours}
                />
                <small>hours</small>
              </label>
              <label>
                <input
                  name="minutes"
                  type="number"
                  min="0"
                  max="59"
                  step="1"
                  defaultValue={parts.minutes}
                />
                <small>minutes</small>
              </label>
              <label>
                <input
                  name="seconds"
                  type="number"
                  min="0"
                  max="59"
                  step="1"
                  defaultValue={parts.seconds}
                />
                <small>seconds</small>
              </label>
            </div>
          </div>
          <p className="last">
            Changing duration resets the timer to the new full length.
          </p>
          <button className="btn primary" disabled={busy}>
            Save settings
          </button>
        </form>
      </section>
    </div>
  );
}

function Confirm({
  kind,
  session,
  target,
  clientId,
  busy,
  onClose,
  onConfirm,
}) {
  useEscape(onClose);
  const leave = kind === "leave";
  const holder = leave
    ? session.holder?.clientId === clientId
    : session.holder?.clientId === target?.clientId;
  return (
    <div
      className={`modal ${leave ? "leave-modal" : "kick-modal"}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`panel modal-card ${leave ? "leave-card" : "kick-card"}`}
        role="dialog"
        aria-modal="true"
        aria-label={leave ? "Leave session" : "Kick teammate"}
      >
        <div className="modal-head leave-head">
          <div>
            <p className="label">
              {leave ? "Leave session" : "Recovery action"}
            </p>
            <h2>{leave ? "Return to home?" : `Kick ${target.name}?`}</h2>
          </div>
        </div>
        <p className="leave-copy">
          {leave ? (
            <>
              You will leave <strong>{session.code}</strong> and return to the
              create / join screen.{" "}
              {holder
                ? "The keyboard will be released for the rest of the team."
                : "Your presence will be removed from the session."}
            </>
          ) : (
            <>
              This removes <strong>{target.name}</strong> from{" "}
              <strong>{session.code}</strong>
              {holder ? " and releases the keyboard." : "."}
            </>
          )}
        </p>
        <div className="split">
          <button
            className="btn ghost"
            type="button"
            onClick={onClose}
            disabled={busy}
            autoFocus
          >
            {leave ? "Stay" : "Cancel"}
          </button>
          <button
            className="btn primary danger"
            type="button"
            onClick={onConfirm}
            disabled={busy}
          >
            {leave ? "Leave session" : "Kick teammate"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Toast({ text }) {
  return (
    <div className="toast" role="status" aria-live="polite">
      {text}
    </div>
  );
}

function useEscape(onEscape) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onEscape();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onEscape]);
}

async function copyLink(code, showToast) {
  try {
    if (!navigator.clipboard?.writeText)
      throw new Error("Clipboard access is unavailable.");
    await navigator.clipboard.writeText(`${location.origin}/?code=${code}`);
    showToast("Link copied.");
  } catch {
    showToast("Could not copy.", true);
  }
}
