import type { Metadata } from "next";
import { eq, and } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb, schema } from "@marketing/db";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

async function getPost(slug: string) {
  const db = getDb();
  const [post] = await db
    .select()
    .from(schema.contentItems)
    .where(
      and(
        eq(schema.contentItems.publishedUrl, `/blog/${slug}`),
        eq(schema.contentItems.status, "published"),
      ),
    )
    .limit(1);
  return post ?? null;
}

// Lightweight markdown-to-HTML renderer (no external dep).
// Handles: headings, bold, italic, inline code, code blocks, hr, lists, paragraphs.
function renderMarkdown(md: string): string {
  let html = md
    // Code blocks (must come before inline code)
    .replace(/```[\w]*\n([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    // Headings
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // Horizontal rule
    .replace(/^---$/gm, "<hr />")
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Unordered lists
    .replace(/^[*-] (.+)$/gm, "<li>$1</li>")
    // Line breaks between blocks → paragraphs
    .split(/\n\n+/)
    .map((block) => {
      if (/^<(h[1-6]|pre|hr|ul|li)/.test(block.trim())) return block;
      if (block.includes("<li>")) return `<ul>${block}</ul>`;
      return `<p>${block.replace(/\n/g, "<br />")}</p>`;
    })
    .join("\n");

  return html;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return {};

  const stripped = post.bodyMd.replace(/[#*`_>\-]/g, "").replace(/\n/g, " ");
  const description = stripped.slice(0, 160).trimEnd();
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "https://yourdomain.com";

  return {
    title: post.title,
    description,
    openGraph: {
      title: post.title,
      description,
      type: "article",
      publishedTime: post.publishedAt?.toISOString(),
      url: `${baseUrl}/blog/${slug}`,
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description,
    },
    alternates: {
      canonical: `${baseUrl}/blog/${slug}`,
    },
  };
}

export default async function BlogPost({ params }: Props) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();

  const publishedDate = post.publishedAt
    ? new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(post.publishedAt)
    : null;

  const htmlContent = renderMarkdown(post.bodyMd);

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      {/* Reading progress bar placeholder */}
      <div className="h-1 bg-zinc-900 dark:bg-white w-0" aria-hidden="true" />

      <article className="max-w-2xl mx-auto py-16 px-6">
        <header className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
              {post.stage}
            </span>
            <span className="text-zinc-300 dark:text-zinc-700" aria-hidden>·</span>
            <span className="text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
              {post.type.replace("_", " ")}
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 leading-tight mb-4">
            {post.title}
          </h1>

          {publishedDate && (
            <time
              dateTime={post.publishedAt?.toISOString()}
              className="text-sm text-zinc-500 dark:text-zinc-400"
            >
              {publishedDate}
            </time>
          )}
        </header>

        <div
          className={[
            "prose prose-zinc dark:prose-invert max-w-none",
            "prose-headings:font-bold prose-headings:tracking-tight",
            "prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg",
            "prose-p:leading-relaxed prose-p:text-zinc-700 dark:prose-p:text-zinc-300",
            "prose-code:bg-zinc-100 dark:prose-code:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-sm",
            "prose-pre:bg-zinc-900 dark:prose-pre:bg-zinc-950 prose-pre:rounded-xl prose-pre:p-4 prose-pre:overflow-x-auto",
            "prose-strong:text-zinc-900 dark:prose-strong:text-zinc-50",
            "prose-a:text-zinc-900 dark:prose-a:text-zinc-100 prose-a:underline prose-a:underline-offset-2",
            "prose-hr:border-zinc-200 dark:prose-hr:border-zinc-800",
          ].join(" ")}
          /* eslint-disable-next-line react/no-danger */
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />

        <footer className="mt-16 pt-8 border-t border-zinc-200 dark:border-zinc-800">
          <a
            href="/blog"
            className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-50 transition-colors"
          >
            ← All posts
          </a>
        </footer>
      </article>
    </div>
  );
}
