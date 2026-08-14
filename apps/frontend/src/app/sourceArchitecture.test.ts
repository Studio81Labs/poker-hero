/// <reference types="node" />

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { parse as parseCss } from "postcss";
import parseCssValue from "postcss-value-parser";
import { globSync } from "tinyglobby";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(process.cwd(), "src");
const ALLOWED_LAYER_IMPORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  bootstrap: new Set(["app"]),
  app: new Set(["app", "pages", "shared"]),
  pages: new Set(["pages", "features", "shared"]),
  features: new Set(["features", "shared"]),
  shared: new Set(["shared"]),
};
const ALLOWED_FEATURE_AREAS = new Set(["components", "hooks", "lib"]);
const JAVASCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs"]);
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function sourceSegments(file: string): string[] {
  return relative(SOURCE_ROOT, file).split(sep);
}

function sourceLayer(sourcePath: readonly string[]): string | null {
  if (sourcePath.length === 1 && sourcePath[0] === "main.tsx") {
    return "bootstrap";
  }
  return Object.prototype.hasOwnProperty.call(
    ALLOWED_LAYER_IMPORTS,
    sourcePath[0],
  )
    ? sourcePath[0]
    : null;
}

function featureArea(sourcePath: readonly string[]): string | null {
  const area = sourcePath[2];
  return sourcePath[0] === "features" && ALLOWED_FEATURE_AREAS.has(area)
    ? area
    : null;
}

function featurePlacementViolation(
  sourcePath: readonly string[],
): string | null {
  const area = featureArea(sourcePath);
  if (!area) {
    return "feature source must live in components, hooks, or lib";
  }

  const extension = extname(sourcePath[sourcePath.length - 1] ?? "");
  if ((extension === ".tsx" || extension === ".css") && area !== "components") {
    return `feature ${extension.slice(1).toUpperCase()} source must live in components`;
  }
  return null;
}

function isTestSupportPath(sourcePath: readonly string[]): boolean {
  return (
    sourcePath[0] === "test" ||
    sourcePath.includes("__tests__") ||
    sourcePath.some(
      (segment) => segment.includes(".test.") || segment.endsWith(".test"),
    )
  );
}

function sourceFiles(): string[] {
  return filesBelow(SOURCE_ROOT).filter((file) => {
    return (
      SOURCE_EXTENSIONS.has(extname(file)) &&
      !isTestSupportPath(sourceSegments(file))
    );
  });
}

function stylesheetImports(source: string, file: string): string[] {
  const imports: string[] = [];
  parseCss(source, { from: file }).walkAtRules("import", (rule) => {
    const firstValue = parseCssValue(rule.params).nodes.find(
      (node) => node.type !== "space" && node.type !== "comment",
    );
    if (!firstValue) return;

    if (firstValue.type === "string") {
      imports.push(firstValue.value);
      return;
    }
    if (
      firstValue.type !== "function" ||
      firstValue.value.toLowerCase() !== "url"
    ) {
      return;
    }

    const urlValue = firstValue.nodes.find(
      (node) => node.type !== "space" && node.type !== "comment",
    );
    if (urlValue?.type === "string" || urlValue?.type === "word") {
      imports.push(urlValue.value);
    }
  });
  return imports;
}

