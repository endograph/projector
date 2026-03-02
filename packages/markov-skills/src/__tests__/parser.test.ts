import { describe, expect, it } from "vitest";
import { parseSkillMd } from "../parser.js";

describe("parseSkillMd", () => {
  it("parses content without frontmatter", () => {
    const raw = "# Hello World\n\nSome content here.";
    const result = parseSkillMd(raw);

    expect(result.frontmatter).toEqual({});
    expect(result.content).toBe("# Hello World\n\nSome content here.");
  });

  it("parses frontmatter with name and description", () => {
    const raw = `---
name: my-skill
description: A test skill
---

# My Skill

Content goes here.`;

    const result = parseSkillMd(raw);

    expect(result.frontmatter.name).toBe("my-skill");
    expect(result.frontmatter.description).toBe("A test skill");
    expect(result.content).toBe("# My Skill\n\nContent goes here.");
  });

  it("handles frontmatter with only name", () => {
    const raw = `---
name: skill-only
---

Body content.`;

    const result = parseSkillMd(raw);

    expect(result.frontmatter.name).toBe("skill-only");
    expect(result.frontmatter.description).toBeUndefined();
    expect(result.content).toBe("Body content.");
  });

  it("handles frontmatter with only description", () => {
    const raw = `---
description: Just a description
---

Content.`;

    const result = parseSkillMd(raw);

    expect(result.frontmatter.name).toBeUndefined();
    expect(result.frontmatter.description).toBe("Just a description");
    expect(result.content).toBe("Content.");
  });

  it("ignores unknown frontmatter fields", () => {
    const raw = `---
name: test
description: Test skill
author: Someone
version: 1.0.0
---

Content.`;

    const result = parseSkillMd(raw);

    expect(result.frontmatter).toEqual({
      name: "test",
      description: "Test skill",
    });
  });

  it("handles missing closing frontmatter delimiter", () => {
    const raw = `---
name: broken
description: No closing delimiter

Content here.`;

    const result = parseSkillMd(raw);

    // Should treat entire content as body since no closing delimiter
    expect(result.frontmatter).toEqual({});
  });

  it("handles empty content", () => {
    const raw = "";
    const result = parseSkillMd(raw);

    expect(result.frontmatter).toEqual({});
    expect(result.content).toBe("");
  });

  it("handles frontmatter only (no body)", () => {
    const raw = `---
name: minimal
description: Minimal skill
---`;

    const result = parseSkillMd(raw);

    expect(result.frontmatter.name).toBe("minimal");
    expect(result.frontmatter.description).toBe("Minimal skill");
    expect(result.content).toBe("");
  });

  it("preserves multiline content", () => {
    const raw = `---
name: multiline
description: Test
---

# Section 1

Paragraph one.

## Section 2

- Item 1
- Item 2

\`\`\`javascript
const x = 1;
\`\`\``;

    const result = parseSkillMd(raw);

    expect(result.content).toContain("# Section 1");
    expect(result.content).toContain("- Item 1");
    expect(result.content).toContain("const x = 1;");
  });
});
