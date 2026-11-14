import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

function nodesMatching(node, predicate) {
  const matches = [];
  const visit = (child) => {
    if (predicate(child)) matches.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return matches;
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function fnv1aHex(value) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

export function interpretCandidateSource(source, id, filePath = id) {
  const tree = ts.createSourceFile(
    "candidate.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const literals = [];
  const callees = [];
  const exported = [];
  const imported = [];
  const brands = [];

  for (const node of nodesMatching(tree, ts.isStringLiteralLike)) {
    if (typeof node.text === "string" && node.text.length > 0 && node.text.length <= 128) {
      literals.push(node.text);
    }
  }
  for (const node of nodesMatching(tree, ts.isCallExpression)) {
    if (ts.isIdentifier(node.expression)) callees.push(node.expression.text);
    if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
      callees.push(node.expression.name.text);
    }
  }
  for (const node of nodesMatching(tree, ts.isExportDeclaration)) {
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) exported.push(element.name.text);
    }
  }
  for (const node of nodesMatching(tree, ts.isFunctionDeclaration)) {
    if (hasExportModifier(node) && node.name) exported.push(node.name.text);
  }
  for (const node of nodesMatching(tree, ts.isVariableStatement)) {
    if (!hasExportModifier(node)) continue;
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) exported.push(declaration.name.text);
    }
  }
  for (const node of nodesMatching(tree, ts.isBinaryExpression)) {
    if (
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === "exports"
    ) {
      exported.push(node.left.name.text);
    }
  }
  for (const node of nodesMatching(tree, ts.isImportDeclaration)) {
    if (node.importClause?.name) imported.push(node.importClause.name.text);
    const named = node.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) imported.push(element.name.text);
    }
    if (named && ts.isNamespaceImport(named)) imported.push(named.name.text);
  }
  for (const node of nodesMatching(tree, ts.isPropertyAssignment)) {
    const name = propertyName(node.name);
    if (
      (name === "__scopeBrand" || name === "displayName" || name === "originator") &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      brands.push(node.initializer.text);
    }
  }
  for (const node of nodesMatching(tree, ts.isBinaryExpression)) {
    if (
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isStringLiteralLike(node.right)
    ) {
      const name = node.left.name.text;
      if (name === "__scopeBrand" || name === "displayName" || name === "originator") {
        brands.push(node.right.text);
      }
    }
  }

  return {
    id,
    path: filePath,
    digest: fnv1aHex(source),
    literals: unique(literals),
    callees: unique(callees),
    imports: unique(imported),
    exports: unique(exported),
    brands: unique(brands),
  };
}

function sameStringSet(left = [], right = []) {
  return JSON.stringify(unique(left).sort()) === JSON.stringify(unique(right).sort());
}

const STRUCTURE_KEYS = ["literals", "callees", "imports", "exports", "brands"];

export function reconcileSourceRecord(source) {
  if (typeof source.text !== "string") {
    return { ...source, interpretationProvenance: "snapshot-assertion" };
  }
  const derived = interpretCandidateSource(source.text, source.id ?? source.path, source.path);
  for (const key of STRUCTURE_KEYS) {
    if (source[key] !== undefined && !sameStringSet(source[key], derived[key])) {
      throw new Error(
        `source ${source.path || source.id || "unknown"} supplied ${key} contradicts bytes-derived interpretation`,
      );
    }
  }
  return {
    ...derived,
    id: source.id ?? derived.id,
    path: source.path ?? derived.path,
    digest: source.digest,
    text: source.text,
    interpretationProvenance: "bytes-verified",
  };
}

export function reconcileCandidateInventory(inventory) {
  return {
    ...inventory,
    sources: (inventory.sources ?? []).map((source) => reconcileSourceRecord(source)),
  };
}

export async function readCandidateInventory({
  assets = [],
  files = [],
  platform,
  desktopVersion,
  desktopBuild,
  bundleDigest,
  asarDigest,
  moduleIds = [],
}) {
  const sources = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    sources.push({
      ...interpretCandidateSource(text, path.basename(file), file),
      text,
      interpretationProvenance: "bytes-verified",
    });
  }
  return {
    platform,
    desktopVersion,
    desktopBuild,
    bundleDigest,
    asarDigest,
    assets,
    moduleIds,
    sources,
  };
}
