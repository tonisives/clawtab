import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useJob, useJobStatus } from "../../src/store/jobs";
import { useRunsStore } from "../../src/store/runs";
import { StatusBadge } from "@clawtab/shared";
import { JobDetailView } from "@clawtab/shared";
import { ContentContainer } from "../../src/components/ContentContainer";
import { useLogs } from "../../src/hooks/useLogs";
import { createWsTransport } from "../../src/transport/wsTransport";
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { registerRequest } from "../../src/lib/useRequestMap";
import { colors } from "@clawtab/shared";
import type { RunRecord } from "@clawtab/shared";

const wsTransport = createWsTransport();

export default function JobDetailScreen() {
  const { name, run_id } = useLocalSearchParams<{ name: string; run_id?: string }>();
  const job = useJob(name);
  const status = useJobStatus(name);
  const { logs } = useLogs(name);
  const runs = useRunsStore((s) => s.runs[name]) ?? null;
  const router = useRouter();
  const [runsLoading, setRunsLoading] = useState(false);

  const loadRuns = useCallback(() => {
    const send = getWsSend();
    if (!send || !name) return;
    const id = nextId();
    setRunsLoading(true);
    send({ type: "get_run_history", id, name, limit: 50 });
    registerRequest<RunRecord[]>(id).then((result) => {
      useRunsStore.getState().setRuns(name, result);
      setRunsLoading(false);
    });
  }, [name]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  if (!job) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: name }} />
        <View style={styles.center}>
          <Text style={styles.notFound}>Job not found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: job.name,
          headerRight: () => <StatusBadge status={status} />,
        }}
      />
      <ContentContainer wide>
        <JobDetailView
          transport={wsTransport}
          job={job}
          status={status}
          logs={logs}
          runs={runs}
          runsLoading={runsLoading}
          onBack={() => router.back()}
          onReloadRuns={loadRuns}
          expandRunId={run_id}
        />
      </ContentContainer>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  notFound: {
    color: colors.textMuted,
    fontSize: 16,
  },
});
