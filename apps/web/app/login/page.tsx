import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <main className="min-h-dvh flex items-center justify-center p-12">
      <div className="max-w-sm w-full">
        <h1 className="text-2xl font-semibold mb-3">Sign in</h1>
        <p className="text-sm text-zinc-500 mb-6">
          Magic link to your team email. Sessions live in an httpOnly cookie.
        </p>
        <LoginForm next={next ?? "/campaigns"} error={error} />
      </div>
    </main>
  );
}
