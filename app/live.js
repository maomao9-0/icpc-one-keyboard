import { requestExpiryRefreshDelayMs, state } from "./state.js";
import {
  fmtClock,
  memberPresence,
  nextClockBoundary,
  remainingMsAt,
  requestCountdownSeconds,
  teammateEntries,
} from "./helpers.js";

export function createLiveTime({ poll }) {
  return {
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
          if (this.lastTexts.get(update.key) === update.text) continue;
          update.el.textContent = update.text;
          this.lastTexts.set(update.key, update.text);
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
  const request = state.session?.pendingRequest;
  if (!el || !request) return null;
  const leftMs = Math.max(0, Number(request.expiresAt || 0) - now);
  const seconds = requestCountdownSeconds(request, now);
  return {
    updates: [{ key: "request-countdown", el, text: String(seconds) }],
    deadline: seconds > 0 ? nextClockBoundary(leftMs, now) : Infinity,
    expiredRequestId: seconds === 0 ? request.id : "",
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
