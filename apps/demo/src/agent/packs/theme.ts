import { z } from "zod";
import { createPack } from "markov-machines";

export const themeStateValidator = z.object({
  hue: z.number().min(0).max(360).default(120), // 120 = green (current default)
  saturation: z.number().min(0).max(100).default(100),
  animated: z.boolean().default(false), // flux mode - smooth color drift
  gradient: z.boolean().default(false), // viewport-wide gradient overlay
});

export type ThemeState = z.infer<typeof themeStateValidator>;

// Named colors mapped to HSL hue values
const namedColors: Record<string, { hue: number; saturation?: number }> = {
  // Reds
  red: { hue: 0 },
  crimson: { hue: 348 },
  scarlet: { hue: 5 },
  // Oranges
  orange: { hue: 30 },
  coral: { hue: 16 },
  salmon: { hue: 6, saturation: 93 },
  peach: { hue: 28, saturation: 87 },
  // Yellows
  yellow: { hue: 60 },
  gold: { hue: 51 },
  amber: { hue: 45 },
  // Greens
  lime: { hue: 90 },
  green: { hue: 120 },
  emerald: { hue: 140 },
  mint: { hue: 150, saturation: 70 },
  teal: { hue: 175 },
  // Cyans
  cyan: { hue: 180 },
  aqua: { hue: 180 },
  turquoise: { hue: 174 },
  // Blues
  blue: { hue: 210 },
  sky: { hue: 197 },
  azure: { hue: 210 },
  navy: { hue: 230, saturation: 80 },
  indigo: { hue: 240 },
  // Purples
  purple: { hue: 270 },
  violet: { hue: 280 },
  lavender: { hue: 270, saturation: 50 },
  plum: { hue: 300, saturation: 47 },
  // Magentas/Pinks
  magenta: { hue: 300 },
  fuchsia: { hue: 300 },
  pink: { hue: 330 },
  rose: { hue: 340 },
  hotpink: { hue: 330, saturation: 100 },
  // Neutrals
  white: { hue: 0, saturation: 0 },
  gray: { hue: 0, saturation: 0 },
  grey: { hue: 0, saturation: 0 },
};

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return { h: 120, s: 100, l: 50 };

  const r = parseInt(result[1]!, 16) / 255;
  const g = parseInt(result[2]!, 16) / 255;
  const b = parseInt(result[3]!, 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

interface ParsedTheme {
  hue: number;
  saturation: number;
  animated: boolean;
  gradient: boolean;
}

// Find the closest named color for a given hue
function getColorName(hue: number, saturation: number): string {
  if (saturation < 10) return "gray";

  // Map of primary hue ranges to names
  const hueRanges: [number, number, string][] = [
    [0, 15, "red"],
    [15, 40, "orange"],
    [40, 70, "yellow"],
    [70, 110, "lime"],
    [110, 150, "green"],
    [150, 185, "cyan"],
    [185, 230, "blue"],
    [230, 260, "indigo"],
    [260, 290, "purple"],
    [290, 320, "magenta"],
    [320, 345, "pink"],
    [345, 361, "red"],
  ];

  for (const [min, max, name] of hueRanges) {
    if (hue >= min && hue < max) {
      return name;
    }
  }
  return "unknown";
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

function parseColorInput(input: string): ParsedTheme {
  const lower = input.toLowerCase().trim();

  // Check for modifiers: "flux", "gradient", "ombre", "hombre"
  const hasFlux =
    lower.includes("flux") ||
    lower.includes("rainbow") ||
    lower.includes("animate");
  const hasGradient =
    lower.includes("gradient") ||
    lower.includes("ombre") ||
    lower.includes("hombre");

  // Extract color name by removing modifiers
  const colorPart = lower
    .replace(/\b(flux|rainbow|animate|gradient|ombre|hombre)\b/g, "")
    .trim();

  // Determine hue and saturation from color
  let hue = 120; // default green
  let saturation = 100;

  // Try named color
  if (colorPart && namedColors[colorPart] !== undefined) {
    const color = namedColors[colorPart];
    hue = color.hue;
    saturation = color.saturation ?? 100;
  }
  // Try hex color (#ff00ff or ff00ff)
  else if (colorPart.match(/^#?[0-9a-f]{6}$/i)) {
    const hex = colorPart.startsWith("#") ? colorPart : `#${colorPart}`;
    const { h, s } = hexToHsl(hex);
    hue = h;
    saturation = s;
  }
  // Try RGB format: rgb(255, 0, 128) or 255,0,128
  else if (colorPart.match(/^rgb\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i) ||
           colorPart.match(/^\d+\s*,\s*\d+\s*,\s*\d+$/)) {
    const nums = colorPart.match(/\d+/g);
    if (nums && nums.length >= 3) {
      const r = Math.min(255, parseInt(nums[0]!));
      const g = Math.min(255, parseInt(nums[1]!));
      const b = Math.min(255, parseInt(nums[2]!));
      const { h, s } = rgbToHsl(r, g, b);
      hue = h;
      saturation = s;
    }
  }
  // Try HSL format: hsl(180, 100%, 50%) or just a hue number
  else if (colorPart.match(/^hsl\s*\(\s*\d+/i)) {
    const nums = colorPart.match(/\d+/g);
    if (nums && nums.length >= 1) {
      hue = parseInt(nums[0]!) % 360;
      if (nums.length >= 2) {
        saturation = Math.min(100, parseInt(nums[1]!));
      }
    }
  }
  // Try plain number as hue
  else if (colorPart) {
    const num = parseInt(colorPart);
    if (!isNaN(num)) {
      hue = num % 360;
    }
  }
  // Standalone gradient defaults to cyan
  else if (hasGradient && !hasFlux) {
    hue = 180;
  }

  return { hue, saturation, animated: hasFlux, gradient: hasGradient };
}

export const themePack = createPack({
  name: "theme",
  description: "Visual theme control for the terminal interface",
  validator: themeStateValidator,
  tools: {
    setTheme: {
      name: "setTheme",
      description:
        "Change the terminal color theme. Supports many color formats: named colors (red, coral, teal, indigo, lavender, etc.), hex (#ff00ff), RGB (rgb(255,0,128)), HSL (hsl(180,100,50)), or raw hue (0-360). Add 'flux' for animated colors or 'gradient' for viewport-wide gradient.",
      inputSchema: z.object({
        color: z
          .string()
          .describe(
            "Color specification with optional modifiers. Named: red, orange, coral, gold, lime, green, emerald, teal, cyan, blue, indigo, purple, violet, magenta, pink, etc. Formats: '#ff00ff', 'rgb(255,0,128)', 'hsl(180,100,50)', or hue number. Modifiers: 'flux', 'gradient'. Examples: 'teal', 'coral gradient', '#ff6b6b flux', 'indigo'"
          ),
      }),
      execute: (input, ctx) => {
        const { hue, saturation, animated, gradient } = parseColorInput(
          input.color
        );
        ctx.updateState({ hue, saturation, animated, gradient });

        // Find the closest named color for the response
        const colorName = getColorName(hue, saturation);

        // Build response based on what changed
        const parts: string[] = [];
        parts.push(`color: ${colorName} (hue ${hue}°, sat ${saturation}%)`);
        if (animated) parts.push("flux mode enabled");
        if (gradient) parts.push("gradient overlay enabled");

        return `Theme updated: ${parts.join(", ")}`;
      },
    },
  },
  commands: {
    toggleThemeMode: {
      name: "toggleThemeMode",
      description: "Cycle through theme modes: static → gradient → flux → static",
      inputSchema: z.object({}),
      execute: (_input, ctx) => {
        const { animated, gradient } = ctx.state;

        if (!animated && !gradient) {
          // static → gradient
          ctx.updateState({ animated: false, gradient: true });
        } else if (!animated && gradient) {
          // gradient → flux
          ctx.updateState({ animated: true, gradient: true });
        } else {
          // flux → static
          ctx.updateState({ animated: false, gradient: false });
        }
      },
    },
  },
  initialState: { hue: 120, saturation: 100, animated: false, gradient: false },
});