function sourceImportTarget(file: string, specifier: string): string | null {
  const suffixIndex = specifier.search(/[?#]/);
  const pathSpecifier =
    suffixIndex === -1 ? specifier : specifier.slice(0, suffixIndex);
  if (pathSpecifier.startsWith(".")) {
    return resolve(dirname(file), pathSpecifier);
  }
  if (pathSpecifier.startsWith("/src/")) {
    return resolve(SOURCE_ROOT, pathSpecifier.slice("/src/".length));
  }
  return null;
}

function viteGlobPatternGroups(source: string, file: string): string[][] {
  const groups: string[][] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );

  function staticPattern(node: ts.Expression): string | null {
    return ts.isStringLiteralLike(node) ? node.text : null;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isMetaProperty(node.expression.expression) &&
      node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.expression.expression.name.text === "meta" &&
      (node.expression.name.text === "glob" ||
        node.expression.name.text === "globEager")
    ) {
      const argument = node.arguments[0];
      if (argument) {
        const patterns = ts.isArrayLiteralExpression(argument)
          ? argument.elements.flatMap((element) => {
              const pattern = ts.isExpression(element)
                ? staticPattern(element)
                : null;
              return pattern === null ? [] : [pattern];
            })
          : [staticPattern(argument)].filter(
              (pattern): pattern is string => pattern !== null,
            );
        if (patterns.length > 0) groups.push(patterns);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return groups;
}

function viteStaticUrlSpecifiers(source: string, file: string): string[] {
  const specifiers: string[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );

  function visit(node: ts.Node): void {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length === 2 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      ts.isPropertyAccessExpression(node.arguments[1]) &&
      ts.isMetaProperty(node.arguments[1].expression) &&
      node.arguments[1].expression.keywordToken ===
        ts.SyntaxKind.ImportKeyword &&
      node.arguments[1].expression.name.text === "meta" &&
      node.arguments[1].name.text === "url"
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function scriptImports(source: string, file: string): string[] {
  const preprocessed = ts.preProcessFile(source, true, true);
  return preprocessed.importedFiles
    .concat(preprocessed.referencedFiles)
    .map((importedFile) => importedFile.fileName)
    .concat(viteStaticUrlSpecifiers(source, file));
}

function viteGlobImports(
  file: string,
  source: string,
): Array<{ specifier: string; target: string }> {
  const sourceRootFromImporter =
    relative(dirname(file), SOURCE_ROOT).split(sep).join("/") || ".";

  return viteGlobPatternGroups(source, file).flatMap((patterns) => {
    const resolvedPatterns = patterns.map((pattern) => {
      const negated = pattern.startsWith("!");
      const value = negated ? pattern.slice(1) : pattern;
      const resolved = value.startsWith("/src/")
        ? `${sourceRootFromImporter}/${value.slice("/src/".length)}`
        : value;
      return negated ? `!${resolved}` : resolved;
    });
    const specifier = `import.meta.glob(${JSON.stringify(patterns)})`;
    return globSync(resolvedPatterns, {
      absolute: true,
      cwd: dirname(file),
      onlyFiles: true,
    }).map((target) => ({ specifier, target }));
  });
}

function sourceImports(
  file: string,
): Array<{ specifier: string; target: string }> {
  const source = readFileSync(file, "utf8");
  const imports =
    extname(file) === ".css"
      ? stylesheetImports(source, file)
      : scriptImports(source, file);
  return imports
    .flatMap((specifier) => {
      const target = sourceImportTarget(file, specifier);
      return target ? [{ specifier, target }] : [];
    })
    .concat(viteGlobImports(file, source));
}

function layerViolations(): string[] {
  const violations: string[] = [];

  for (const file of sourceFiles()) {
    const sourcePath = sourceSegments(file);
    if (JAVASCRIPT_EXTENSIONS.has(extname(file))) {
      violations.push(
        `production source must use TypeScript instead of JavaScript: ${sourcePath.join("/")}`,
      );
      continue;
    }
    const currentSourceLayer = sourceLayer(sourcePath);
    if (!currentSourceLayer) {
      violations.push(
        `production source must live in app, pages, features, or shared: ${sourcePath.join("/")}`,
      );
      continue;
    }
    const featurePlacementError =
      currentSourceLayer === "features"
        ? featurePlacementViolation(sourcePath)
        : null;
    if (featurePlacementError) {
      violations.push(`${featurePlacementError}: ${sourcePath.join("/")}`);
      continue;
    }

    for (const { specifier, target } of sourceImports(file)) {
      const targetPath = sourceSegments(target);
      const targetLayer = sourceLayer(targetPath) ?? targetPath[0];
      const importDescription = `${sourcePath.join("/")} -> ${specifier}`;

      if (isTestSupportPath(targetPath)) {
        violations.push(
          `production source may not depend on test support: ${importDescription}`,
        );
        continue;
      }

      const allowedTargets = ALLOWED_LAYER_IMPORTS[currentSourceLayer];
      if (!allowedTargets.has(targetLayer)) {
        violations.push(
          `${currentSourceLayer} may not depend on ${targetLayer}: ${importDescription}`,
        );
        continue;
      }

      if (currentSourceLayer !== "features" || targetLayer !== "features") {
        continue;
      }

      const sourceKind = sourcePath[2];
      const targetKind = targetPath[2];
      if (
        sourceKind === "lib" &&
        (targetKind === "components" || targetKind === "hooks")
      ) {
        violations.push(
          `feature lib may not depend on ${targetKind}: ${importDescription}`,
        );
      }
      if (sourceKind === "hooks" && targetKind === "components") {
        violations.push(
          `feature hooks may not depend on components: ${importDescription}`,
        );
      }
    }
  }

  return violations;
}

function componentsMissingTests(): string[] {
  return sourceFiles()
    .filter((file) => sourceSegments(file).includes("components"))
    .filter((file) => extname(file) === ".tsx")
    .filter((file) => !existsSync(file.replace(/\.tsx$/, ".test.tsx")))
    .map((file) => sourceSegments(file).join("/"));
}

describe("frontend source architecture", () => {
  it("recognizes only declared layers and the bootstrap entry point", () => {
    expect(sourceLayer(["main.tsx"])).toBe("bootstrap");
    expect(
      sourceLayer(["features", "capture", "lib", "captureSource.ts"]),
    ).toBe("features");
    expect(sourceLayer(["utils", "format.ts"])).toBeNull();
  });

  it("recognizes only declared production areas inside features", () => {
    expect(
      featureArea(["features", "capture", "lib", "captureSource.ts"]),
    ).toBe("lib");
    expect(featureArea(["features", "capture", "index.ts"])).toBeNull();
    expect(
      featureArea(["features", "capture", "utils", "format.ts"]),
    ).toBeNull();
  });

  it("includes Vite JavaScript modules in the TypeScript-only source audit", () => {
    for (const extension of [".cjs", ".js", ".jsx", ".mjs"]) {
      expect(SOURCE_EXTENSIONS.has(extension)).toBe(true);
      expect(JAVASCRIPT_EXTENSIONS.has(extension)).toBe(true);
    }
    for (const extension of [".cts", ".mts"]) {
      expect(SOURCE_EXTENSIONS.has(extension)).toBe(true);
      expect(JAVASCRIPT_EXTENSIONS.has(extension)).toBe(false);
    }
  });

  it("keeps feature UI source in component areas", () => {
    expect(
      featurePlacementViolation([
        "features",
        "capture",
        "components",
        "InputSourcePanel.tsx",
      ]),
    ).toBeNull();
    expect(
      featurePlacementViolation([
        "features",
        "capture",
        "lib",
        "CaptureWidget.tsx",
      ]),
    ).toContain("TSX");
    expect(
      featurePlacementViolation([
        "features",
        "capture",
        "hooks",
        "captureWidget.css",
      ]),
    ).toContain("CSS");
  });

  it("recognizes test support wherever it is stored", () => {
    expect(
      isTestSupportPath([
        "features",
        "capture",
        "lib",
        "captureSource.test.ts",
      ]),
    ).toBe(true);
    expect(isTestSupportPath(["pages", "analyzer", "__tests__"])).toBe(true);
    expect(isTestSupportPath(["test", "analyzerHarness.tsx"])).toBe(true);
    expect(
      isTestSupportPath(["features", "capture", "lib", "captureSource.test"]),
    ).toBe(true);
    expect(
      isTestSupportPath(["features", "capture", "lib", "captureSource.ts"]),
    ).toBe(false);
  });

  it("parses source stylesheet imports without treating URLs as source edges", () => {
    expect(
      stylesheetImports(
        '@import "../../../pages/analyzer/AnalyzerPage.css";\n@import url("./local.css");\n@import "/src/shared/styles/base.css";\n@import url("https://example.com/font.css");',
        "fixture.css",
      ).filter(
        (specifier) => sourceImportTarget("fixture.css", specifier) !== null,
      ),
    ).toEqual([
      "../../../pages/analyzer/AnalyzerPage.css",
      "./local.css",
      "/src/shared/styles/base.css",
    ]);
  });

  it("resolves relative and Vite root-relative source imports", () => {
    const importer = resolve(SOURCE_ROOT, "shared/styles/base.css");
    expect(sourceImportTarget(importer, "./tokens.css")).toBe(
      resolve(SOURCE_ROOT, "shared/styles/tokens.css"),
    );
    expect(
      sourceImportTarget(importer, "/src/pages/analyzer/AnalyzerPage.css"),
    ).toBe(resolve(SOURCE_ROOT, "pages/analyzer/AnalyzerPage.css"));
    expect(
      sourceImportTarget(importer, "https://example.com/font.css"),
    ).toBeNull();
  });

  it("removes Vite query and hash suffixes before classifying imports", () => {
    const importer = resolve(SOURCE_ROOT, "features/capture/lib/consumer.ts");
    for (const specifier of [
      "./captureSource.test?raw",
      "./captureSource.test#fixture",
    ]) {
      const target = sourceImportTarget(importer, specifier);
      expect(target).not.toBeNull();
      expect(isTestSupportPath(sourceSegments(target!))).toBe(true);
    }
    expect(
      sourceImportTarget(importer, "/src/shared/styles/base.css?inline"),
    ).toBe(resolve(SOURCE_ROOT, "shared/styles/base.css"));
  });

  it("extracts static Vite glob patterns", () => {
    expect(
      viteGlobPatternGroups(
        'const pages = import.meta.glob(["../../pages/**/*.tsx", "!../../pages/**/*.test.tsx"]);\nconst styles = import.meta.globEager(`/src/shared/**/*.css`);',
        "fixture.ts",
      ),
    ).toEqual([
      ["../../pages/**/*.tsx", "!../../pages/**/*.test.tsx"],
      ["/src/shared/**/*.css"],
    ]);
  });

  it("extracts Vite static URL dependencies", () => {
    expect(
      viteStaticUrlSpecifiers(
        'const worker = new Worker(new URL("../../pages/worker.ts", import.meta.url));\nconst external = new URL(value, baseUrl);',
        "fixture.ts",
      ),
    ).toEqual(["../../pages/worker.ts"]);
  });

  it("includes triple-slash path references as source imports", () => {
    expect(
      scriptImports(
        '/// <reference path="../../pages/analyzer/types.d.ts" />',
        "fixture.ts",
      ),
    ).toContain("../../pages/analyzer/types.d.ts");
  });

  it("expands Vite glob imports into auditable source targets", () => {
    const importer = resolve(SOURCE_ROOT, "shared/lib/registry.ts");
    const imports = viteGlobImports(
      importer,
      'const pages = import.meta.glob(["../../pages/**/*.tsx", "!../../pages/**/__tests__/**"]);',
    );
    expect(
      imports.some((entry) =>
        entry.target.endsWith("/pages/analyzer/AnalyzerPage.tsx"),
      ),
    ).toBe(true);
    expect(imports.some((entry) => entry.target.includes("/__tests__/"))).toBe(
      false,
    );
  });

  it("keeps imports within the documented layer direction", () => {
    expect(layerViolations()).toEqual([]);
  });

  it("keeps tests colocated with production components", () => {
    expect(componentsMissingTests()).toEqual([]);
  });
});
