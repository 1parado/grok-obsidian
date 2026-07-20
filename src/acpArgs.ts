import type { GrokBuildSettings } from "./settings";

/** Build CLI args so image sessions share safety bounds with headless turns. */
export function buildAcpProcessArgs(settings: GrokBuildSettings): string[] {
  const args: string[] = [
    // Global headless-compatible safety flags (accepted before `agent`).
    "--permission-mode",
    "plan",
    "--max-turns",
    String(settings.maxTurns),
  ];
  if (settings.disallowedTools) {
    args.push("--disallowed-tools", settings.disallowedTools);
  }
  if (settings.extraRules) {
    args.push("--rules", settings.extraRules);
  }
  // Model is never overridden by the plugin — use CLI / Grok Build default.
  args.push("agent", "stdio");
  return args;
}

export function appendAcpSafetyPrompt(prompt: string, settings: GrokBuildSettings): string {
  const rules = [
    "Safety: do not modify files, run shell commands, or change the vault.",
    "When the user wants edits, return multi-file proposals: ```md:path/to/file.md full body, or path heading + <<<<<<< SEARCH / ======= / >>>>>>> REPLACE partial blocks.",
    settings.extraRules ? `Extra rules: ${settings.extraRules}` : "",
    settings.disallowedTools
      ? `Disallowed tools (must not use): ${settings.disallowedTools}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `${prompt}\n\n--- ACP SAFETY ---\n${rules}\n--- END SAFETY ---`;
}
