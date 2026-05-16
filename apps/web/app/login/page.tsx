import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <main className="min-h-dvh flex items-center justify-center p-6 bg-bg">
      <div className="w-full max-w-sm">
        <div className="surface p-7 space-y-6">
          <header className="space-y-1.5">
            <h1 className="text-[22px] font-semibold text-ink leading-tight">
              Sign in
            </h1>
            <p className="text-[13px] text-mid leading-relaxed">
              Use your team email and password, or request a one-time magic
              link.
            </p>
          </header>
          <LoginForm next={next ?? "/campaigns"} error={error} />
        </div>
        <p className="mt-4 text-center text-[11px] text-faint">
          Sessions are stored in an httpOnly cookie.
        </p>
      </div>
    </main>
  );
}
