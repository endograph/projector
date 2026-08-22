import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentResponse } from "./AgentResponse";

describe("agent response", () => {
  it("renders GitHub-flavored Markdown", () => {
    const html = renderToStaticMarkup(
      <AgentResponse
        markdown={[
          "# Result",
          "",
          "- [x] shipped",
          "",
          "| name | value |",
          "| --- | --- |",
          "| answer | 42 |",
        ].join("\n")}
        phase="settled"
      />,
    );

    expect(html).toContain("<h1>Result</h1>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table>");
    expect(html).toContain("<td>42</td>");
  });

  it("drops raw HTML and does not load Markdown images", () => {
    const html = renderToStaticMarkup(
      <AgentResponse
        markdown={[
          "<script>alert('nope')</script>",
          "",
          "[unsafe](javascript:alert('nope'))",
          "",
          "![diagram](https://example.com/tracker.png)",
        ].join("\n")}
        phase="settled"
      />,
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain("[image: diagram]");
  });

  it("keeps code-block chrome stable and highlights only after settlement", () => {
    const markdown = "```ts\nconst answer = 42;\n```";
    const streaming = renderToStaticMarkup(
      <AgentResponse markdown={markdown} phase="streaming" />,
    );
    const settled = renderToStaticMarkup(
      <AgentResponse markdown={markdown} phase="settled" />,
    );

    for (const html of [streaming, settled]) {
      expect(html).toContain('class="agent-code-block"');
      expect(html).toContain('class="agent-code-language">ts</span>');
      expect(html).toContain('aria-label="Copy code"');
    }
    expect(streaming).not.toContain("hljs-keyword");
    expect(settled).toContain("hljs-keyword");
  });
});
