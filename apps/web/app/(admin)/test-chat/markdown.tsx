"use client";

// Assistant-bubble markdown. Headers, lists, links, code blocks, tables, and
// task lists via remark-gfm. HTML rendering is OFF (react-markdown's default)
// so the LLM can't inject raw HTML / script tags into the chat.
//
// Each block element is Tailwind-styled to fit the chat bubble's small text
// scale. The wrapping bubble already constrains width, so we don't need any
// max-width here.

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  p: ({ children }) => (
    <p className="my-1.5 first:mt-0 last:mb-0 leading-relaxed">{children}</p>
  ),
  h1: ({ children }) => (
    <h1 className="mb-1.5 mt-3 text-base font-semibold first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2.5 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-zinc-600 first:mt-0 dark:text-zinc-300">
      {children}
    </h4>
  ),
  ul: ({ children }) => (
    <ul className="my-1.5 list-disc space-y-0.5 pl-4 first:mt-0 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 list-decimal space-y-0.5 pl-4 first:mt-0 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-zinc-300 pl-2 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
      {children}
    </blockquote>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-indigo-600 underline underline-offset-2 hover:text-indigo-500 dark:text-indigo-400"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children, className }) => {
    const isBlock = typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      return (
        <code className="font-mono text-[12px] leading-relaxed">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-zinc-200/70 px-1 py-0.5 font-mono text-[12px] dark:bg-zinc-700/70">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-1.5 overflow-x-auto rounded-md bg-zinc-900 p-2 text-zinc-100 first:mt-0 last:mb-0 dark:bg-zinc-950">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-zinc-100 dark:bg-zinc-800/60">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border-b border-zinc-200 px-2 py-1 text-left font-medium dark:border-zinc-700">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-zinc-100 px-2 py-1 dark:border-zinc-800/80">
      {children}
    </td>
  ),
  hr: () => <hr className="my-2 border-zinc-200 dark:border-zinc-800" />,
};

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
      {text}
    </ReactMarkdown>
  );
}
