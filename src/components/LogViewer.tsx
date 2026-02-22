interface Props {
  content: string;
}

export function LogViewer({ content }: Props) {
  return <pre className="log-viewer">{content}</pre>;
}
