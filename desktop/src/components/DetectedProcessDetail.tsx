import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClaudeProcess, ClaudeQuestion } from "@clawtab/shared";
import { shortenPath } from "@clawtab/shared";
import { LogViewer } from "./LogViewer";

export function DetectedProcessDetail({
  process,
  questions,
  onBack,
  onDismissQuestion,
  autoYesActive,
  onToggleAutoYes,
}: {
  process: ClaudeProcess;
  questions: ClaudeQuestion[];
  onBack: () => void;
  onDismissQuestion: (questionId: string) => void;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
}) {
  const [logs, setLogs] = useState(process.log_lines);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [killMenuOpen, setKillMenuOpen] = useState(false);
  const killMenuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const processRef = useRef(process);
  processRef.current = process;

  const displayName = shortenPath(process.cwd);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const result = await invoke<string>("get_detected_process_logs", {
          tmuxSession: processRef.current.tmux_session,
          paneId: processRef.current.pane_id,
        });
        if (active) setLogs(result);
      } catch {
        // Process may have stopped
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { active = false; clearInterval(interval); };
  }, [process.pane_id]);

  const paneQuestion = questions.find((q) => q.pane_id === process.pane_id);
  const options = paneQuestion?.options ?? [];

  const handleSend = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await invoke("send_detected_process_input", { paneId: process.pane_id, text: t });
      setInputText("");
      inputRef.current?.focus();
      if (paneQuestion) onDismissQuestion(paneQuestion.question_id);
    } catch (e) {
      console.error("Failed to send input:", e);
    } finally {
      setSending(false);
    }
  }, [process.pane_id, sending, paneQuestion, onDismissQuestion]);

  const handleSigint = useCallback(async () => {
    setKillMenuOpen(false);
    try {
      await invoke("sigint_detected_process", { paneId: process.pane_id });
    } catch (e) {
      console.error("Failed to send C-c:", e);
    }
  }, [process.pane_id]);

  const handleKillShell = useCallback(async () => {
    setKillMenuOpen(false);
    try {
      await invoke("stop_detected_process", { paneId: process.pane_id });
      onBack();
    } catch (e) {
      console.error("Failed to kill process:", e);
    }
  }, [process.pane_id, onBack]);

  useEffect(() => {
    if (!killMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (killMenuRef.current && !killMenuRef.current.contains(e.target as Node)) {
        setKillMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [killMenuOpen]);

  const handleOpen = useCallback(() => {
    invoke("focus_detected_process", {
      tmuxSession: process.tmux_session,
      windowName: process.window_name,
    }).catch(() => {});
  }, [process.tmux_session, process.window_name]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <button className="btn btn-sm" onClick={onBack}>
          Back
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {displayName}
            </span>
            <code style={{ fontSize: 11, color: "var(--text-secondary)" }}>v{process.version}</code>
            <span className="status-badge status-running" style={{ fontSize: 11 }}>running</span>
          </div>
        </div>
        <div className="btn-group">
          <button className="btn btn-sm" onClick={handleOpen} title="Open in terminal">
            Open in Terminal
          </button>
          <div ref={killMenuRef} style={{ position: "relative" }}>
            <button
              className="btn btn-sm"
              onClick={() => setKillMenuOpen((v) => !v)}
              style={{ borderColor: "var(--danger-color)", color: "var(--danger-color)" }}
            >
              Kill
            </button>
            {killMenuOpen && (
              <div style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 4,
                backgroundColor: "var(--surface)",
                border: "1px solid var(--border-color)",
                borderRadius: 6,
                overflow: "hidden",
                zIndex: 100,
                minWidth: 140,
                boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
              }}>
                <button
                  className="btn btn-sm"
                  onClick={handleSigint}
                  style={{
                    width: "100%",
                    border: "none",
                    borderRadius: 0,
                    justifyContent: "flex-start",
                    color: "var(--warning-color)",
                  }}
                >
                  C-c
                </button>
                <button
                  className="btn btn-sm"
                  onClick={handleKillShell}
                  style={{
                    width: "100%",
                    border: "none",
                    borderRadius: 0,
                    justifyContent: "flex-start",
                    color: "var(--danger-color)",
                  }}
                >
                  shell
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <LogViewer
        content={logs}
        className="log-viewer"
        style={{ flex: 1, minHeight: 0, height: 0, maxHeight: "none", overflowY: "auto" }}
      />

      {options.length > 0 && (
        <div style={{
          display: "flex",
          gap: 6,
          padding: "8px 0",
          flexWrap: "wrap",
          alignItems: "center",
        }}>
          {options.map((opt) => (
            <button
              key={opt.number}
              className="btn btn-sm"
              style={{
                borderColor: "var(--accent)",
                color: "var(--accent)",
              }}
              disabled={sending}
              onClick={() => handleSend(opt.number)}
            >
              {opt.number}. {opt.label.length > 30 ? opt.label.slice(0, 30) + "..." : opt.label}
            </button>
          ))}
          {onToggleAutoYes && (
            <>
              <div style={{ width: 1, height: 18, backgroundColor: "var(--border-color)" }} />
              <button
                className="btn btn-sm"
                style={{
                  borderColor: "var(--warning-color)",
                  color: "var(--warning-color)",
                  backgroundColor: autoYesActive ? "var(--warning-bg)" : undefined,
                  fontWeight: 600,
                }}
                onClick={onToggleAutoYes}
              >
                {autoYesActive ? "! Auto ON" : "! Yes all"}
              </button>
            </>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, paddingTop: 4 }}>
        <input
          ref={inputRef}
          className="input"
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSend(inputText); }}
          placeholder="Send input..."
          style={{ flex: 1 }}
        />
        <button
          className="btn btn-primary btn-sm"
          disabled={!inputText.trim() || sending}
          onClick={() => handleSend(inputText)}
        >
          Send
        </button>
      </div>
    </div>
  );
}
