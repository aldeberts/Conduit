import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { PtyWsClient } from "../lib/ptyWs";
import "@xterm/xterm/css/xterm.css";

type Props = {
  connectionId: string;
  apiToken?: string;
};

/** Wait for layout before measuring the terminal (avoids clipped first line). */
function afterLayout(fn: () => void): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(fn);
  });
}

export function TerminalPanel({ connectionId, apiToken }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const clientRef = useRef<PtyWsClient | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!connectionId || !hostRef.current) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, Consolas, monospace",
      theme: {
        background: "#181825",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fitAddon;

    const fitAndResize = (): void => {
      if (!hostRef.current || !termRef.current || !fitRef.current || !clientRef.current) {
        return;
      }
      fitRef.current.fit();
      termRef.current.scrollToTop();
      const { cols, rows } = termRef.current;
      clientRef.current.resize(cols, rows);
    };

    const client = new PtyWsClient(
      connectionId,
      {
        onSubscribed: () => {
          if (statusRef.current) {
            statusRef.current.textContent = "Connected";
          }
          afterLayout(fitAndResize);
        },
        onOutput: (data) => {
          term.write(data);
        },
        onError: (message) => {
          if (statusRef.current) {
            statusRef.current.textContent = message === "websocket_error" ? "Reconnecting…" : message;
          }
        },
      },
      apiToken,
    );
    clientRef.current = client;
    client.connect();

    const onData = term.onData((data) => {
      client.sendInput(new TextEncoder().encode(data));
    });

    const onResize = (): void => {
      afterLayout(fitAndResize);
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(hostRef.current);
    afterLayout(fitAndResize);

    return () => {
      onData.dispose();
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      client.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      clientRef.current = null;
    };
  }, [connectionId, apiToken]);

  return (
    <section className="terminal-panel" aria-label="Shared terminal">
      <div className="terminal-panel-header">
        <span className="terminal-panel-title">Terminal</span>
        <span ref={statusRef} className="terminal-panel-status">
          Connecting…
        </span>
      </div>
      <div ref={hostRef} className="terminal-host" />
    </section>
  );
}
