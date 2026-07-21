import { Terminal } from "@xterm/xterm";
import {
  Copy,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import type { DesktopUserTerminal } from "../../src/contracts";

export function TerminalWorkspace(props: {
  sessionId: string;
  threadId: string;
  onAttachOutput: (
    text: string,
    terminal: DesktopUserTerminal,
  ) => Promise<void>;
  onError: (message: string | undefined) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | undefined>(undefined);
  const cursorRef = useRef(0);
  const [terminals, setTerminals] = useState<DesktopUserTerminal[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [searchDraft, setSearchDraft] = useState("");
  const [selection, setSelection] = useState("");
  const active = terminals.find((terminal) => terminal.terminalId === activeId);

  useEffect(() => {
    void window.kestrelDesktop
      .listUserTerminals({
        sessionId: props.sessionId,
        threadId: props.threadId,
      })
      .then((records) => {
        setTerminals(records);
        setActiveId((current) => current ?? records.at(-1)?.terminalId);
      })
      .catch((cause) => props.onError(errorMessage(cause)));
  }, [props.sessionId, props.threadId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeId) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      scrollback: 10_000,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      theme: { background: "#101113" },
    });
    terminal.open(host);
    terminal.focus();
    xtermRef.current = terminal;
    cursorRef.current = 0;
    const dataSubscription = terminal.onData((data) => {
      void window.kestrelDesktop
        .writeUserTerminal({
          sessionId: props.sessionId,
          terminalId: activeId,
          data,
        })
        .catch((cause) => props.onError(errorMessage(cause)));
    });
    const selectionSubscription = terminal.onSelectionChange(() =>
      setSelection(terminal.getSelection()),
    );
    const resize = () => {
      const cols = Math.max(2, Math.floor(host.clientWidth / 8));
      const rows = Math.max(2, Math.floor(host.clientHeight / 18));
      terminal.resize(cols, rows);
      void window.kestrelDesktop
        .resizeUserTerminal({
          sessionId: props.sessionId,
          terminalId: activeId,
          cols,
          rows,
        })
        .catch(() => undefined);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const poll = window.setInterval(() => {
      void window.kestrelDesktop
        .readUserTerminal({
          sessionId: props.sessionId,
          terminalId: activeId,
          cursor: cursorRef.current,
        })
        .then((result) => {
          if (result.truncated)
            terminal.writeln(
              "\r\n[Earlier terminal output was discarded.]\r\n",
            );
          if (result.output) terminal.write(result.output);
          cursorRef.current = result.nextCursor;
          setTerminals((current) =>
            current.map((item) =>
              item.terminalId === activeId ? result.terminal : item,
            ),
          );
        })
        .catch((cause) => props.onError(errorMessage(cause)));
    }, 100);
    return () => {
      window.clearInterval(poll);
      observer.disconnect();
      dataSubscription.dispose();
      selectionSubscription.dispose();
      terminal.dispose();
      xtermRef.current = undefined;
      setSelection("");
    };
  }, [activeId, props.sessionId]);

  const start = async () => {
    try {
      const terminal = await window.kestrelDesktop.startUserTerminal({
        sessionId: props.sessionId,
        threadId: props.threadId,
      });
      setTerminals((current) => [...current, terminal]);
      setActiveId(terminal.terminalId);
    } catch (cause) {
      props.onError(errorMessage(cause));
    }
  };

  const stop = async () => {
    if (!active) return;
    try {
      const terminal = await window.kestrelDesktop.stopUserTerminal({
        sessionId: props.sessionId,
        terminalId: active.terminalId,
      });
      setTerminals((current) =>
        current.map((item) =>
          item.terminalId === terminal.terminalId ? terminal : item,
        ),
      );
    } catch (cause) {
      props.onError(errorMessage(cause));
    }
  };

  const find = () => {
    const terminal = xtermRef.current;
    const query = searchDraft;
    if (!terminal || !query) return;
    for (let row = 0; row < terminal.buffer.active.length; row += 1) {
      const line =
        terminal.buffer.active.getLine(row)?.translateToString(true) ?? "";
      const column = line
        .toLocaleLowerCase()
        .indexOf(query.toLocaleLowerCase());
      if (column >= 0) {
        terminal.select(column, row, query.length);
        terminal.scrollToLine(row);
        return;
      }
    }
  };

  return (
    <section className="terminal-workspace">
      <header className="terminal-toolbar">
        <div className="terminal-tabs">
          {terminals.map((terminal, index) => (
            <button
              className={terminal.terminalId === activeId ? "active" : ""}
              key={terminal.terminalId}
              onClick={() => setActiveId(terminal.terminalId)}
              type="button"
            >
              Terminal {index + 1} · {terminal.status}
            </button>
          ))}
        </div>
        <button type="button" title="New terminal" onClick={() => void start()}>
          <Plus size={15} /> New
        </button>
        <button
          type="button"
          title="Stop terminal"
          disabled={active?.status !== "running"}
          onClick={() => void stop()}
        >
          <Square size={14} /> Stop
        </button>
        <button
          type="button"
          title="Restart in a new terminal"
          disabled={!active}
          onClick={() => void start()}
        >
          <RotateCcw size={14} /> Restart
        </button>
        <button
          aria-label="Copy selection"
          type="button"
          title="Copy selection"
          onClick={() =>
            void navigator.clipboard.writeText(
              xtermRef.current?.getSelection() ?? "",
            )
          }
        >
          <Copy size={14} />
        </button>
        <button
          type="button"
          title="Attach selected output to Kestrel"
          disabled={!active || selection.length === 0}
          onClick={() =>
            active &&
            void props.onAttachOutput(selection.slice(0, 16 * 1024), active)
          }
        >
          <Paperclip size={14} /> Attach selection
        </button>
        <button
          aria-label="Clear visible terminal"
          type="button"
          title="Clear visible terminal"
          onClick={() => xtermRef.current?.clear()}
        >
          <Trash2 size={14} />
        </button>
        <label className="terminal-search">
          <Search aria-hidden="true" size={14} />
          <input
            aria-label="Find terminal output"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") find();
            }}
            placeholder="Find output"
          />
        </label>
      </header>
      {active ? (
        <div className="terminal-identity">
          <span>{active.cwd}</span>
          <span>
            {active.status}
            {active.exitCode !== undefined ? ` · exit ${active.exitCode}` : ""}
            {active.signal !== undefined ? ` · signal ${active.signal}` : ""}
            {active.durationMs !== undefined
              ? ` · ${Math.round(active.durationMs / 1000)}s`
              : ""}
          </span>
        </div>
      ) : null}
      {activeId ? (
        <div className="terminal-canvas" ref={hostRef} />
      ) : (
        <div className="terminal-empty">
          <p>No terminal for this conversation.</p>
          <button type="button" onClick={() => void start()}>
            Start terminal
          </button>
        </div>
      )}
    </section>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
