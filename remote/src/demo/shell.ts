// Desktop captures include fixed-width chrome. Keep the transcript in the
// terminal and render the prompt separately so it stays above the keyboard.
export let demoShell = (output: string, provider?: string) => {
  if (provider === "opencode") return {
    output: "OpenCode 1.15.5\n~/workspace/tgs/clawtab:main\n",
    placeholder: 'Ask anything... "Fix a TODO in the codebase"',
    model: "Build · GLM-5.1 Z.AI Coding Plan",
  }
  if (provider === "claude") return {
    output: output.split("────────────────")[0].trimEnd(),
    placeholder: 'Try "create a util logging.py that..."',
    model: "Opus 4.8 · Claude Max",
  }
  if (provider === "codex") return {
    output: output.split("\n").filter((line) => !/^─+$/.test(line.trim()) && !line.startsWith("› ")).join("\n").trimEnd(),
    placeholder: "Ask Codex to do anything",
    model: "Codex · Default model",
  }
  return { output, placeholder: "Type a command", model: "Shell" }
}
