import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EnrollmentWindowInfo,
  MachineSummary,
  PendingEnrollmentSummary,
  SessionSummary,
  SilentEnrollment,
} from "@oh-my-tui/protocol";
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { api, type AuditEntry, type EnrollmentsState, type WebAuthnCredentialSummary } from "./api";
import { TerminalView } from "./Terminal";
import { InlineEdit } from "./InlineEdit";

type View = "loading" | "setup" | "login" | "app";

function formatTime(value: number | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function modeLabel(mode: MachineSummary["mode"]): string {
  if (mode === "direct") return "直连";
  if (mode === "relay") return "隧道";
  return "未知";
}

function statusLabel(machine: MachineSummary): string {
  if (machine.status === "online") return "在线";
  if (machine.status === "disabled") return "已停用";
  return "离线";
}

function sessionStateLabel(session: SessionSummary): string {
  if (session.state === "cleanup_pending") return "待清理";
  if (session.state === "ended") return "已结束";
  if (session.attached) return "已连接";
  return "已分离";
}

function remainingText(session: SessionSummary, idleMs: number, now: number): string | null {
  if (session.persistent || (session.state === "ended" || session.state === "cleanup_pending") || session.attached) return null;
  const since = session.detachedAt ?? session.createdAt;
  const left = since + idleMs - now;
  if (left <= 0) return "即将关闭";
  const totalSeconds = Math.ceil(left / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")} 后自动关闭`;
}

function countdown(target: number, now: number): string {
  const left = Math.max(0, target - now);
  const s = Math.ceil(left / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function App(): JSX.Element {
  const [view, setView] = useState<View>("loading");
  const [section, setSection] = useState<"machines" | "audit" | "security">("machines");
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [machines, setMachines] = useState<MachineSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [idleMs, setIdleMs] = useState(5 * 60_000);
  const [enrollments, setEnrollments] = useState<EnrollmentsState | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [claimed, setClaimed] = useState<Record<string, string>>({});
  const [claimErrors, setClaimErrors] = useState<Record<string, string>>({});
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busyMachineId, setBusyMachineId] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const seenPending = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [machineResult, sessionResult, enrollResult] = await Promise.all([
        api.machines(),
        api.sessions(),
        api.enrollments(),
      ]);
      setMachines(machineResult.machines);
      setSessions(sessionResult.sessions);
      setIdleMs(sessionResult.sessionIdleTimeoutMs);
      setEnrollments(enrollResult);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const bootstrap = await api.bootstrap();
        if (!bootstrap.initialized) {
          setView("setup");
          return;
        }
        await api.machines();
        setView("app");
        await refresh();
      } catch {
        setView("login");
      }
    })();
  }, [refresh]);

  useEffect(() => {
    if (view !== "app") return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [view, refresh]);

  useEffect(() => {
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, []);

  useEffect(() => {
    if (view !== "app" || section !== "audit") return;
    const load = () =>
      api
        .audit()
        .then((result) => setAudit(result.entries))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [view, section]);

  const claim = useCallback(async (id: string) => {
    try {
      const result = await api.claimEnrollment(id);
      setClaimed((prev) => ({ ...prev, [id]: result.token }));
      setClaimErrors((prev) => ({ ...prev, [id]: "" }));
      await navigator.clipboard.writeText(result.token).catch(() => undefined);
    } catch (err) {
      setClaimErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : String(err) }));
    }
  }, []);

  // When a brand-new pending enrollment appears while the owner is on page A,
  // surface it immediately and claim the one-time token (auto-copied).
  const pending = enrollments?.pending ?? [];
  useEffect(() => {
    if (view !== "app") return;
    for (const item of pending) {
      if (seenPending.current.has(item.id)) continue;
      seenPending.current.add(item.id);
      if (selectedMachineId === null) {
        setAddOpen(true);
        void claim(item.id);
      }
    }
  }, [pending, view, selectedMachineId, claim]);

  if (view === "loading") return <div className="centered">加载中…</div>;
  if (view === "setup") return <SetupView onDone={() => void enterApp(setView, refresh, setError)} />;
  if (view === "login") return <LoginView onDone={() => void enterApp(setView, refresh, setError)} />;
  if (activeSession) {
    return (
      <TerminalView
        sessionId={activeSession.id}
        title={activeSession.title}
        onClose={() => setActiveSession(null)}
        onTitleChange={(next) =>
          setActiveSession((prev) => (prev && prev.id === activeSession.id ? { ...prev, title: next } : prev))
        }
      />
    );
  }

  const selected = machines.find((m) => m.id === selectedMachineId) ?? null;
  const activeSessionCount = sessions.filter((s) => s.state !== "ended").length;
  const showBadge = pending.length > 0 && !addOpen;

  function selectMachine(id: string | null): void {
    setSection("machines");
    setSelectedMachineId(id);
    setSidebarOpen(false);
  }

  async function openAddMachine(): Promise<void> {
    try {
      const result = await api.openEnrollWindow();
      setEnrollments(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setAddOpen(true);
  }

  async function newSession(machine: MachineSummary): Promise<void> {
    if (busyMachineId) return;
    setBusyMachineId(machine.id);
    setError(null);
    try {
      const n = sessions.filter((s) => s.machineId === machine.id).length + 1;
      const result = await api.createSession(machine.id, { title: `${machine.name} 会话 ${n}` });
      await refresh();
      setActiveSession(result.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMachineId(null);
    }
  }

  async function runAction(fn: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="app-shell">
      <div className={`sidebar-backdrop ${sidebarOpen ? "show" : ""}`} onClick={() => setSidebarOpen(false)} />
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-brand">
          <span className="brand-dot" />
          Oh-My-TUI
        </div>

        <button
          className={`sidebar-home ${section === "machines" && selectedMachineId === null ? "active" : ""}`}
          onClick={() => {
            selectMachine(null);
            setAddOpen(false);
          }}
        >
          <span className="m-name">全部机器</span>
          {showBadge && <span className="bang">!</span>}
          <span className="count">{machines.length}</span>
        </button>

        <button
          className={`sidebar-home ${section === "audit" ? "active" : ""}`}
          onClick={() => {
            setSection("audit");
            setSelectedMachineId(null);
            setSidebarOpen(false);
          }}
        >
          <span className="m-name">审计</span>
        </button>

        <button
          className={`sidebar-home ${section === "security" ? "active" : ""}`}
          onClick={() => {
            setSection("security");
            setSelectedMachineId(null);
            setSidebarOpen(false);
          }}
        >
          <span className="m-name">安全</span>
        </button>

        <div className="sidebar-label">机器</div>
        <ul className="sidebar-machines">
          {machines.map((machine) => (
            <li key={machine.id}>
              <button
                className={selectedMachineId === machine.id ? "active" : ""}
                onClick={() => selectMachine(machine.id)}
                title={`${machine.name} · ${statusLabel(machine)} · ${modeLabel(machine.mode)}`}
              >
                <span className={`dot ${machine.status}`} />
                <span className="m-name">{machine.name}</span>
                <span className="count">
                  {sessions.filter((s) => s.machineId === machine.id && s.state !== "ended").length}
                </span>
              </button>
            </li>
          ))}
          {machines.length === 0 && <li className="muted small sidebar-empty">暂无机器</li>}
        </ul>

        <div className="sidebar-footer">
          <button
            className="link"
            onClick={async () => {
              await api.logout().catch(() => undefined);
              // Reset navigation so the next login starts on the machine list.
              setSection("machines");
              setSelectedMachineId(null);
              setActiveSession(null);
              setView("login");
            }}
          >
            退出登录
          </button>
        </div>
      </aside>

      <main className="main">
        {section === "audit" ? (
          <AuditMain entries={audit} now={now} />
        ) : section === "security" ? (
          <SecurityMain setError={setError} />
        ) : selected ? (
          <>
            <header className="main-header">
              <button className="hamburger" onClick={() => setSidebarOpen(true)} aria-label="菜单">
                ☰
              </button>
              <button className="link back" onClick={() => selectMachine(null)}>
                ← 机器
              </button>
              <InlineEdit
                value={selected.name}
                displayTag="h1"
                displayClassName="editable title-h1"
                onSave={(next) => runAction(() => api.rename(selected.id, next))}
              />
              <div className="main-actions">
                <button disabled={!selected.terminalReady || busyMachineId === selected.id} onClick={() => void newSession(selected)}>
                  {busyMachineId === selected.id ? "创建中…" : "新建会话"}
                </button>
                {selected.status === "disabled" ? (
                  <button onClick={() => void runAction(() => api.enable(selected.id))}>启用</button>
                ) : (
                  <ConfirmButton
                    label="停用"
                    confirmLabel="确认停用"
                    onConfirm={() => void runAction(() => api.disable(selected.id))}
                  />
                )}
                <ConfirmButton
                  label="移除"
                  confirmLabel="确认移除"
                  onConfirm={() =>
                    void runAction(async () => {
                      await api.remove(selected.id);
                      setSelectedMachineId(null);
                    })
                  }
                />
              </div>
            </header>
            <div className="main-body">
              {error && <div className="banner error">{error}</div>}
              <div className="machine-detail">
                <span className={`badge ${selected.status}`}>{statusLabel(selected)}</span>
                <span className="pill">{modeLabel(selected.mode)}</span>
                {selected.terminalReady && <span className="badge ok">终端就绪</span>}
                <span className="muted small">用户 {selected.username ?? "—"}</span>
                <span className="muted small">
                  SSH {selected.sshHost ?? "via tunnel"}:{selected.sshPort ?? "—"}
                </span>
                <span className="muted small">最后在线 {formatTime(selected.lastSeenAt)}</span>
                {selected.terminalError && <span className="machine-error">终端不可用：{selected.terminalError}</span>}
              </div>
              <p className="muted">
                会话运行在目标机 tmux 中；浏览器刷新或断网后仍保留。非持久会话在无人连接{" "}
                {Math.round(idleMs / 60000)} 分钟后自动关闭。
              </p>
              <SessionList
                machine={selected}
                sessions={sessions.filter((s) => s.machineId === selected.id)}
                idleMs={idleMs}
                now={now}
                busy={busyMachineId === selected.id}
                onCreate={() => void newSession(selected)}
                onOpen={setActiveSession}
                runAction={runAction}
              />
            </div>
          </>
        ) : (
          <>
            <header className="main-header">
              <button className="hamburger" onClick={() => setSidebarOpen(true)} aria-label="菜单">
                ☰
              </button>
              <h1>机器</h1>
              <div className="main-actions">
                <button onClick={() => void openAddMachine()}>
                  添加机器
                  {pending.length > 0 && <span className="bang inline">{pending.length}</span>}
                </button>
              </div>
            </header>
            <div className="main-body">
              {error && <div className="banner error">{error}</div>}
              {machines.length === 0 ? (
                <div className="empty-state">
                  <p>还没有机器。</p>
                  <button onClick={() => void openAddMachine()}>添加机器</button>
                </div>
              ) : (
                <div className="machine-cards">
                  {machines.map((machine) => {
                    const count = sessions.filter((s) => s.machineId === machine.id && s.state !== "ended").length;
                    return (
                      <button key={machine.id} className="machine-card" onClick={() => selectMachine(machine.id)}>
                        <div className="machine-card-head">
                          <span className={`dot ${machine.status}`} />
                          <span className="machine-card-name">{machine.name}</span>
                          <span className={`badge ${machine.status}`}>{statusLabel(machine)}</span>
                        </div>
                        <div className="machine-card-meta">
                          <span>{modeLabel(machine.mode)}</span>
                          <span>{count} 个会话</span>
                          <span>{machine.terminalReady ? "终端就绪" : "终端未就绪"}</span>
                        </div>
                        <div className="machine-card-meta muted">
                          <span>{machine.os ? `${machine.os.platform} ${machine.os.arch}` : "—"}</span>
                          <span>最后在线 {formatTime(machine.lastSeenAt)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {activeSessionCount > 0 && <p className="muted">当前共有 {activeSessionCount} 个进行中的会话。</p>}
            </div>
          </>
        )}
      </main>

      {addOpen && enrollments && (
        <AddMachineModal
          windowInfo={enrollments.window}
          commandOrigin={enrollments.commandOrigin}
          agentPackageName={enrollments.agentPackageName}
          pending={pending}
          claimed={claimed}
          claimErrors={claimErrors}
          now={now}
          onOpenWindow={() => void openAddMachine()}
          onClaim={(id) => void claim(id)}
          onDismiss={(id) =>
            void api.dismissEnrollment(id).then(() => {
              setClaimed((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
              });
              return refresh();
            })
          }
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}

function SessionList({
  machine,
  sessions,
  idleMs,
  now,
  busy,
  onCreate,
  onOpen,
  runAction,
}: {
  machine: MachineSummary;
  sessions: SessionSummary[];
  idleMs: number;
  now: number;
  busy: boolean;
  onCreate: () => void;
  onOpen: (session: SessionSummary) => void;
  runAction: (fn: () => Promise<unknown>) => Promise<void>;
}): JSX.Element {
  if (sessions.length === 0) {
    return (
      <div className="session-group">
        <div className="session-group-title">
          <span className="muted small">暂无会话</span>
          <button className="mini" disabled={!machine.terminalReady || busy} onClick={onCreate}>
            {busy ? "创建中…" : "新建会话"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <ul className="session-list">
      {sessions.map((session) => {
        const remaining = remainingText(session, idleMs, now);
        const ended = session.state === "ended";
        const pendingCleanup = session.state === "cleanup_pending";
        return (
          <li key={session.id} className={`session-item ${ended ? "ended" : ""}`}>
            <div className="session-main">
              <div className="session-row">
                <span className={`badge ${ended ? "disabled" : session.attached ? "online" : "offline"}`}>
                  {sessionStateLabel(session)}
                </span>
                <InlineEdit
                  value={session.title}
                  displayClassName="session-title editable"
                  onSave={(next) => runAction(() => api.renameSession(session.id, next))}
                />
                {session.persistent && <span className="pill persistent">持久保持</span>}
              </div>
              <div className="session-meta">
                {session.currentCommand ? <span className="cmd">▶ {session.currentCommand}</span> : <span>当前命令: 无</span>}
                <span>tmux: {session.tmuxName}</span>
                <span>创建: {formatTime(session.createdAt)}</span>
                {remaining && <span className="countdown">{remaining}</span>}
                {pendingCleanup && <span className="countdown">已决定关闭，等待远端确认；连接恢复后自动重试。</span>}
              </div>
            </div>
            <div className="session-actions">
              {!ended && !pendingCleanup && <button onClick={() => onOpen(session)}>打开</button>}
              {!ended && !pendingCleanup && (
                <button onClick={() => void runAction(() => api.setSessionPersistent(session.id, !session.persistent))}>
                  {session.persistent ? "取消持久" : "设为持久"}
                </button>
              )}
              {!ended && (
                <ConfirmButton
                  label="关闭"
                  confirmLabel="确认关闭"
                  onConfirm={() => void runAction(() => api.closeSession(session.id))}
                />
              )}
              {ended && (
                <ConfirmButton
                  label="移除"
                  confirmLabel="确认移除"
                  onConfirm={() => void runAction(() => api.deleteSession(session.id))}
                />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function AddMachineModal({
  windowInfo,
  commandOrigin,
  agentPackageName,
  pending,
  claimed,
  claimErrors,
  now,
  onOpenWindow,
  onClaim,
  onDismiss,
  onClose,
}: {
  windowInfo: EnrollmentWindowInfo;
  commandOrigin: string;
  agentPackageName: string;
  pending: PendingEnrollmentSummary[];
  claimed: Record<string, string>;
  claimErrors: Record<string, string>;
  now: number;
  onOpenWindow: () => void;
  onClaim: (id: string) => void;
  onDismiss: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<"interactive" | "silent">("interactive");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>添加机器</h2>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="mode-tabs">
          <button className={mode === "interactive" ? "active" : ""} onClick={() => setMode("interactive")}>
            交互模式
          </button>
          <button className={mode === "silent" ? "active" : ""} onClick={() => setMode("silent")}>
            静默加入
          </button>
        </div>

        {mode === "interactive" ? (
          <InteractiveMode
            windowInfo={windowInfo}
            commandOrigin={commandOrigin}
            agentPackageName={agentPackageName}
            pending={pending}
            claimed={claimed}
            claimErrors={claimErrors}
            now={now}
            onOpenWindow={onOpenWindow}
            onClaim={onClaim}
            onDismiss={onDismiss}
          />
        ) : (
          <SilentMode now={now} />
        )}
      </div>
    </div>
  );
}

function InteractiveMode({
  windowInfo,
  commandOrigin,
  agentPackageName,
  pending,
  claimed,
  claimErrors,
  now,
  onOpenWindow,
  onClaim,
  onDismiss,
}: {
  windowInfo: EnrollmentWindowInfo;
  commandOrigin: string;
  agentPackageName: string;
  pending: PendingEnrollmentSummary[];
  claimed: Record<string, string>;
  claimErrors: Record<string, string>;
  now: number;
  onOpenWindow: () => void;
  onClaim: (id: string) => void;
  onDismiss: (id: string) => void;
}): JSX.Element {
  const commands = `npm install -g ${agentPackageName}\nterminal-agent register --server ${commandOrigin}`;
  const [copied, setCopied] = useState(false);

  return (
    <>
      <p className="muted">在目标机器上依次运行（命令不含 Token）：</p>
      <pre className="command-block">{commands}</pre>
      <button
        className="mini"
        onClick={() => {
          void navigator.clipboard
            .writeText(commands)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? "已复制命令" : "复制命令"}
      </button>

      <div className="window-status">
        {!windowInfo.enabled ? (
          <span className="muted small">配对限时已关闭，随时可配对。</span>
        ) : windowInfo.expiresAt ? (
          <span className="muted small">配对窗口剩余 {countdown(windowInfo.expiresAt, now)}</span>
        ) : (
          <span className="muted small">
            配对窗口未开启。
            <button className="mini" onClick={onOpenWindow}>
              开启
            </button>
          </span>
        )}
      </div>

      <h3>待加入的机器</h3>
      {pending.length === 0 ? (
        <p className="muted small">等待目标机运行上面的命令……</p>
      ) : (
        <ul className="pending-list">
          {pending.map((item) => (
            <li key={item.id} className="pending-item">
              <div className="pending-main">
                <div className="session-row">
                  <span className="session-title">{item.machineName}</span>
                  <span className="muted small">
                    {item.username ?? "—"}@{item.sshHosts[0] ?? "?"}
                  </span>
                </div>
                <div className="muted small">申请时间 {formatTime(item.createdAt)}</div>
                {claimErrors[item.id] && <div className="machine-error">{claimErrors[item.id]}</div>}
                {claimed[item.id] ? (
                  <TokenBlock token={claimed[item.id]!} />
                ) : (
                  <button className="mini" onClick={() => onClaim(item.id)}>
                    领取 Token
                  </button>
                )}
              </div>
              <div className="pending-actions">
                <button className="mini" onClick={() => onDismiss(item.id)}>
                  忽略
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SilentMode({ now }: { now: number }): JSX.Element {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [silent, setSilent] = useState<SilentEnrollment | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api.createSilentEnrollment(password);
      setSilent(result);
      setPassword("");
      void navigator.clipboard.writeText(result.command).then(
        () => setCopied(true),
        () => setCopied(false),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (silent) {
    const expired = silent.expiresAt <= now;
    return (
      <>
        <p className="muted">
          在目标机器上运行以下命令即可加入，无需再回管理端操作。命令包含本次 Token，
          <strong>请勿留在 shell 历史里</strong>。
        </p>
        <pre className="command-block">{silent.command}</pre>
        <div className="token-actions">
          <button
            className="mini"
            disabled={expired}
            onClick={() =>
              void navigator.clipboard
                .writeText(silent.command)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
          >
            {copied ? "已复制命令" : "复制命令"}
          </button>
          <span className={expired ? "machine-error" : "muted small"}>
            {expired ? "已过期，请重新生成" : `有效期剩余 ${countdown(silent.expiresAt, now)}（固定 3 分钟）`}
          </span>
        </div>
        <button className="mini" onClick={() => setSilent(null)}>
          重新生成
        </button>
      </>
    );
  }

  return (
    <>
      <p className="muted">
        静默加入会生成一条<strong>自带 Token 的命令</strong>，目标机运行后即刻完成，无需再回管理端。
        Token 有效期<strong>固定 3 分钟、不可设置</strong>，且会出现在命令中，因此需要重新输入管理员密码。
      </p>
      <label className="field-label">
        管理员密码
        <input
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void generate();
          }}
        />
      </label>
      {error && <div className="banner error">{error}</div>}
      <button className="mini" disabled={busy || !password} onClick={() => void generate()}>
        {busy ? "生成中…" : "生成静默命令"}
      </button>
    </>
  );
}


function TokenBlock({ token }: { token: string }): JSX.Element {
  const [status, setStatus] = useState<"copying" | "copied" | "failed">("copying");
  const copiedOnce = useRef(false);

  useEffect(() => {
    if (copiedOnce.current) return;
    copiedOnce.current = true;
    navigator.clipboard
      .writeText(token)
      .then(() => setStatus("copied"))
      .catch(() => setStatus("failed"));
  }, [token]);

  return (
    <div className="token-block">
      <code className="token-value">{token}</code>
      <div className="token-actions">
        <button
          className="mini"
          onClick={() =>
            void navigator.clipboard
              .writeText(token)
              .then(() => setStatus("copied"))
              .catch(() => setStatus("failed"))
          }
        >
          复制
        </button>
        <span className={status === "failed" ? "machine-error" : "muted small"}>
          {status === "copied" ? "已自动复制，请粘贴到目标机提示处" : status === "failed" ? "自动复制失败，请手动复制" : "正在复制…"}
        </span>
      </div>
    </div>
  );
}

/**
 * A single in-place confirmation button. Clicking once switches the label to
 * `confirmLabel`; the confirm is only accepted after a 200ms arming delay so a
 * quick double-tap (hand tremor) cannot fire a destructive action. Clicking
 * elsewhere or waiting 5s disarms it.
 */
function SecurityMain({ setError }: { setError: (value: string | null) => void }): JSX.Element {
  const [credentials, setCredentials] = useState<WebAuthnCredentialSummary[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const supported = useMemo(() => browserSupportsWebAuthn(), []);

  const load = useCallback(async () => {
    try {
      const result = await api.webauthnCredentials();
      setCredentials(result.credentials);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [setError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addPasskey(): Promise<void> {
    if (!supported || busy) return;
    const trimmed = name.trim() || "Passkey";
    setBusy(true);
    setError(null);
    try {
      const options = await api.webauthnRegisterOptions();
      const response = await startRegistration({ optionsJSON: options });
      await api.webauthnRegisterVerify(response, trimmed);
      setName("");
      setAdding(false);
      await load();
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    setError(null);
    try {
      await api.webauthnDeleteCredential(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <header className="main-header">
        <h1>安全</h1>
        <div className="main-actions">
          {supported && (
            <button disabled={adding || busy} onClick={() => setAdding(true)}>
              添加 Passkey
            </button>
          )}
        </div>
      </header>
      <div className="main-body">
        <p className="muted">
          使用 Passkey（通行密钥）可免密码登录；密码仍作为备用的登录与恢复方式。建议为每台设备登记独立的
          Passkey，便于随时吊销。
        </p>
        {!supported && <div className="banner error">当前浏览器不支持 Passkey。</div>}
        {adding && (
          <div className="passkey-add">
            <label className="field-label">
              Passkey 名称
              <input
                autoFocus
                value={name}
                placeholder="例如：MacBook"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addPasskey();
                  if (e.key === "Escape") {
                    setAdding(false);
                    setName("");
                  }
                }}
              />
            </label>
            <div className="token-actions">
              <button className="mini" disabled={busy} onClick={() => void addPasskey()}>
                {busy ? "注册中…" : "保存"}
              </button>
              <button
                className="mini"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                  setName("");
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}
        {credentials === null ? (
          <p className="muted small">加载中…</p>
        ) : credentials.length === 0 ? (
          <div className="empty-state">还没有 Passkey。点击「添加 Passkey」登记当前设备。</div>
        ) : (
          <table className="token-table audit-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>创建时间</th>
                <th>最后使用</th>
                <th>传输方式</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((credential) => (
                <tr key={credential.id}>
                  <td>{credential.name}</td>
                  <td>{formatTime(credential.createdAt)}</td>
                  <td>{formatTime(credential.lastUsedAt)}</td>
                  <td>{credential.transports.length > 0 ? credential.transports.join("、") : "—"}</td>
                  <td>
                    <ConfirmButton
                      label="吊销"
                      confirmLabel="确认吊销"
                      onConfirm={() => void revoke(credential.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function passkeyError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "NotAllowedError" || err.name === "AbortError") return "Passkey 操作已取消或超时";
    if (err.name === "InvalidStateError") return "该 Passkey 已在此设备注册";
    return err.message;
  }
  return String(err);
}

const AUDIT_KIND_LABEL: Record<string, string> = {
  interactive_requested: "机器发起加入",
  interactive_claimed: "管理端领取 Token",
  interactive_claim_failed: "领取 Token 失败",
  interactive_completed: "交互注册完成",
  interactive_failed: "交互注册失败",
  silent_issued: "生成静默 Token",
  silent_redeemed: "静默注册完成",
  silent_redeem_failed: "静默注册失败",
  enroll_denied_window: "配对窗口关闭被拒",
  auto_approved: "模拟模式自动通过",
  enroll_rate_limited: "触发限流被拒",
};

function AuditMain({ entries, now }: { entries: AuditEntry[]; now: number }): JSX.Element {
  void now;
  return (
    <>
      <header className="main-header">
        <h1>审计</h1>
      </header>
      <div className="main-body">
        <p className="muted">记录注册与静默 Token 的关键事件（最近 200 条）。</p>
        {entries.length === 0 ? (
          <div className="empty-state">暂无记录。</div>
        ) : (
          <table className="token-table audit-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>事件</th>
                <th>机器</th>
                <th>来源 IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatTime(entry.at)}</td>
                  <td>
                    {AUDIT_KIND_LABEL[entry.kind] ?? entry.kind}
                    {entry.detail ? <span className="muted small"> · {entry.detail}</span> : null}
                  </td>
                  <td>{entry.machineName ?? entry.machineId ?? "—"}</td>
                  <td>{entry.sourceIp ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [ready, setReady] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!armed) return;
    setReady(false);
    const armTimer = window.setTimeout(() => setReady(true), 200);
    const resetTimer = window.setTimeout(() => setArmed(false), 5000);
    const onDocumentDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setArmed(false);
    };
    document.addEventListener("mousedown", onDocumentDown);
    return () => {
      window.clearTimeout(armTimer);
      window.clearTimeout(resetTimer);
      document.removeEventListener("mousedown", onDocumentDown);
    };
  }, [armed]);

  if (!armed) {
    return (
      <button disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <button
      ref={ref}
      className="danger confirm-armed"
      disabled={!ready}
      onClick={() => {
        setArmed(false);
        onConfirm();
      }}
    >
      {confirmLabel}
    </button>
  );
}

async function enterApp(
  setView: (view: View) => void,
  refresh: () => Promise<void>,
  setError: (value: string | null) => void,
): Promise<void> {
  setView("app");
  await refresh();
  setError(null);
}

function SetupView({ onDone }: { onDone: () => void }): JSX.Element {
  const [setupToken, setSetupToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    if (password.length < 8) return setError("密码至少需要 8 个字符");
    if (password !== confirmPassword) return setError("两次输入的密码不一致");
    setBusy(true);
    try {
      await api.setup(setupToken.trim(), password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <form className="card auth" onSubmit={submit}>
        <h2>初始化服务端</h2>
        <p className="muted">
          在服务端本地运行 <code>node dist/admin.js setup-token</code> 生成一次性 Token，然后在此完成初始化。
        </p>
        <label>
          初始化 Token
          <input value={setupToken} onChange={(e) => setSetupToken(e.target.value)} autoComplete="off" />
        </label>
        <label>
          设置密码
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <label>
          确认密码
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        {error && <div className="banner error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? "提交中…" : "完成初始化"}
        </button>
      </form>
    </div>
  );
}

function LoginView({ onDone }: { onDone: () => void }): JSX.Element {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const supported = useMemo(() => browserSupportsWebAuthn(), []);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function passkeyLogin(): Promise<void> {
    setPasskeyBusy(true);
    setError(null);
    try {
      const options = await api.webauthnLoginOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await api.webauthnLoginVerify(response);
      onDone();
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setPasskeyBusy(false);
    }
  }

  return (
    <div className="centered">
      <div className="card auth">
        <h2>登录</h2>
        {supported ? (
          <button
            type="button"
            className="passkey-primary"
            disabled={passkeyBusy}
            onClick={() => void passkeyLogin()}
          >
            {passkeyBusy ? "验证中…" : "使用 Passkey 登录"}
          </button>
        ) : (
          <p className="muted small">当前浏览器不支持 Passkey，请使用密码登录。</p>
        )}
        <div className="auth-divider">
          <span>或</span>
        </div>
        <form onSubmit={submit}>
          <p className="muted small">使用密码登录</p>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && <div className="banner error">{error}</div>}
          <button type="submit" disabled={busy}>
            {busy ? "登录中…" : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
