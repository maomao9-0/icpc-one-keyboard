import { useMemo } from "react";
import {
  analysisSnapshot,
  formatAnalysisDuration,
  formatPercent,
} from "../lib/analysis.js";
import { formatClock } from "../lib/session.js";

const axisStops = [0, 0.25, 0.5, 0.75, 1];

export function AnalysisView({ session, now, onBack }) {
  const report = useMemo(() => analysisSnapshot(session, now), [session, now]);

  return (
    <main className="analysis-shell" data-analysis-page>
      <header className="analysis-topbar">
        <button className="analysis-back" type="button" onClick={onBack}>
          <span aria-hidden="true">←</span> Back to session
        </button>
        <div className="analysis-session">
          <span>{report.complete ? "Final report" : "Live snapshot"}</span>
          <strong>{session.code}</strong>
        </div>
      </header>

      <section className="analysis-hero analysis-reveal">
        <div>
          <p className="analysis-kicker">One Keyboard / Contest debrief</p>
          <h1>
            The relay,
            <br />
            at a glance.
          </h1>
        </div>
        <div className="analysis-clock-block">
          <span>
            {report.complete ? "Contest complete" : "Contest elapsed"}
          </span>
          <strong>{formatClock(report.elapsedMs)}</strong>
          <small>of {formatClock(report.durationMs)}</small>
        </div>
      </section>

      {!report.started ? (
        <EmptyAnalysis />
      ) : (
        <>
          {report.untrackedMs > 0 ? (
            <p className="analysis-notice" role="status">
              Earlier activity from this in-progress session could not be
              reconstructed. New activity is tracked precisely.
            </p>
          ) : null}
          <Summary report={report} />
          <Timeline report={report} />
          <TeamBreakdown report={report} />
          <Insights report={report} />
        </>
      )}
    </main>
  );
}

function EmptyAnalysis() {
  return (
    <section className="analysis-empty analysis-reveal">
      <span className="empty-mark" aria-hidden="true">
        00
      </span>
      <div>
        <p className="analysis-kicker">Waiting for the first tick</p>
        <h2>No contest data yet.</h2>
        <p>
          Start the timer to begin tracking keyboard time, free time, handoffs,
          and the team relay.
        </p>
      </div>
    </section>
  );
}

function Summary({ report }) {
  const answered =
    report.requests.accepted +
    report.requests.rejected +
    report.requests.expired;
  const stats = [
    [
      "Keyboard in use",
      formatAnalysisDuration(report.heldMs),
      formatPercent(report.utilization),
    ],
    [
      "Keyboard free",
      formatAnalysisDuration(report.freeMs),
      formatPercent(report.elapsedMs ? report.freeMs / report.elapsedMs : 0),
    ],
    [
      "Average hold",
      formatAnalysisDuration(report.averageHoldMs),
      `${report.turns} turn${report.turns === 1 ? "" : "s"}`,
    ],
    [
      "Transitions",
      String(report.transitions),
      `${report.handoffs} direct handoff${report.handoffs === 1 ? "" : "s"}`,
    ],
    ["Requests", String(report.requests.total), `${answered} resolved`],
  ];
  return (
    <section
      className="analysis-stats analysis-reveal"
      aria-label="Contest summary"
    >
      {stats.map(([label, value, detail], index) => (
        <article
          className="analysis-stat"
          key={label}
          style={{ "--delay": `${index * 55}ms` }}
        >
          <span>{label}</span>
          <strong>{value}</strong>
          <small>{detail}</small>
        </article>
      ))}
    </section>
  );
}

