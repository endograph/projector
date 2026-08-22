import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
  type Options,
} from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

type AgentResponsePhase = "streaming" | "settled";

type AgentResponseProps = Readonly<{
  markdown: string;
  phase: AgentResponsePhase;
}>;

type CopyState = "idle" | "copied";

type MarkdownElementProps<Tag extends keyof React.JSX.IntrinsicElements> =
  ComponentPropsWithoutRef<Tag> & ExtraProps;

const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm];
const SETTLED_REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [
  [rehypeHighlight, { detect: false }],
];

function reactNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(reactNodeText).join("");
  if (isValidElement<{ readonly children?: ReactNode }>(node)) {
    return reactNodeText(node.props.children);
  }
  return "";
}

function codeLanguage(children: ReactNode): string | undefined {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ readonly className?: string }>(child)) continue;
    const match = child.props.className?.match(/(?:^|\s)language-([^\s]+)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

async function writeClipboard(text: string): Promise<CopyState> {
  if (!globalThis.navigator?.clipboard) return "idle";
  try {
    await globalThis.navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "idle";
  }
}

function MarkdownPre({ node: _node, children, ...props }: MarkdownElementProps<"pre">) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const language = codeLanguage(children) ?? "code";
  const code = reactNodeText(children).replace(/\n$/, "");

  useEffect(() => () => {
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    const nextState = await writeClipboard(code);
    if (nextState !== "copied") return;
    setCopyState(nextState);
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), 1600);
  };

  return (
    <div className="agent-code-block">
      <div className="agent-code-head">
        <span className="agent-code-language">{language}</span>
        <button
          className="agent-code-copy"
          type="button"
          aria-label={copyState === "copied" ? "Code copied" : "Copy code"}
          onClick={() => void copy()}
        >
          {copyState === "copied" ? "copied" : "copy"}
        </button>
      </div>
      <pre {...props} tabIndex={0}>{children}</pre>
    </div>
  );
}

function MarkdownLink({ node: _node, href, children, ...props }: MarkdownElementProps<"a">) {
  if (!href) return <>{children}</>;
  const external = /^(?:https?:)?\/\//.test(href);
  return (
    <a
      {...props}
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
    >
      {children}
    </a>
  );
}

function MarkdownImage({ alt }: MarkdownElementProps<"img">) {
  return <span className="agent-image-placeholder">[image: {alt || "omitted"}]</span>;
}

function MarkdownTable({ node: _node, children, ...props }: MarkdownElementProps<"table">) {
  return (
    <div className="agent-table-scroll">
      <table {...props}>{children}</table>
    </div>
  );
}

const MARKDOWN_COMPONENTS = {
  a: MarkdownLink,
  img: MarkdownImage,
  pre: MarkdownPre,
  table: MarkdownTable,
} satisfies Components;

/** Renders agent-authored Markdown with highlighting deferred until settlement. */
export const AgentResponse = memo(function AgentResponse({ markdown, phase }: AgentResponseProps) {
  return (
    <div
      className="msg-body agent-response"
      data-streaming={phase === "streaming" ? "" : undefined}
    >
      <ReactMarkdown
        components={MARKDOWN_COMPONENTS}
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={phase === "settled" ? SETTLED_REHYPE_PLUGINS : undefined}
        skipHtml
        urlTransform={defaultUrlTransform}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});
