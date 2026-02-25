import { useEffect, useRef } from "react";

interface Props {
  content: string;
  autoScroll?: boolean;
}

export function LogViewer({ content, autoScroll = true }: Props) {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (autoScroll && ref.current) {
      const el = ref.current;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [content, autoScroll]);

  return <pre ref={ref} className="log-viewer">{content}</pre>;
}
