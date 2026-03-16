import { describe, expect, it } from "vitest";
import { StandardExecutor } from "../executor/standard";

describe("FileBlock", () => {
  it("converts file blocks to text content for the standard executor", () => {
    const executor = new StandardExecutor();

    const convert = (executor as any).convertMessageToParam as (msg: any) => any;

    const msg = {
      role: "user",
      items: [
        { type: "text", text: "review this" },
        {
          type: "file",
          url: "https://example.com/invoice.pdf",
          mediaType: "application/pdf",
          filename: "invoice.pdf",
        },
      ],
    };

    const param = convert(msg);
    expect(param.role).toBe("user");
    expect(Array.isArray(param.content)).toBe(true);

    const [textBlock, fileBlock] = param.content as any[];
    expect(textBlock).toEqual({ type: "text", text: "review this" });
    expect(fileBlock).toEqual({
      type: "text",
      text: "[file: invoice.pdf (application/pdf)] https://example.com/invoice.pdf",
    });
  });
});
