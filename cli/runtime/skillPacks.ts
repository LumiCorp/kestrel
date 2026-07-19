import type { SkillPackDefinition, TuiProfile } from "../contracts.js";

const INTERNAL_RUNTIME_TOOLS = ["FinalizeAnswer", "effect_result_lookup"] as const;
const CODE_SKILL_PACK_ID = "code";

const SKILL_PACKS: SkillPackDefinition[] = [
  {
    id: "research",
    label: "Research",
    instructions: [
      "Prefer current evidence-backed answers with direct source attribution when tools are available.",
      "Break broad requests into evidence gathering first, then synthesize only after enough coverage exists.",
      "Call out uncertainty explicitly when the available evidence is partial or conflicting.",
    ],
    allowedTools: [
      "free.time.current",
      "free.geocode.lookup",
      "free.exchange.rate",
      "free.hn.top",
      "internet.search",
      "internet.news",
      "internet.images",
      "internet.get_url",
      "internet.scrape",
      "internet.deep_report",
      "internet.headlines",
      "evidence.extract",
    ],
  },
  {
    id: "code",
    label: "Code",
    instructions: [
      "Bias toward inspecting the local workspace before proposing changes.",
      "Keep changes small, reversible, and grounded in the current repository state.",
      "Prefer filesystem inspection and code execution over speculative reasoning.",
    ],
    allowedTools: [
      "fs.list",
      "fs.read_text",
      "fs.search_text",
      "fs.create_text",
      "fs.edit_text",
      "fs.apply_patch",
      "artifact.read",
      "fs.mkdir",
      "fs.copy",
      "fs.move",
      "fs.delete",
      "code.execute",
    ],
  },
  {
    id: "browse",
    label: "Browse Only",
    instructions: [
      "Stay in read-only evidence gathering mode and avoid proposing write-side actions.",
      "Summarize findings cleanly and highlight anything that still needs operator approval.",
    ],
    allowedTools: [
      "free.time.current",
      "free.geocode.lookup",
      "free.exchange.rate",
      "free.hn.top",
      "internet.search",
      "internet.news",
      "internet.images",
      "internet.get_url",
      "internet.scrape",
      "internet.headlines",
      "evidence.extract",
      "fs.list",
      "fs.read_text",
      "fs.search_text",
    ],
  },
];

export function listSkillPacks(): SkillPackDefinition[] {
  return SKILL_PACKS.map((entry) => ({
    ...entry,
    instructions: [...entry.instructions],
    allowedTools: [...entry.allowedTools],
  }));
}

export function getSkillPackById(id: string | undefined): SkillPackDefinition | undefined {
  if (id === undefined) {
    return ;
  }
  const normalized = id.trim().toLowerCase();
  return SKILL_PACKS.find((entry) => entry.id === normalized);
}

export function applySkillPackToProfile(
  profile: TuiProfile,
  skillPack: SkillPackDefinition | undefined,
): TuiProfile {
  if (skillPack === undefined) {
    return profile;
  }

  const baseAllowlist = new Set(profile.toolAllowlist ?? []);
  const constrained = skillPack.allowedTools.filter((toolName) => baseAllowlist.has(toolName));
  if (skillPack.id === CODE_SKILL_PACK_ID) {
    for (const toolName of baseAllowlist) {
      if (
        (toolName.startsWith("dev.shell.") || toolName.startsWith("dev.process.")) &&
        constrained.includes(toolName) === false
      ) {
        constrained.push(toolName);
      }
    }
  }
  for (const internalTool of INTERNAL_RUNTIME_TOOLS) {
    if (constrained.includes(internalTool) === false) {
      constrained.push(internalTool);
    }
  }

  return {
    ...profile,
    toolAllowlist: constrained,
  };
}
