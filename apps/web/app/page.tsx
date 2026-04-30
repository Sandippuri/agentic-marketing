export default function Home() {
  return (
    <main className="min-h-dvh flex flex-col items-center justify-center gap-6 p-12 font-sans">
      <h1 className="text-3xl font-semibold tracking-tight">
        Marketing Control Plane
      </h1>
      <p className="text-zinc-600 dark:text-zinc-400 max-w-md text-center">
        Admin UI lives at <code>/campaigns</code>, <code>/approvals</code>, and{" "}
        <code>/audit-log</code>. The agent surface is in Slack and Discord.
      </p>
      <p className="text-xs text-zinc-500">
        Public blog posts render under <code>/blog/[slug]</code>.
      </p>
    </main>
  );
}
