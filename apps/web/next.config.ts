import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const supabaseHost = (() => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
})();

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      ...(supabaseHost
        ? [
            {
              protocol: "https" as const,
              hostname: supabaseHost,
              pathname: "/storage/v1/object/**",
            },
          ]
        : []),
    ],
  },
  allowedDevOrigins: ["leeds-inspection-acknowledge-gcc.trycloudflare.com"],
  // ffmpeg-static ships a native binary in its package dir; webpack-bundling
  // it into a serverless function destroys the binary's path resolution.
  // Keeping it external means Next.js leaves the package in node_modules at
  // deploy time and the binary stays runnable. sharp is in the same boat —
  // its prebuilt libvips bindings break when bundled.
  serverExternalPackages: ["ffmpeg-static", "sharp"],
};

export default withWorkflow(nextConfig);
