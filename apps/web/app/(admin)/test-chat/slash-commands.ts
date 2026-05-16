export type SlashCommand = {
  name: string;
  usage: string;
  description: string;
  insertText: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/campaigns",
    usage: "/campaigns",
    description: "List campaigns in this workspace.",
    insertText: "/campaigns",
  },
  {
    name: "/posts",
    usage: "/posts [campaign-slug]",
    description: "List recent posts. Optional: scope to one campaign.",
    insertText: "/posts ",
  },
  {
    name: "/approvals",
    usage: "/approvals",
    description: "Show pending approvals in this workspace.",
    insertText: "/approvals",
  },
  {
    name: "/brand",
    usage: "/brand",
    description: "Read this workspace's brand voice, ICP, and positioning.",
    insertText: "/brand",
  },
  {
    name: "/draft",
    usage: "/draft <campaign> <topic>",
    description:
      "Start a single-post draft for the named campaign. The content sub-agent picks up brand voice automatically.",
    insertText: "/draft ",
  },
  {
    name: "/campaign",
    usage: "/campaign <prompt>",
    description:
      "Start a campaign plan — strategist drafts a brief and content calendar from the prompt.",
    insertText: "/campaign ",
  },
  {
    name: "/workflow",
    usage: "/workflow [channel] <prompt>",
    description:
      "Bypass the orchestrator and drive the single-post workflow end-to-end. Channel defaults to linkedin.",
    insertText: "/workflow ",
  },
];

export function filterCommands(input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const firstToken = input.split(/\s/, 1)[0]!.toLowerCase();
  if (firstToken.length === input.length) {
    const q = firstToken;
    return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
  }
  return [];
}
