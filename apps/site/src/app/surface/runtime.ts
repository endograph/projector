// The surface runtime: turns agent-authored TSX source into an importable
// module. Sucrase strips types and lowers JSX (classic pragma, aliased so the
// agent's own identifiers can't collide), then bare imports are rewritten to
// blob shim modules that re-export the HOST's React and design system — one
// React instance everywhere, identical in dev and build. No import maps: the
// app is a Vite bundle, so bare specifiers aren't resolvable at runtime.

import { transform } from "sucrase";
import * as ReactNamespace from "react";
import * as ds from "./ds";

export type CompiledSurface =
  | { ok: true; url: string }
  | { ok: false; error: string };

const REGISTRY_KEY = "__projectorSurfaceRuntime";

const registry: Record<string, Record<string, unknown>> = {
  react: ReactNamespace as unknown as Record<string, unknown>,
  "projector/ds": ds as unknown as Record<string, unknown>,
};

let shimUrlCache: Map<string, string> | null = null;

function shimUrls(): Map<string, string> {
  if (shimUrlCache) return shimUrlCache;
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = registry;
  shimUrlCache = new Map();
  for (const [specifier, mod] of Object.entries(registry)) {
    const names = Object.keys(mod).filter(
      (name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name),
    );
    const body = [
      `const m = globalThis[${JSON.stringify(REGISTRY_KEY)}][${JSON.stringify(specifier)}];`,
      `export default m.default ?? m;`,
      ...names.map((name) => `export const ${name} = m[${JSON.stringify(name)}];`),
    ].join("\n");
    shimUrlCache.set(
      specifier,
      URL.createObjectURL(new Blob([body], { type: "text/javascript" })),
    );
  }
  return shimUrlCache;
}

// Statement-position import/export-from specifiers. Anchored to statement
// boundaries rather than line starts: Sucrase prepends its inline helpers on
// the same line as the first import, so `}import {...} from "x"` is a real
// shape in transformed output.
const IMPORT_RE =
  /(^|[\n;})])(\s*(?:import|export)\s[^;\n]*?from\s*|\s*import\s*)(["'])([^"']+)\3/g;

function rewriteImports(code: string, shims: Map<string, string>): string {
  return code.replace(IMPORT_RE, (match, lead, head, quote, specifier) => {
    const shim = shims.get(specifier);
    if (!shim) {
      const allowed = [...shims.keys()].map((s) => `"${s}"`).join(", ");
      throw new Error(
        `Cannot import "${specifier}" — surfaces may only import ${allowed} (no other packages, no relative imports)`,
      );
    }
    return `${lead}${head}${quote}${shim}${quote}`;
  });
}

const compileCache = new Map<string, CompiledSurface>();

export function compileSurface(source: string): CompiledSurface {
  const cached = compileCache.get(source);
  if (cached) return cached;
  const compiled = compile(source);
  compileCache.set(source, compiled);
  return compiled;
}

function compile(source: string): CompiledSurface {
  let js: string;
  try {
    js = transform(source, {
      transforms: ["typescript", "jsx"],
      jsxPragma: "__projectorJsx",
      jsxFragmentPragma: "__projectorJsxFrag",
      production: true,
    }).code;
  } catch (error) {
    return { ok: false, error: `compile error: ${errorMessage(error)}` };
  }

  const shims = shimUrls();
  let rewritten: string;
  try {
    rewritten = rewriteImports(js, shims);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  const prelude = `import { createElement as __projectorJsx, Fragment as __projectorJsxFrag } from ${JSON.stringify(shims.get("react"))};\n`;
  const url = URL.createObjectURL(
    new Blob([prelude + rewritten], { type: "text/javascript" }),
  );
  return { ok: true, url };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
