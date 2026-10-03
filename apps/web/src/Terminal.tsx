import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api";
import { InlineEdit } from "./InlineEdit";

interface Props {
  sessionId: string;
  title: string;
  onClose: () => void;
  onTitleChange?: (title: string) => void;
}

interface StatusMessage {
  type: "status";
  state: "connecting" | "ready" | "closed";
  message?: string;
}

function statusText(state: StatusMessage["state"], message?: string): string {
  if (state === "connecting") return message ?? "正在连接…";
  if (state === "ready") return "已连接";
  return message ? message : "已断开";
}

export function TerminalView({ sessionId, title, onClose, onTitleChange }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState("正在连接…");
  const [text, setText] = useState("");
  const [occupied, setOccupied] = useState(false);
  const [attempt, setAttempt] = useState({ takeover: false, nonce: 0 });

  const reconnect = useCallback((takeover: boolean) => {
    setAttempt((prev) => ({ takeover, nonce: prev.nonce + 1 }));
  }, []);

  const rename = useCallback(
    async (next: string) => {
      try {
        await api.renameSession(sessionId, next);
        onTitleChange?.(next);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId, onTitleChange],
  );

  useEffect(() => {
    setOccupied(false);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Cascadia Mono", "Noto Sans Mono CJK SC", monospace',
      scrollback: 5000,
      theme: { background: "#0b0f14", foreground: "#d7e2ee", cursor: "#3ddc97" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (containerRef.current) {
      term.open(containerRef.current);
      try {
        fit.fit();
      } catch {
        /* not measurable yet */
      }
    }

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const takeover = attempt.takeover ? "&takeover=1" : "";
    const url = `${proto}://${window.location.host}/ws/terminal?sessionId=${encodeURIComponent(sessionId)}&cols=${term.cols}&rows=${term.rows}${takeover}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => setStatus("已连接");
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data) as StatusMessage;
          if (message.type === "status") {
            setStatus(statusText(message.state, message.message));
            if (message.state === "closed" && message.message && message.message.includes("被其他窗口控制")) {
              setOccupied(true);
            }
          }
        } catch {
          /* ignore */
        }
        return;
      }
      term.write(new Uint8Array(event.data as ArrayBuffer));
    };
    ws.onclose = (event) => setStatus(event.reason ? event.reason : "已断开");
    ws.onerror = () => setStatus("连接错误");

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
    });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });

    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", refit);
    window.addEventListener("orientationchange", refit);
    const observer = new ResizeObserver(refit);
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      window.removeEventListener("resize", refit);
      window.removeEventListener("orientationchange", refit);
      observer.disconnect();
      ws.close(1000, "leaving terminal view");
      term.dispose();
    };
  }, [sessionId, attempt]);

  function sendRaw(data: string): void {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
  }

  function sendPaste(): void {
    if (!text) return;
    sendRaw(`\u001b[200~${text}\u001b[201~`);
    setText("");
  }

  return (
    <div className="terminal-view">
      <div className="terminal-header">
        <button className="link" onClick={onClose}>
          ← 返回
        </button>
        <InlineEdit
          value={title}
          displayClassName="terminal-title editable"
          onSave={(next) => rename(next)}
        />
        <span className="terminal-status">{status}</span>
      </div>
      {occupied && (
        <div className="banner error">
          会话正被其他窗口控制。
          <button onClick={() => reconnect(true)}>接管</button>
        </div>
      )}
      <div className="terminal-host" ref={containerRef} />
      <div className="key-row">
        <button onClick={() => sendRaw("\u0003")}>Ctrl-C</button>
        <button onClick={() => sendRaw("\t")}>Tab</button>
        <button onClick={() => sendRaw("\u001b")}>Esc</button>
        <button onClick={() => sendRaw("\u001b[A")}>↑</button>
        <button onClick={() => sendRaw("\u001b[B")}>↓</button>
        <button onClick={() => sendRaw("\u001b[C")}>→</button>
        <button onClick={() => sendRaw("\u001b[D")}>←</button>
        <button onClick={() => sendRaw("\r")}>Enter</button>
      </div>
      <div className="compose">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="在此输入或使用手机键盘听写；先“发送文本”，需要执行再点“发送 Enter”。"
          rows={3}
        />
        <div className="compose-actions">
          <button onClick={sendPaste} disabled={!text}>
            发送文本
          </button>
          <button onClick={() => sendRaw("\r")}>发送 Enter</button>
        </div>
      </div>
    </div>
  );
}
