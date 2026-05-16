export const dynamic = "force-dynamic";

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-[var(--bg)] flex items-center justify-center px-6 py-10">
      <div className="w-full max-w-2xl">{children}</div>
    </div>
  );
}
