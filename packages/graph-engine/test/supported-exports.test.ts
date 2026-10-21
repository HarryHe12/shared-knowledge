import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

import * as graphEngine from "../src";

interface SupportedExportsBaseline {
  workbenchServer: string[];
  offlineHost: string[];
  supportedPublicCompatibility: string[];
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BASELINE_PATH = path.join(import.meta.dirname, "fixtures/issue-159/supported-exports.json");
const RETIRED_PUBLIC_EXPORTS = [
  "applyFocusMode",
  "appendQueueNote",
  "atlasPointToMinimap",
  "atlasViewportRect",
  "atlasViewportToMinimapRect",
  "centerAtlasViewportOnPoint",
  "clampAtlasViewport",
  "createSafeStorage",
  "defaultLearning",
  "defaultQueue",
  "fitAtlasViewport",
  "filterLinksByTypes",
  "getAtlasModelBounds",
  "getCommunityNodeIds",
  "getVisibleLinks",
  "getVisibleNodeIds",
  "getWikiStorageNamespace",
  "minimapPointToAtlasPoint",
  "normalizeAtlasViewport",
  "normalizeLearning",
  "normalizeQueue",
  "resolveAtlasVisibleSnapshot",
  "resolveInitialMode",
  "resolveVisibleSnapshot",
  "shouldAutoOpenDrawer",
  "summarizeQueue",
  "toggleQueueFavorite",
  "zoomAtlasViewport"
] as const;

describe("issue #159 supported graph-engine exports", () => {
  it("records the exact exports imported by the legacy backend", async () => {
    const baseline = await readBaseline();

    assert.deepEqual(await packageImports(path.join(REPO_ROOT, "workbench/server/src")), baseline.workbenchServer);
  });

  it("records the exact graph-engine globals used by the offline host", async () => {
    const baseline = await readBaseline();
    const source = await readFile(path.join(REPO_ROOT, "scripts/build-graph-html.sh"), "utf8");
    const used = [...source.matchAll(/window\.LlmWikiGraphEngine\.([A-Za-z0-9_]+)/g)]
      .map((match) => match[1])
      .filter((name, index, names) => names.indexOf(name) === index)
      .sort();

    assert.deepEqual(used, baseline.offlineHost);
  });

  it("keeps the supported runtime compatibility exports present", async () => {
    const baseline = await readBaseline();
    for (const name of baseline.supportedPublicCompatibility) {
      assert.equal(typeof (graphEngine as Record<string, unknown>)[name], "function", `${name} must remain exported`);
    }
    assert.equal(graphEngine.createGraphRenderer, graphEngine.createStaticGraphRenderer);
  });

  it("does not expose the retired graph toolbox from the package entry", () => {
    for (const name of RETIRED_PUBLIC_EXPORTS) {
      assert.equal(name in graphEngine, false, `${name} must not remain exported`);
    }
  });

  it("records namespace imports independently", async () => {
    assert.deepEqual(await fixturePackageImports("consumer.mts", [
      'import * as graphEngine from "@llm-wiki/graph-engine";',
      "void graphEngine;"
    ].join("\n")), ["*"]);
  });

  it("records named package re-exports independently", async () => {
    assert.deepEqual(
      await fixturePackageImports("named-re-export.mts", 'export { createGraphEngine as engine } from "@llm-wiki/graph-engine";\n'),
      ["createGraphEngine"]
    );
  });

  it("records star package re-exports independently", async () => {
    assert.deepEqual(
      await fixturePackageImports("star-re-export.mts", 'export * from "@llm-wiki/graph-engine";\n'),
      ["*"]
    );
  });

  it("records dynamic imports and import-type export use", async () => {
    assert.deepEqual(await fixturePackageImports("lazy-consumer.cts", [
      'type Data = import("@llm-wiki/graph-engine").GraphData;',
      'const modulePromise = import("@llm-wiki/graph-engine");',
      "void (null as unknown as Data);",
      "void modulePromise;"
    ].join("\n")), ["*", "GraphData"]);
  });
});

async function readBaseline(): Promise<SupportedExportsBaseline> {
  return JSON.parse(await readFile(BASELINE_PATH, "utf8")) as SupportedExportsBaseline;
}

async function packageImports(root: string): Promise<string[]> {
  const names = new Set<string>();
  for (const file of await sourceFiles(root)) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && isGraphEngineSpecifier(statement.moduleSpecifier)) {
        const clause = statement.importClause;
        if (clause?.name) names.add("default");
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.add("*");
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) names.add((element.propertyName ?? element.name).text);
        }
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && isGraphEngineSpecifier(statement.moduleSpecifier)) {
        const clause = statement.exportClause;
        if (!clause || ts.isNamespaceExport(clause)) names.add("*");
        else for (const element of clause.elements) names.add((element.propertyName ?? element.name).text);
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isImportTypeNode(node) && isGraphEngineImportType(node)) {
        names.add(node.qualifier ? rootExportName(node.qualifier) : "*");
      } else if (
        ts.isCallExpression(node)
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        && node.arguments.length === 1
        && isGraphEngineSpecifier(node.arguments[0])
      ) {
        names.add("*");
      } else if (
        ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression
        && isGraphEngineSpecifier(node.moduleReference.expression)
      ) {
        names.add("*");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...names].sort();
}

function isGraphEngineSpecifier(node: ts.Expression): node is ts.StringLiteral {
  return ts.isStringLiteral(node) && node.text === "@llm-wiki/graph-engine";
}

function isGraphEngineImportType(node: ts.ImportTypeNode): boolean {
  return ts.isLiteralTypeNode(node.argument)
    && ts.isStringLiteral(node.argument.literal)
    && node.argument.literal.text === "@llm-wiki/graph-engine";
}

function rootExportName(name: ts.EntityName): string {
  let current = name;
  while (ts.isQualifiedName(current)) current = current.left;
  return current.text;
}

async function fixturePackageImports(filename: string, source: string): Promise<string[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-supported-exports-"));
  try {
    await writeFile(path.join(root, filename), source);
    return await packageImports(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) files.push(absolute);
    }
  };
  await visit(root);
  return files.sort();
}
