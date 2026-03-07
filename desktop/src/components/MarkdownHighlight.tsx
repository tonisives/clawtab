import { forwardRef, useCallback, useRef, useMemo, useEffect } from "react";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// Lightweight markdown syntax highlighter for read-only display.

interface Props {
  content: string;
  className?: string;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLPreElement>;
}

type Segment = { text: string; cls?: string };

function highlightLine(line: string): Segment[] {
  if (/^\s*<!--/.test(line)) {
    return [{ text: line, cls: "md-comment" }];
  }

  const headingMatch = line.match(/^(#{1,6}\s)/);
  if (headingMatch) {
    return [
      { text: headingMatch[1], cls: "md-heading-marker" },
      { text: line.slice(headingMatch[1].length), cls: "md-heading" },
    ];
  }

  const listMatch = line.match(/^(\s*(?:[-*]|\d+\.)\s)/);
  const segments: Segment[] = [];
  let rest = line;

  if (listMatch) {
    segments.push({ text: listMatch[1], cls: "md-list-marker" });
    rest = line.slice(listMatch[1].length);
  }

  highlightInline(rest, segments);
  return segments;
}

function highlightInline(text: string, out: Segment[]) {
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out.push({ text: text.slice(lastIndex, match.index) });
    }
    if (match[1]) {
      out.push({ text: match[1], cls: "md-code" });
    } else if (match[2]) {
      out.push({ text: match[2], cls: "md-bold" });
    } else if (match[3]) {
      out.push({ text: match[3], cls: "md-italic" });
    } else if (match[4]) {
      out.push({ text: match[4], cls: "md-link" });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    out.push({ text: text.slice(lastIndex) });
  }
}

export const MarkdownHighlight = forwardRef<HTMLPreElement, Props>(function MarkdownHighlight({ content, className, style }, ref) {
  const rendered = useMemo(() => {
    const lines = content.split("\n");
    const elements: (Segment | { text: string; cls: string })[][] = [];
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (!inCodeBlock && /^```/.test(line)) {
        inCodeBlock = true;
        elements.push([{ text: line, cls: "md-code-fence" }]);
        continue;
      }

      if (inCodeBlock) {
        if (/^```\s*$/.test(line)) {
          inCodeBlock = false;
          elements.push([{ text: line, cls: "md-code-fence" }]);
        } else {
          elements.push([{ text: line, cls: "md-code-block" }]);
        }
        continue;
      }

      elements.push(highlightLine(line));
    }

    return elements;
  }, [content]);

  return (
    <pre ref={ref} className={className} style={style}>
      {rendered.map((segments, i) => (
        <span key={i}>
          {i > 0 && "\n"}
          {segments.map((seg, j) =>
            seg.cls ? (
              <span key={j} className={seg.cls}>{seg.text}</span>
            ) : (
              <span key={j}>{seg.text}</span>
            ),
          )}
        </span>
      ))}
    </pre>
  );
});

// Theme matching the app's dark UI
const appHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--text-primary)" },
  { tag: tags.processingInstruction, color: "var(--accent-color)" }, // heading markers
  { tag: tags.monospace, color: "var(--success-color)" }, // inline code
  { tag: tags.emphasis, color: "var(--text-primary)", fontStyle: "italic" },
  { tag: tags.strong, color: "var(--text-primary)" },
  { tag: tags.link, color: "var(--accent-color)" },
  { tag: tags.url, color: "var(--accent-color)" },
  { tag: tags.list, color: "var(--accent-color)" },
  { tag: tags.comment, color: "var(--text-secondary)", opacity: 0.6 },
  { tag: tags.string, color: "var(--success-color)" },
]);

const appTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--text-primary)",
    fontSize: "12px",
    fontFamily: "monospace",
    height: "100%",
  },
  ".cm-content": {
    padding: "10px 12px",
    fontFamily: "monospace",
    fontSize: "12px",
    lineHeight: "1.5",
    caretColor: "var(--text-primary)",
    minHeight: "100%",
  },
  "&.cm-focused .cm-content": {
    outline: "none",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "monospace",
    lineHeight: "1.5",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-selectionBackground": {
    backgroundColor: "var(--accent-hover) !important",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--accent-hover) !important",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--text-primary)",
  },
  ".cm-placeholder": {
    color: "var(--text-secondary)",
    fontStyle: "normal",
  },
  ".cm-line": {
    padding: "0",
  },
});

const readOnlyTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--text-primary)",
    fontSize: "12px",
    fontFamily: "monospace",
    height: "100%",
  },
  ".cm-content": {
    padding: "10px 12px",
    fontFamily: "monospace",
    fontSize: "12px",
    lineHeight: "1.5",
    minHeight: "100%",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "monospace",
    lineHeight: "1.5",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-cursor": {
    display: "none !important",
  },
  ".cm-line": {
    padding: "0",
  },
});

// CodeMirror-based highlighted textarea with proper cursor alignment.
export function HighlightedTextarea({
  value,
  onChange,
  spellCheck: _spellCheck,
  placeholder,
  textareaRef,
  wrapClassName,
  readOnly,
}: {
  value: string;
  onChange?: (e: { target: { value: string } }) => void;
  spellCheck?: boolean;
  placeholder?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  wrapClassName?: string;
  readOnly?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const isExternalUpdate = useRef(false);

  // Expose a minimal ref for drag-drop (selectionStart)
  useEffect(() => {
    if (!textareaRef) return;
    const proxy = new Proxy({} as HTMLTextAreaElement, {
      get(_target, prop) {
        const view = viewRef.current;
        if (!view) return undefined;
        if (prop === "selectionStart") return view.state.selection.main.head;
        if (prop === "selectionEnd") return view.state.selection.main.head;
        if (prop === "getBoundingClientRect") return () => view.dom.getBoundingClientRect();
        if (prop === "value") return view.state.doc.toString();
        return undefined;
      },
    });
    (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = proxy;
    return () => {
      (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = null;
    };
  }, [textareaRef]);

  // Create editor
  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = [
      markdown({ codeLanguages: languages }),
      syntaxHighlighting(appHighlightStyle),
      readOnly ? readOnlyTheme : appTheme,
      EditorView.lineWrapping,
      keymap.of([]),
    ];

    if (readOnly) {
      extensions.push(EditorState.readOnly.of(true));
      extensions.push(EditorView.editable.of(false));
    }

    if (placeholder) {
      extensions.push(cmPlaceholder(placeholder));
    }

    if (!readOnly) {
      extensions.push(
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !isExternalUpdate.current) {
            onChangeRef.current?.({ target: { value: update.state.doc.toString() } });
          }
        }),
      );
    }

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [readOnly]); // Only recreate on readOnly change

  // Sync external value changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      isExternalUpdate.current = true;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
      isExternalUpdate.current = false;
    }
  }, [value]);

  const wrapRef = useRef<HTMLDivElement>(null);

  const handleGripDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const startY = e.clientY;
    const startH = wrap.offsetHeight;
    const onMove = (ev: MouseEvent) => {
      const h = Math.max(120, startH + (ev.clientY - startY));
      wrap.style.height = h + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  return (
    <div ref={wrapRef} className={`highlighted-textarea-wrap ${readOnly ? "readonly" : ""} ${wrapClassName || ""}`}>
      <div ref={containerRef} className="cm-editor-container" />
      <div className="textarea-resize-grip" onMouseDown={handleGripDown}>
        <svg width="10" height="6" viewBox="0 0 10 6">
          <path d="M0 1h10M0 4h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}
