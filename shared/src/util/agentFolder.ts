export let defaultAgentFolder = (
  workDir: string | undefined,
  sourceMachineId: string | null | undefined,
  targetMachineId: string | null | undefined,
) => sourceMachineId && targetMachineId && sourceMachineId !== targetMachineId ? "~" : workDir || "~";

export let resolveAgentFolder = async (
  path: string,
  request: (request: { action: string; path: string }) => Promise<{ path?: unknown }>,
) => {
  let folder = await request({ action: "list_directory", path: path.trim() || "~" });
  if (typeof folder.path !== "string" || !folder.path.startsWith("/")) {
    throw new Error("Could not resolve the folder on this machine.");
  }
  return folder.path;
};
