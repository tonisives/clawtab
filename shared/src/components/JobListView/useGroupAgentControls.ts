import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";

import type { AgentEffort, AgentModelOption, ProcessProvider } from "../../types/process";
import { GROUP_AGENT_PROVIDER_STORAGE_KEY } from "./sign";

const isWeb = Platform.OS === "web";

interface UseGroupAgentControlsParams {
  agent: {
    agentModelOptions: AgentModelOption[];
    defaultAgentModel?: string | null;
    defaultAgentProvider: ProcessProvider;
    getAgentProviders?: () => Promise<ProcessProvider[]>;
  };
}

export function useGroupAgentControls({
  agent,
}: UseGroupAgentControlsParams) {
  const {
    agentModelOptions,
    defaultAgentModel,
    defaultAgentProvider,
    getAgentProviders,
  } = agent;
  const [agentProviders, setAgentProviders] = useState<ProcessProvider[]>([]);
  const [groupAgentProviders, setGroupAgentProviders] = useState<Record<string, ProcessProvider>>(() => {
    if (!isWeb || typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(GROUP_AGENT_PROVIDER_STORAGE_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, ProcessProvider>;
    } catch {
      return {};
    }
  });
  const [groupAgentModels, setGroupAgentModels] = useState<Record<string, string | null>>({});
  const [groupAgentEfforts, setGroupAgentEfforts] = useState<Record<string, AgentEffort | null>>({});

  useEffect(() => {
    let cancelled = false;
    if (!getAgentProviders) return;
    getAgentProviders()
      .then((providers) => {
        if (!cancelled) setAgentProviders(providers);
      })
      .catch(() => {
        if (!cancelled) setAgentProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [getAgentProviders]);

  useEffect(() => {
    if (!isWeb || typeof localStorage === "undefined") return;
    localStorage.setItem(GROUP_AGENT_PROVIDER_STORAGE_KEY, JSON.stringify(groupAgentProviders));
  }, [groupAgentProviders]);

  const resolvedAgentProviders = useMemo(() => {
    const next = agentProviders.includes(defaultAgentProvider)
      ? agentProviders
      : [defaultAgentProvider, ...agentProviders];
    return next.filter((provider, index) => next.indexOf(provider) === index);
  }, [agentProviders, defaultAgentProvider]);

  const resolveGroupAgentProvider = useCallback((workDir: string) => {
    const stored = groupAgentProviders[workDir];
    if (stored && (stored === "shell" || resolvedAgentProviders.includes(stored))) return stored;
    return defaultAgentProvider;
  }, [defaultAgentProvider, groupAgentProviders, resolvedAgentProviders]);

  const resolveGroupAgentModel = useCallback((workDir: string) => {
    const provider = resolveGroupAgentProvider(workDir);
    const stored = groupAgentModels[workDir];
    if (agentModelOptions.some((option) => option.provider === provider && option.modelId === stored)) {
      return stored;
    }
    if (
      provider === defaultAgentProvider
      && agentModelOptions.some((option) => option.provider === provider && option.modelId === (defaultAgentModel ?? null))
    ) {
      return defaultAgentModel ?? null;
    }
    return agentModelOptions.find((option) => option.provider === provider)?.modelId ?? null;
  }, [agentModelOptions, defaultAgentModel, defaultAgentProvider, groupAgentModels, resolveGroupAgentProvider]);

  const handleSetGroupAgentProvider = useCallback((workDir: string, provider: ProcessProvider) => {
    setGroupAgentProviders((prev) => {
      if (prev[workDir] === provider) return prev;
      return { ...prev, [workDir]: provider };
    });
    setGroupAgentModels((prev) => {
      const stored = prev[workDir];
      if (agentModelOptions.some((option) => option.provider === provider && option.modelId === stored)) {
        return prev;
      }
      const nextModel = agentModelOptions.find((option) => option.provider === provider)?.modelId ?? null;
      if (stored === nextModel) return prev;
      return { ...prev, [workDir]: nextModel };
    });
    setGroupAgentEfforts((prev) => (prev[workDir] == null ? prev : { ...prev, [workDir]: null }));
  }, [agentModelOptions]);

  const resolveGroupAgentEffort = useCallback((workDir: string) => groupAgentEfforts[workDir] ?? null, [groupAgentEfforts]);

  const handleSetGroupAgentModel = useCallback((workDir: string, provider: ProcessProvider, modelId: string | null, effort: AgentEffort | null) => {
    setGroupAgentProviders((prev) => {
      if (prev[workDir] === provider) return prev;
      return { ...prev, [workDir]: provider };
    });
    setGroupAgentModels((prev) => {
      if (prev[workDir] === modelId) return prev;
      return { ...prev, [workDir]: modelId };
    });
    setGroupAgentEfforts((prev) => {
      if (prev[workDir] === effort) return prev;
      return { ...prev, [workDir]: effort };
    });
  }, []);

  return {
    handleSetGroupAgentModel,
    handleSetGroupAgentProvider,
    resolveGroupAgentModel,
    resolveGroupAgentEffort,
    resolveGroupAgentProvider,
    resolvedAgentProviders,
  };
}