function Timeline({ report }) {
  const rows = report.members.map((member) => ({
    id: member.clientId,
    name: member.name,
    palette: member.palette,
  }));
  rows.push({ id: null, name: "Free", palette: "free" });
  if (report.untrackedMs > 0)
    rows.push({
      id: "__untracked__",
      name: "Earlier activity",
      palette: "untracked",
    });

  const elapsedWidth = `${Math.min(100, (report.elapsedMs / report.durationMs) * 100)}%`;
  return (
    <section
      className="analysis-section timeline-card analysis-reveal"
      aria-labelledby="relay-title"
    >
      <div className="analysis-section-head">
        <div>
          <p className="analysis-kicker">Keyboard relay</p>
          <h2 id="relay-title">Who drove, and when</h2>
        </div>
        <p>Paused time is excluded from this active contest clock.</p>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-plot">
          <div className="timeline-axis" aria-hidden="true">
            <span />
            <div>
              {axisStops.map((stop) => (
                <span key={stop} style={{ left: `${stop * 100}%` }}>
                  {formatAnalysisDuration(report.durationMs * stop)}
                </span>
              ))}
            </div>
          </div>
          {rows.map((row) => (
            <div className="timeline-row" key={row.id ?? "free"}>
              <div className="timeline-name">
                <i className={`timeline-key palette-${row.palette}`} />
                <span title={row.name}>{row.name}</span>
              </div>
              <div className="timeline-track">
                <div
                  className="timeline-elapsed"
                  style={{ width: elapsedWidth }}
                />
                {report.timeline
                  .filter((interval) => interval.clientId === row.id)
                  .map((interval, index) => {
                    const left = (interval.startMs / report.durationMs) * 100;
                    const width =
                      ((interval.endMs - interval.startMs) /
                        report.durationMs) *
                      100;
                    const label = `${interval.name}: ${formatAnalysisDuration(interval.startMs)} to ${formatAnalysisDuration(interval.endMs)}`;
                    return (
                      <span
                        className={`timeline-block palette-${interval.palette}`}
                        key={`${interval.startMs}-${index}`}
                        style={{
                          left: `${left}%`,
                          width: `${Math.max(width, 0.16)}%`,
                        }}
                        aria-label={label}
                        title={label}
                      />
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TeamBreakdown({ report }) {
  return (
    <section
      className="analysis-section team-report analysis-reveal"
      aria-labelledby="team-report-title"
    >
      <div className="analysis-section-head">
        <div>
          <p className="analysis-kicker">Team breakdown</p>
          <h2 id="team-report-title">Time at the controls</h2>
        </div>
        <p>Current turns are included in averages and longest holds.</p>
      </div>
      {report.members.length ? (
        <div
          className="team-table"
          role="table"
          aria-label="Teammate keyboard statistics"
        >
          <div className="team-table-head" role="row">
            <span role="columnheader">Teammate</span>
            <span role="columnheader">Total / share</span>
            <span role="columnheader">Turns</span>
            <span role="columnheader">Average</span>
            <span role="columnheader">Longest</span>
            <span role="columnheader">Requests</span>
          </div>
          {report.members.map((member, index) => (
            <div className="team-table-row" role="row" key={member.clientId}>
              <div className="team-person" role="cell">
                <span className="team-rank">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <i className={`timeline-key palette-${member.palette}`} />
                <strong>{member.name}</strong>
              </div>
              <div className="team-total" role="cell">
                <strong>{formatAnalysisDuration(member.heldMs)}</strong>
                <span>{formatPercent(member.share)}</span>
                <i>
                  <span
                    style={{ width: `${Math.min(100, member.share * 100)}%` }}
                  />
                </i>
              </div>
              <span role="cell" data-label="Turns">
                {member.turns}
              </span>
              <span role="cell" data-label="Average">
                {formatAnalysisDuration(member.averageMs)}
              </span>
              <span role="cell" data-label="Longest">
                {formatAnalysisDuration(member.longestMs)}
              </span>
              <span role="cell" data-label="Requests">
                {member.requests}
                {member.requests ? (
                  <small>{member.fulfilledRequests} fulfilled</small>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="analysis-muted">
          No teammate held the keyboard during active contest time.
        </p>
      )}
    </section>
  );
}

function Insights({ report }) {
  const leader = report.members[0];
  const requestRate = report.requests.total
    ? report.requests.accepted / report.requests.total
    : 0;
  const cards = [
    {
      number: "01",
      title: leader
        ? `${leader.name} led the relay`
        : "The keyboard stayed free",
      copy: leader
        ? `${formatAnalysisDuration(leader.heldMs)} at the controls, accounting for ${formatPercent(leader.share)} of elapsed contest time.`
        : "No keyboard holding time has been recorded yet.",
    },
    {
      number: "02",
      title: report.longest?.durationMs
        ? "Longest uninterrupted run"
        : "No completed run yet",
      copy: report.longest?.durationMs
        ? `${report.longest.name} held the keyboard for ${formatAnalysisDuration(report.longest.durationMs)} in their longest turn.`
        : "Hold the keyboard during active contest time to establish a longest run.",
    },
    {
      number: "03",
      title: report.requests.total
        ? `${formatPercent(requestRate)} of requests fulfilled`
        : "No keyboard requests",
      copy: report.requests.total
        ? `${report.requests.accepted} accepted, ${report.requests.rejected} rejected, and ${report.requests.expired} expired.`
        : "The team coordinated without using the request queue.",
    },
  ];
  return (
    <section
      className="analysis-insights analysis-reveal"
      aria-label="Contest observations"
    >
      {cards.map((card) => (
        <article key={card.number}>
          <span>{card.number}</span>
          <h3>{card.title}</h3>
          <p>{card.copy}</p>
        </article>
      ))}
    </section>
  );
}
