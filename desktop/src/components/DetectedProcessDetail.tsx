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

  const handleOpen = useCallback(() => {
    invoke("focus_detected_process", {
      tmuxSession: process.tmux_session,
      windowName: process.window_name,
    }).catch(() => {});
  }, [process.tmux_session, process.window_name]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
        </div>
      </div>

      <LogViewer
        content={logs}
        className="log-viewer"
        style={{ flex: 1, minHeight: 200 }}
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
