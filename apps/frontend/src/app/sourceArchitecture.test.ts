/// <reference types="node" />

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(process.cwd(), "src");
const ALLOWED_LAYER_IMPORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  app: new Set(["app", "pages", "shared"]),
  pages: new Set(["pages", "features", "shared"]),
  features: new Set(["features", "shared"]),
  shared: new Set(["shared"]),
};

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function sourceSegments(file: string): string[] {
  return relative(SOURCE_ROOT, file).split(sep);
}

function sourceFiles(): string[] {
  return filesBelow(SOURCE_ROOT).filter((file) => {
    const extension = extname(file);
    return (
      (extension === ".ts" || extension === ".tsx") &&
      !file.includes(".test.") &&
      !file.includes(`${sep}__tests__${sep}`) &&
      sourceSegments(file)[0] !== "test"
    );
  });
}

function relativeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map((importedFile) => importedFile.fileName)
    .filter((specifier) => specifier.startsWith("."));
}

function layerViolations(): string[] {
  const violations: string[] = [];

  for (const file of sourceFiles()) {
    const sourcePath = sourceSegments(file);
    const sourceLayer = sourcePath[0];

    for (const specifier of relativeImports(file)) {
      const targetPath = sourceSegments(resolve(dirname(file), specifier));
      const targetLayer = targetPath[0];
      const importDescription = `${sourcePath.join("/")} -> ${specifier}`;

      const allowedTargets = ALLOWED_LAYER_IMPORTS[sourceLayer];
      if (allowedTargets && !allowedTargets.has(targetLayer)) {
        violations.push(
          `${sourceLayer} may not depend on ${targetLayer}: ${importDescription}`,
        );
        continue;
      }

      if (sourceLayer !== "features" || targetLayer !== "features") continue;

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
  it("keeps imports within the documented layer direction", () => {
    expect(layerViolations()).toEqual([]);
  });

  it("keeps tests colocated with production components", () => {
    expect(componentsMissingTests()).toEqual([]);
  });
});
