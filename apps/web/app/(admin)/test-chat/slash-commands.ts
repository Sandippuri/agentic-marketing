export type SlashCommand = {
  name: string;
  usage: string;
  description: string;
  insertText: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/workflow",
    usage: "/workflow [channel] <prompt>",
    description:
      "Bypass the orchestrator and drive the single-post workflow end-to-end. Channel defaults to linkedin.",
    insertText: "/workflow ",
  },
  {
    name: "/campaign",
    usage: "/campaign <prompt>",
    description:
      "Start a campaign plan — strategist drafts a brief and content calendar from the prompt.",
    insertText: "/campaign ",
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
