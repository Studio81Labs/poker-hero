import { useEffect, useState } from "react";

import {
  createMcpPrincipal,
  getMcpAccessConfig,
  listMcpPrincipals,
  revokeMcpPrincipal,
  rotateMcpPrincipal,
} from "./api";
import type {
  McpAccessConfig,
  McpIssuedPrincipal,
  McpPrincipal,
  McpScope,
} from "./types";

export function McpAccessPanel() {
  const [config, setConfig] = useState<McpAccessConfig | null>(null);
  const [principals, setPrincipals] = useState<McpPrincipal[]>([]);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [expiry, setExpiry] = useState("");
  const [issued, setIssued] = useState<McpIssuedPrincipal | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([getMcpAccessConfig(), listMcpPrincipals()])
      .then(([nextConfig, nextPrincipals]) => {
        if (!active) return;
        setConfig(nextConfig);
        setPrincipals(nextPrincipals);
      })
      .catch((reason: unknown) => {
        if (active) setError(messageFrom(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function createPrincipal() {
    const normalizedName = name.trim();
    if (normalizedName.length < 3) {
      setError("Use a name of at least 3 characters.");
      return;
    }
    setBusyId("create");
    setError(null);
    try {
      const scopes: McpScope[] =
        access === "write" ? ["read", "write"] : ["read"];
      const result = await createMcpPrincipal({
        name: normalizedName,
        scopes,
        expires_at: expiry ? new Date(expiry).toISOString() : null,
      });
      setIssued(result);
      setPrincipals((current) => [
        result.principal,
        ...current.filter((candidate) => candidate.id !== result.principal.id),
      ]);
      setName("");
      setExpiry("");
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function rotate(principal: McpPrincipal) {
    if (
      !window.confirm(
        `Rotate ${principal.name}? The current token will stop working immediately.`,
      )
    ) {
      return;
    }
    setBusyId(principal.id);
    setError(null);
    try {
      const result = await rotateMcpPrincipal(principal.id);
      setIssued(result);
      replacePrincipal(result.principal);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(principal: McpPrincipal) {
    if (!window.confirm(`Revoke ${principal.name}? This cannot be undone.`)) {
      return;
    }
    setBusyId(principal.id);
    setError(null);
    try {
      replacePrincipal(await revokeMcpPrincipal(principal.id));
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusyId(null);
    }
  }

  function replacePrincipal(principal: McpPrincipal) {
    setPrincipals((current) =>
      current.map((candidate) =>
        candidate.id === principal.id ? principal : candidate,
      ),
    );
  }

  if (loading) {
    return <p>Reading agent access configuration...</p>;
  }
  if (!config || config.environment === "local") {
    return (
      <p>
        Hosted agent access is available in staging and production deployments.
      </p>
    );
  }

  return (
    <div className="mcp-access-panel">
      <p>
        <strong>{config.environment}</strong>
        {" · "}
        {config.enabled ? config.endpoint : "Endpoint disabled"}
        {" · "}
        {config.writes_enabled ? "staging writes enabled" : "read-only server"}
      </p>

      {issued ? (
        <div className="mcp-issued-token" role="status">
          <strong>Copy this token now</strong>
          <p>It is shown once and cannot be retrieved later.</p>
          <code>{issued.token}</code>
          <div className="mcp-inline-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void navigator.clipboard.writeText(issued.token)}
            >
              Copy token
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setIssued(null)}
            >
              I stored it
            </button>
          </div>
        </div>
      ) : null}

      <div className="mcp-create-grid">
        <label>
          Credential name
          <input
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder="Developer or agent purpose"
          />
        </label>
        <label>
          Access
          <select
            value={access}
            onChange={(event) =>
              setAccess(event.target.value as "read" | "write")
            }
          >
            <option value="read">Read only</option>
            <option value="write" disabled={!config.writes_enabled}>
              Read and write
            </option>
          </select>
        </label>
        <label>
          Expires (optional)
          <input
            type="datetime-local"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={busyId !== null}
          onClick={() => void createPrincipal()}
        >
          {busyId === "create" ? "Creating..." : "Create credential"}
        </button>
      </div>

      {error ? (
        <p className="mcp-access-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mcp-principal-list">
        {principals.length === 0 ? (
          <p>No credentials have been created for this environment.</p>
        ) : (
          principals.map((principal) => (
            <div className="mcp-principal-row" key={principal.id}>
              <div>
                <strong>{principal.name}</strong>
                <small>
                  {principal.status} · {principal.scopes.join(" + ")} · phmcp_
                  {principal.token_prefix}…
                  {principal.last_used_at
                    ? ` · used ${formatDate(principal.last_used_at)}`
                    : " · unused"}
                </small>
              </div>
              {principal.status === "active" ? (
                <div className="mcp-inline-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busyId !== null}
                    onClick={() => void rotate(principal)}
                  >
                    Rotate
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busyId !== null}
                    onClick={() => void revoke(principal)}
                  >
                    Revoke
                  </button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function messageFrom(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : "Could not update agent access.";
}
