import { forwardRef, useCallback, useRef, useMemo } from "react";

// Lightweight markdown syntax highlighter - renders colored spans inside a <pre>.
// Supports: headings, code blocks, inline code, bold, italic, links, comments, list markers.

interface Props {
  content: string;
  className?: string;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLPreElement>;
}

type Segment = { text: string; cls?: string };

function highlightLine(line: string): Segment[] {
  // HTML/XML comments
  if (/^\s*<!--/.test(line)) {
    return [{ text: line, cls: "md-comment" }];
  }

  // Headings
  const headingMatch = line.match(/^(#{1,6}\s)/);
  if (headingMatch) {
    return [
      { text: headingMatch[1], cls: "md-heading-marker" },
      { text: line.slice(headingMatch[1].length), cls: "md-heading" },
    ];
  }

  // List markers: -, *, numbered
  const listMatch = line.match(/^(\s*(?:[-*]|\d+\.)\s)/);

  const segments: Segment[] = [];
  let rest = line;

  if (listMatch) {
    segments.push({ text: listMatch[1], cls: "md-list-marker" });
    rest = line.slice(listMatch[1].length);
  }

  // Inline patterns
  highlightInline(rest, segments);

  return segments;
}

function highlightInline(text: string, out: Segment[]) {
  // Match: `code`, **bold**, *italic*, [link](url)
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

// Overlay-based highlighted textarea: renders highlighting behind a transparent textarea.
export function HighlightedTextarea({
  value,
  onChange,
  spellCheck,
  placeholder,
  textareaRef,
  wrapClassName,
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  spellCheck?: boolean;
  placeholder?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  wrapClassName?: string;
}) {
  const backdropRef = useRef<HTMLPreElement>(null);

  const handleScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    if (backdropRef.current) {
      backdropRef.current.scrollTop = e.currentTarget.scrollTop;
      backdropRef.current.scrollLeft = e.currentTarget.scrollLeft;
    }
  }, []);

  return (
    <div className={`highlighted-textarea-wrap ${wrapClassName || ""}`}>
      <MarkdownHighlight
        ref={backdropRef}
        content={value || placeholder || ""}
        className="highlighted-textarea-backdrop"
      />
      <textarea
        ref={textareaRef}
        className="highlighted-textarea-input"
        value={value}
        onChange={onChange}
        onScroll={handleScroll}
        spellCheck={spellCheck}
        placeholder={placeholder}
      />
    </div>
  );
}
