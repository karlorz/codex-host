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
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function identifierText(node) {
  return node && ts.isIdentifier(node) ? node.text : undefined;
}

function innermost(node) {
  let current = node;
  while (current) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      current = current.right;
      continue;
    }
    break;
  }
  return current;
}

function parseSourceFile(source) {
  return ts.createSourceFile(
    "candidate.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}

function webpackModulesObject(tree) {
  for (const node of nodesMatching(tree, ts.isVariableDeclaration)) {
    if (identifierText(node.name) === "__webpack_modules__" && node.initializer) {
      const initializer = innermost(node.initializer);
      if (ts.isObjectLiteralExpression(initializer)) return initializer;
    }
  }
  return undefined;
}

function factoryFunction(property) {
  if (ts.isMethodDeclaration(property) && property.body && property.parameters.length >= 2) {
    return property;
  }
  if (ts.isPropertyAssignment(property)) {
    const initializer = innermost(property.initializer);
    if (
      initializer &&
      (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) &&
      initializer.parameters.length >= 2 &&
      initializer.body
    ) {
      return initializer;
    }
  }
  return undefined;
}

function collectBlockEnv(block) {
  const env = new Map();
  if (!block || !ts.isBlock(block)) return env;
  for (const statement of block.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          env.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      env.set(statement.name.text, statement);
    }
  }
  return env;
}

function functionBody(node) {
  if (!node) return undefined;
  if (ts.isBlock(node)) return node;
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)) &&
    node.body
  ) {
    return ts.isBlock(node.body) ? node.body : node.body;
  }
  return undefined;
}

const SESSION_METHOD_ANCHORS = new Set(["dispatchVoiceCommand", "startVoiceWithIntroduction"]);

function isStaticNameIdentifier(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isPropertyAccessExpression(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  return false;
}

function functionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function collectBindingNames(nameNode, names = []) {
  if (!nameNode) return names;
  if (ts.isIdentifier(nameNode)) {
    names.push(nameNode.text);
    return names;
  }
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.elements) {
      if (ts.isBindingElement(element)) collectBindingNames(element.name, names);
    }
  }
  return names;
}

function addBinder(scope, name, counter) {
  if (!name || scope.has(name)) return;
  scope.set(name, `$${counter.next}`);
  counter.next += 1;
}

function isVarList(list) {
  return Boolean(
    list && (list.flags & ts.NodeFlags.Let) === 0 && (list.flags & ts.NodeFlags.Const) === 0,
  );
}

function hoistFunctionScoped(node, root, scope, counter) {
  if (!node) return;
  if (node === root) {
    ts.forEachChild(node, (child) => hoistFunctionScoped(child, root, scope, counter));
    return;
  }
  if (functionLike(node)) {
    if (ts.isFunctionDeclaration(node) && node.name) addBinder(scope, node.name.text, counter);
    return;
  }
  if (
    ts.isVariableDeclaration(node) &&
    node.parent &&
    ts.isVariableDeclarationList(node.parent) &&
    isVarList(node.parent)
  ) {
    for (const name of collectBindingNames(node.name)) addBinder(scope, name, counter);
  }
  ts.forEachChild(node, (child) => hoistFunctionScoped(child, root, scope, counter));
}

function createFunctionScope(fnNode, counter) {
  const scope = new Map();
  if ((ts.isFunctionDeclaration(fnNode) || ts.isFunctionExpression(fnNode)) && fnNode.name) {
    addBinder(scope, fnNode.name.text, counter);
  }
  if (ts.isClassDeclaration(fnNode) && fnNode.name) addBinder(scope, fnNode.name.text, counter);
  for (const param of fnNode.parameters ?? []) {
    for (const name of collectBindingNames(param.name)) addBinder(scope, name, counter);
  }
  hoistFunctionScoped(fnNode.body ?? fnNode, fnNode, scope, counter);
  return scope;
}

function createBlockScope(block, counter) {
  const scope = new Map();
  for (const statement of block.statements) {
    if (ts.isVariableStatement(statement) && !isVarList(statement.declarationList)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of collectBindingNames(declaration.name)) addBinder(scope, name, counter);
      }
    }
    if (ts.isClassDeclaration(statement) && statement.name)
      addBinder(scope, statement.name.text, counter);
  }
  return scope;
}

function createCatchScope(clause, counter) {
  const scope = new Map();
  if (clause.variableDeclaration) {
    for (const name of collectBindingNames(clause.variableDeclaration.name)) {
      addBinder(scope, name, counter);
    }
  }
  return scope;
}

function createForScope(node, counter) {
  const scope = new Map();
  const initializer = "initializer" in node ? node.initializer : undefined;
  if (initializer && ts.isVariableDeclarationList(initializer) && !isVarList(initializer)) {
    for (const declaration of initializer.declarations) {
      for (const name of collectBindingNames(declaration.name)) addBinder(scope, name, counter);
    }
  }
  return scope;
}

