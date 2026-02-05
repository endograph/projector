import { describe, it, expect } from "vitest";
import { StandardExecutor } from "../executor/standard";

describe("ImageBlock", () => {
  it("converts image blocks to Anthropic image content", () => {
    const executor = new StandardExecutor();

    // Access private helper via cast for testing.
    const convert = (executor as any).convertMessageToParam as (msg: any) => any;

    const msg = {
      role: "user",
      items: [
        { type: "text", text: "look" },
        { type: "image", mimeType: "image/jpeg", data: "BASE64" },
      ],
    };

    const param = convert(msg);
    expect(param.role).toBe("user");
    expect(Array.isArray(param.content)).toBe(true);

    const [t, i] = param.content as any[];
    expect(t.type).toBe("text");
    expect(t.text).toBe("look");

    expect(i.type).toBe("image");
    expect(i.source.type).toBe("base64");
    expect(i.source.media_type).toBe("image/jpeg");
    expect(i.source.data).toBe("BASE64");
  });
});

