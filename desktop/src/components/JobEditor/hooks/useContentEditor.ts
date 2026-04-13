import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ProcessProvider } from "@clawtab/shared";
import type { Job } from "../../../types";
import { DEFAULT_SHELL_TEMPLATE, DEFAULT_TEMPLATE } from "../types";
import { IMAGE_RE } from "../utils";

interface UseContentEditorParams {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  isNew: boolean;
  isShellJob: boolean;
  defaultDirectionsTemplate: string;
}

export function useContentEditor({ form, setForm, isNew, isShellJob, defaultDirectionsTemplate }: UseContentEditorParams) {
  const [inlineContent, setInlineContent] = useState("");
  const [inlineLoaded, setInlineLoaded] = useState(false);
  const [sharedContent, setSharedContent] = useState("");
  const [sharedLoaded, setSharedLoaded] = useState(false);
  const [jobCwtContent, setJobCwtContent] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<"job.md" | "context.md">("job.md");
  const [cwtEdited, setCwtEdited] = useState(!isNew);
  const [dragOver, setDragOver] = useState(false);

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const inlineContentRef = useRef(inlineContent);
  inlineContentRef.current = inlineContent;

  // Reset preview file when switching to shell provider
  useEffect(() => {
    if (isShellJob && previewFile === "context.md") {
      setPreviewFile("job.md");
    }
  }, [isShellJob, previewFile]);

  // Load existing content for edit mode
  useEffect(() => {
    if (!isNew && form.job_type === "job" && form.folder_path) {
      const jn = form.job_id ?? "default";
      invoke<string>("read_cwt_entry_at", { folderPath: form.folder_path, jobId: jn, slug: form.slug || null })
        .then((content) => {
          setCwtEdited(!!content && content.trim() !== defaultDirectionsTemplate.trim());
          if (!inlineLoaded) {
            setInlineContent(content);
            setInlineLoaded(true);
          }
        })
        .catch(() => {});
      if (!sharedLoaded) {
        invoke<string>("read_cwt_shared_at", { folderPath: form.folder_path, slug: form.slug || null })
          .then((content) => {
            setSharedContent(content);
            setSharedLoaded(true);
          })
          .catch(() => {});
      }
      invoke<string>("read_cwt_context_at", { folderPath: form.folder_path, jobId: jn, slug: form.slug || null })
        .then(setJobCwtContent)
        .catch(() => setJobCwtContent(null));
    }
  }, [form.folder_path, form.job_type]);

  // For new wizard jobs, set default inline content
  useEffect(() => {
    if (isNew && !inlineLoaded) {
      setInlineContent(defaultDirectionsTemplate);
    }
  }, []);

  // Drag-drop image handler
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const el = editorRef.current;
      if (!el || previewFile !== "job.md") return;
      const p = event.payload;

      if (p.type === "over" || p.type === "drop") {
        const rect = el.getBoundingClientRect();
        const { x, y } = p.position;
        const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

        if (p.type === "over") {
          setDragOver(inside);
        } else if (inside) {
          setDragOver(false);
          const images = p.paths.filter((path: string) => IMAGE_RE.test(path));
          if (images.length === 0) return;
          const cursor = el.selectionStart ?? inlineContentRef.current.length;
          const insert = images.join("\n") + "\n";
          const updated = inlineContentRef.current.slice(0, cursor) + insert + inlineContentRef.current.slice(cursor);
          handleInlineChange(updated);
        }
      } else {
        setDragOver(false);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [previewFile]);

  const handleInlineChange = (content: string) => {
    setInlineContent(content);
    setCwtEdited(!!content && content.trim() !== defaultDirectionsTemplate.trim());
    if (!isNew && form.folder_path) {
      invoke("write_cwt_entry_at", {
        folderPath: form.folder_path,
        jobId: form.job_id ?? "default",
        content,
        slug: form.slug || null,
      }).catch(() => {});
    }
  };

  const handleProviderChange = (provider: ProcessProvider | null, model?: string | null) => {
    const previousTemplate = defaultDirectionsTemplate.trim();
    const nextTemplate = provider === "shell" ? DEFAULT_SHELL_TEMPLATE : DEFAULT_TEMPLATE;
    setForm((prev) => ({ ...prev, agent_provider: provider, agent_model: model ?? null }));
    if (provider === "shell") {
      setPreviewFile("job.md");
    }
    if (!cwtEdited || inlineContent.trim() === previousTemplate) {
      setInlineContent(nextTemplate);
      setCwtEdited(false);
      if (!isNew && form.folder_path) {
        invoke("write_cwt_entry_at", {
          folderPath: form.folder_path,
          jobId: form.job_id ?? "default",
          content: nextTemplate,
          slug: form.slug || null,
        }).catch(() => {});
      }
    }
  };

  return {
    inlineContent,
    setInlineContent,
    inlineLoaded,
    setInlineLoaded,
    sharedContent,
    setSharedContent,
    sharedLoaded,
    setSharedLoaded,
    jobCwtContent,
    previewFile,
    setPreviewFile,
    cwtEdited,
    setCwtEdited,
    dragOver,
    editorRef,
    handleInlineChange,
    handleProviderChange,
  };
}