function lookupBinder(stack, name) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index].has(name)) return stack[index].get(name);
  }
  return undefined;
}

function serializeCanonical(node, stack, counter) {
  if (!node) return "";
  if (ts.isIdentifier(node)) {
    if (isStaticNameIdentifier(node)) return node.text;
    return lookupBinder(stack, node.text) ?? node.text;
  }
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return JSON.stringify(node.text);
  }
  if (ts.isBindingElement(node)) {
    const property = node.propertyName
      ? serializeCanonical(node.propertyName, stack, counter)
      : ts.isIdentifier(node.name)
        ? node.name.text
        : "";
    const local = serializeCanonical(node.name, stack, counter);
    const rest = [];
    if (node.dotDotDotToken) rest.push("...");
    if (node.initializer) rest.push(serializeCanonical(node.initializer, stack, counter));
    return `bind[${property},${local}${rest.length ? `,${rest.join(",")}` : ""}]`;
  }
  if (functionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    const next = [...stack, createFunctionScope(node, counter)];
    const children = [];
    ts.forEachChild(node, (child) => {
      children.push(serializeCanonical(child, next, counter));
    });
    return `${node.kind}[${children.join(",")}]`;
  }
  if (ts.isCatchClause(node)) {
    const next = [...stack, createCatchScope(node, counter)];
    const children = [];
    ts.forEachChild(node, (child) => {
      children.push(serializeCanonical(child, next, counter));
    });
    return `${node.kind}[${children.join(",")}]`;
  }
  if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const forScope = createForScope(node, counter);
    const next = forScope.size > 0 ? [...stack, forScope] : stack;
    const children = [];
    ts.forEachChild(node, (child) => {
      children.push(serializeCanonical(child, next, counter));
    });
    return `${node.kind}[${children.join(",")}]`;
  }
  if (ts.isBlock(node)) {
    const blockScope = createBlockScope(node, counter);
    const next = blockScope.size > 0 ? [...stack, blockScope] : stack;
    const children = [];
    ts.forEachChild(node, (child) => {
      children.push(serializeCanonical(child, next, counter));
    });
    return `${node.kind}[${children.join(",")}]`;
  }
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(serializeCanonical(child, stack, counter));
  });
  return `${node.kind}[${children.join(",")}]`;
}

function canonicalFactoryIdentity(fn) {
  return serializeCanonical(fn, [], { next: 0 });
}

function objectLiteralNames(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return [];
  const names = [];
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name) names.push(name);
  }
  return names;
}

function scopeConstructorBrand(node) {
  const call = innermost(node);
  if (!call || !ts.isCallExpression(call) || call.arguments.length === 0) return undefined;
  const callee = innermost(call.expression);
  const access = ts.isPropertyAccessExpression(callee)
    ? callee
    : ts.isPropertyAccessExpression(innermost(callee))
      ? innermost(callee)
      : undefined;
  if (!access || !ts.isPropertyAccessExpression(access) || access.name.text !== "z8") {
    return undefined;
  }
  const brand = call.arguments[0];
  return brand && ts.isStringLiteralLike(brand) ? brand.text : undefined;
}

function lookup(envStack, name) {
  for (let index = envStack.length - 1; index >= 0; index -= 1) {
    if (envStack[index].has(name)) return envStack[index].get(name);
  }
  return undefined;
}

function followOwnedValues(node, envStack, seen) {
  const current = innermost(node);
  if (!current || seen.has(current)) return [];
  seen.add(current);
  if (ts.isIdentifier(current)) {
    const bound = lookup(envStack, current.text);
    return bound ? followOwnedValues(bound, envStack, seen) : [];
  }
  if (ts.isObjectLiteralExpression(current)) {
    const values = [current];
    for (const property of current.properties) {
      if (ts.isSpreadAssignment(property)) {
        values.push(...followOwnedValues(property.expression, envStack, seen));
      }
    }
    return values;
  }
  if (
    ts.isFunctionDeclaration(current) ||
    ts.isFunctionExpression(current) ||
    ts.isArrowFunction(current) ||
    ts.isMethodDeclaration(current)
  ) {
    const body = current.body;
    const nextEnv = [...envStack];
    if (body && ts.isBlock(body)) nextEnv.push(collectBlockEnv(body));
    if (!body) return [];
    if (!ts.isBlock(body)) return followOwnedValues(body, nextEnv, seen);
    const values = [];
    for (const statement of nodesMatching(body, ts.isReturnStatement)) {
      if (statement.expression)
        values.push(...followOwnedValues(statement.expression, nextEnv, seen));
    }
    return values;
  }
  if (ts.isCallExpression(current)) {
    const values = [];
    const brand = scopeConstructorBrand(current);
    if (brand) values.push(current);
    const callee = innermost(current.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      values.push(...followOwnedValues(callee.expression, envStack, seen));
    }
    for (const argument of current.arguments) {
      if (ts.isFunctionExpression(argument) || ts.isArrowFunction(argument)) {
        values.push(...followOwnedValues(argument, envStack, seen));
      }
    }
    return values;
  }
  if (ts.isBinaryExpression(current)) {
    return [
      ...followOwnedValues(current.left, envStack, seen),
      ...followOwnedValues(current.right, envStack, seen),
    ];
  }
  if (ts.isConditionalExpression(current)) {
    return [
      ...followOwnedValues(current.whenTrue, envStack, seen),
      ...followOwnedValues(current.whenFalse, envStack, seen),
    ];
  }
  if (ts.isAwaitExpression(current) || ts.isAsExpression(current)) {
    return followOwnedValues(current.expression, envStack, seen);
  }
  return [];
}

