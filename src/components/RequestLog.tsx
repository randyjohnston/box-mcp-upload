"use client";
import { useState } from "react";
import type { RequestEvent } from "../request-event";
export type Attempt = RequestEvent & {
  key: string;
  time: string;
  route: string;
  file: string;
  reason: string;
};
export default function RequestLog({
  rows,
  clear,
}: {
  rows: Attempt[];
  clear: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const shown = rows.filter(
    (row) =>
      filter === "all" ||
      (filter === "errors"
        ? !row.ok && !row.expected
        : (row.transport ?? "Browser → Next.js server").startsWith(filter)),
  );
  return (
    <section className="card activity" aria-labelledby="activity-title">
      <div className="section-heading">
        <div>
          <h2 id="activity-title">
            Request trace <span className="count">{rows.length}</span>
          </h2>
        </div>
        <div className="log-controls">
          <label className="visually-hidden" htmlFor="request-filter">
            Filter requests
          </label>
          <select
            id="request-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All requests</option>
            <option value="Browser → Box">Browser → Box</option>
            <option value="Next.js server">Next.js server → Box</option>
            <option value="errors">Failures</option>
          </select>
          <button className="text-button" onClick={clear}>
            Clear log
          </button>
        </div>
      </div>
      <p className="workbench-help">
        Latest 120 events · retained in this tab across sign-in · tokens and
        payloads excluded.
      </p>
      {!shown.length ? (
        <p className="empty">
          Connect an app or upload a file to inspect requests.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="activity-table">
            <caption className="visually-hidden">
              Individual network requests and transport decisions
            </caption>
            <thead>
              <tr>
                <th>Time</th>
                <th>Credential / actor</th>
                <th>Operation</th>
                <th>Request</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Routing decision</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.key} data-ok={row.ok || Boolean(row.expected)}>
                  <td className="mono">{row.time}</td>
                  <td>
                    {row.route}
                    <small>{row.transport ?? "Browser → Next.js server"}</small>
                  </td>
                  <td>
                    {row.step}
                    <small>{row.file}</small>
                  </td>
                  <td className="mono">
                    {row.method} {row.target}
                  </td>
                  <td>
                    <span
                      className="pill"
                      data-ok={row.ok}
                      data-expected={Boolean(row.expected) && !row.ok}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="mono">
                    {row.durationMs === undefined
                      ? "—"
                      : `${row.durationMs} ms`}
                  </td>
                  <td>
                    {row.reason}
                    {row.detail && <small>{row.detail}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
