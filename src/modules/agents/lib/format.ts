const LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  antigravity: "Antigravity",
  pi: "Pi",
  gjc: "GJC",
  opencode: "OpenCode",
  grok: "Grok",
  oarlock: "Oarlock",
};

export function displayAgent(agent: string): string {
  if (!agent) return "Agent";
  const id = agent.toLowerCase();
  return (
    (Object.prototype.hasOwnProperty.call(LABELS, id) ? LABELS[id] : undefined) ??
    agent.charAt(0).toUpperCase() + agent.slice(1)
  );
}