function isRequireCallee(expression, requireParam) {
  const current = innermost(expression);
  return Boolean(requireParam && ts.isIdentifier(current) && current.text === requireParam);
}

function isExportsExpression(node, moduleParam, exportsParam) {
  const current = innermost(node);
  if (exportsParam && ts.isIdentifier(current) && current.text === exportsParam) return true;
  return Boolean(
    moduleParam &&
    ts.isPropertyAccessExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === moduleParam &&
    current.name.text === "exports",
  );
}

function webpackDefineBindings(body, moduleParam, exportsParam, requireParam) {
  const bindings = [];
  for (const node of nodesMatching(body, ts.isCallExpression)) {
    if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "d") {
      continue;
    }
    if (!isRequireCallee(node.expression.expression, requireParam)) continue;
    if (
      node.arguments.length < 2 ||
      !isExportsExpression(node.arguments[0], moduleParam, exportsParam)
    ) {
      continue;
    }
    for (const argument of node.arguments.slice(1)) {
      if (ts.isStringLiteralLike(argument) && node.arguments.length >= 3) {
        bindings.push({ name: argument.text, value: node.arguments[2] });
        continue;
      }
      if (!ts.isObjectLiteralExpression(argument)) continue;
      for (const property of argument.properties) {
        const name = propertyName(property.name);
        if (!name || ts.isSpreadAssignment(property)) continue;
        if (ts.isShorthandPropertyAssignment(property)) {
          bindings.push({ name, value: property.name });
        } else if (ts.isPropertyAssignment(property)) {
          bindings.push({ name, value: property.initializer });
        } else if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property)) {
          bindings.push({ name, value: property });
        }
      }
    }
  }
  return bindings;
}

function webpackRequireIds(body, requireParam) {
  const ids = [];
  for (const node of nodesMatching(body, ts.isCallExpression)) {
    if (!isRequireCallee(node.expression, requireParam) || node.arguments.length !== 1) continue;
    const argument = node.arguments[0];
    if (ts.isStringLiteralLike(argument)) ids.push(argument.text);
  }
  return ids;
}

function collectFileLevelRecord(tree, id, filePath, source) {
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

function interpretFactory(property, tree, filePath) {
  const moduleId = propertyName(property.name);
  const fn = factoryFunction(property);
  if (!moduleId || !fn) return undefined;
  const body = functionBody(fn);
  if (!body) return undefined;
  const moduleParam = identifierText(fn.parameters[0]?.name);
  const exportsParam = identifierText(fn.parameters[1]?.name);
  const requireParam = identifierText(fn.parameters[2]?.name);
  const factoryEnv = ts.isBlock(body) ? collectBlockEnv(body) : new Map();
  const envStack = [factoryEnv];
  const literals = [];
  const callees = [];
  const brands = [];

  for (const node of nodesMatching(body, ts.isStringLiteralLike)) {
    if (typeof node.text === "string" && node.text.length > 0 && node.text.length <= 128) {
      literals.push(node.text);
    }
  }
  for (const node of nodesMatching(body, ts.isCallExpression)) {
    if (isRequireCallee(node.expression, requireParam)) continue;
    if (ts.isIdentifier(node.expression)) callees.push(node.expression.text);
    if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
      callees.push(node.expression.name.text);
    }
  }
  for (const node of nodesMatching(body, ts.isPropertyAssignment)) {
    const name = propertyName(node.name);
    if (
      (name === "__scopeBrand" || name === "displayName" || name === "originator") &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      brands.push(node.initializer.text);
    }
  }

  const defineBindings = webpackDefineBindings(body, moduleParam, exportsParam, requireParam);
  const exported = defineBindings.map((binding) => binding.name);
  const imported = webpackRequireIds(body, requireParam);
  const initializer = defineBindings.find((binding) => binding.name === "initializeVoiceSession");
  if (initializer) {
    for (const value of followOwnedValues(initializer.value, envStack, new Set())) {
      for (const name of objectLiteralNames(value)) {
        if (SESSION_METHOD_ANCHORS.has(name)) exported.push(name);
      }
    }
  }
  for (const binding of defineBindings) {
    for (const value of followOwnedValues(binding.value, envStack, new Set())) {
      const brand = scopeConstructorBrand(value);
      if (brand) brands.push(brand);
      if (ts.isObjectLiteralExpression(value)) {
        for (const property of value.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
            continue;
          if (propertyName(property.name) !== "__scopeBrand") continue;
          const initializerValue = ts.isPropertyAssignment(property)
            ? property.initializer
            : undefined;
          if (initializerValue && ts.isStringLiteralLike(initializerValue)) {
            brands.push(initializerValue.text);
          }
        }
      }
    }
  }

  for (const node of nodesMatching(body, ts.isBinaryExpression)) {
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    if (
      ts.isPropertyAccessExpression(node.left) &&
      isExportsExpression(node.left.expression, moduleParam, exportsParam)
    ) {
      exported.push(node.left.name.text);
    }
  }

  return {
    id: moduleId,
    path: filePath,
    digest: fnv1aHex(canonicalFactoryIdentity(fn)),
    literals: unique(literals),
    callees: unique(callees),
    imports: unique(imported),
    exports: unique(exported),
    brands: unique(brands),
  };
}

