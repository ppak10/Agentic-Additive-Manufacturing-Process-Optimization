import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// Shared markdown renderer for agent-authored text (assistant messages,
// panel candidates/advisors). Compact styling tuned to sit inside the
// existing text-xs mono message blocks — no @tailwindcss/typography dep.

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("markdown break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <div className="font-heading text-sm mt-2 mb-1">{children}</div>,
          h2: ({ children }) => <div className="font-heading text-sm mt-2 mb-1">{children}</div>,
          h3: ({ children }) => <div className="font-heading mt-2 mb-1">{children}</div>,
          h4: ({ children }) => <div className="font-heading mt-2 mb-1">{children}</div>,
          h5: ({ children }) => <div className="font-heading mt-2 mb-1">{children}</div>,
          h6: ({ children }) => <div className="font-heading mt-2 mb-1">{children}</div>,
          p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="my-1 ml-4 list-disc [&_ul]:my-0">{children}</ul>,
          ol: ({ children }) => <ol className="my-1 ml-4 list-decimal [&_ol]:my-0">{children}</ol>,
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="underline">
              {children}
            </a>
          ),
          code: ({ className: codeClass, children }) =>
            // block code gets a language-* class from the fence; inline doesn't
            /language-/.test(codeClass ?? "") ? (
              <code className={codeClass}>{children}</code>
            ) : (
              <code className="font-mono bg-secondary-background border border-border/50 rounded px-1 py-px text-[0.9em]">
                {children}
              </code>
            ),
          pre: ({ children }) => (
            <pre className="my-1.5 border-2 border-border rounded-base bg-secondary-background p-2 overflow-x-auto font-mono text-[10px] leading-snug [&_code]:bg-transparent [&_code]:border-0 [&_code]:p-0">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-l-4 border-border pl-2 opacity-80">{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="my-1.5 overflow-x-auto">
              <table className="border-2 border-border text-[10px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border bg-secondary-background px-1.5 py-0.5 text-left font-heading">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-border px-1.5 py-0.5 align-top">{children}</td>,
          hr: () => <hr className="my-2 border-t-2 border-border" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