export function interpretCandidateSources(source, id, filePath = id) {
  const tree = parseSourceFile(source);
  const modules = webpackModulesObject(tree);
  if (modules) {
    return modules.properties
      .map((property) => interpretFactory(property, tree, filePath))
      .filter(Boolean);
  }
  return [collectFileLevelRecord(tree, id, filePath, source)];
}

export function interpretCandidateSource(source, id, filePath = id) {
  const records = interpretCandidateSources(source, id, filePath);
  if (records.length === 1) return records[0];
  if (records.length === 0) {
    return collectFileLevelRecord(parseSourceFile(source), id, filePath, source);
  }
  return collectFileLevelRecord(parseSourceFile(source), id, filePath, source);
}

function sameStringSet(left = [], right = []) {
  return JSON.stringify(unique(left).sort()) === JSON.stringify(unique(right).sort());
}

const STRUCTURE_KEYS = ["literals", "callees", "imports", "exports", "brands"];

function reconcileAgainst(source, derived) {
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
    digest: source.digest ?? derived.digest,
    ...(typeof source.text === "string" ? { text: source.text } : {}),
    interpretationProvenance: "bytes-verified",
  };
}

export function reconcileSourceRecord(source) {
  const records = reconcileSourceRecords(source);
  if (records.length === 1) return records[0];
  if (records.length === 0) {
    return { ...source, interpretationProvenance: "snapshot-assertion" };
  }
  throw new Error(
    `source ${source.path || source.id || "unknown"} contains multiple webpack factories; specify a factory id`,
  );
}

export function reconcileSourceRecords(source) {
  if (typeof source.text !== "string") {
    return [
      {
        ...source,
        interpretationProvenance: source.interpretationProvenance ?? "snapshot-assertion",
      },
    ];
  }
  const derived = interpretCandidateSources(
    source.text,
    source.id ?? source.path,
    source.path ?? source.id,
  );
  if (derived.length === 0) {
    return [{ ...source, interpretationProvenance: "bytes-verified" }];
  }
  if (derived.length === 1) return [reconcileAgainst(source, derived[0])];
  if (source.id) {
    const match = derived.find((record) => record.id === source.id);
    if (match) return [reconcileAgainst(source, match)];
  }
  const supplied = STRUCTURE_KEYS.some((key) => source[key] !== undefined);
  if (supplied) {
    throw new Error(
      `source ${source.path || source.id || "unknown"} supplied structure for a multi-factory module; specify id of a factory`,
    );
  }
  return derived.map((record) => ({
    ...record,
    path: source.path ?? record.path,
    interpretationProvenance: "bytes-verified",
  }));
}

export function reconcileCandidateInventory(inventory) {
  return {
    ...inventory,
    sources: (inventory.sources ?? []).flatMap((source) => reconcileSourceRecords(source)),
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
  const discoveredModuleIds = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const records = interpretCandidateSources(text, path.basename(file), file);
    for (const record of records) {
      sources.push({
        ...record,
        interpretationProvenance: "bytes-verified",
      });
      if (record.id && record.id !== path.basename(file)) discoveredModuleIds.push(record.id);
    }
  }
  return {
    platform,
    desktopVersion,
    desktopBuild,
    bundleDigest,
    asarDigest,
    assets,
    moduleIds: unique([...moduleIds, ...discoveredModuleIds]),
    sources,
  };
}
