#!/usr/bin/env node
/** STRUCTURAL WINDOW-SURFACE ENUMERATION over a TS/TSX source file.
 *
 * PR #76's sensorium guard scanned assignment *shapes* with regexes;
 * production's ScoutAgent assigns through a computed key —
 *   const key = primary ? "__scout" : "__scoutPeer";
 *   w[key] = api;
 * — which no literal shape can see. This enumerator parses the real
 * AST (TypeScript compiler) and RESOLVES element-access keys through
 * their bindings: literals, conditionals, and identifier chains.
 * What it reports is what the code will actually put on the window.
 *
 * Usage: node enumerate_tsx.js <file.tsx>   -> JSON on stdout
 */
const ts = require("/home/hatch/tmp-pip/aiverse-experiments/apps/console/node_modules/typescript");
const fs = require("fs");

const file = process.argv[2];
const src = fs.readFileSync(file, "utf8");
const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
                               file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

// --- collect variable bindings (name -> initializer node) ----------
const bindings = new Map();
(function collect(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    bindings.set(node.name.text, node.initializer);
  }
  ts.forEachChild(node, collect);
})(sf);

// --- window aliases: identifiers bound to a cast of `window` -------
const aliases = new Set(["window", "globalThis"]);
for (const [name, init] of bindings) {
  let n = init;
  while (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) ||
         ts.isParenthesizedExpression(n)) n = n.expression;
  if (ts.isIdentifier(n) && n.text === "window") aliases.add(name);
}

const isAlias = (n) => ts.isIdentifier(n) && aliases.has(n.text);

// --- resolve an expression to the set of string literals it can be -
function resolveStrings(node, depth = 0) {
  if (!node || depth > 8) return new Set();
  if (ts.isStringLiteral(node)) return new Set([node.text]);
  if (ts.isParenthesizedExpression(node)) return resolveStrings(node.expression, depth + 1);
  if (ts.isConditionalExpression(node)) {
    const out = resolveStrings(node.whenTrue, depth + 1);
    for (const s of resolveStrings(node.whenFalse, depth + 1)) out.add(s);
    return out;
  }
  if (ts.isIdentifier(node) && bindings.has(node.text)) {
    return resolveStrings(bindings.get(node.text), depth + 1);
  }
  return new Set();
}

// --- walk: window assignments, api objects, action types, fetch ----
const globals = [];       // {name, via, line}
const assignedVars = new Set(); // identifiers assigned onto the window
const fetchCalls = [];    // {arg, line}
const actionTypes = new Set();

(function walk(node) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const L = node.left;
    if (ts.isPropertyAccessExpression(L) && isAlias(L.expression)) {
      globals.push({ name: L.name.text, via: "property-access", line: lineOf(node) });
      if (ts.isIdentifier(node.right)) assignedVars.add(node.right.text);
    } else if (ts.isElementAccessExpression(L) && isAlias(L.expression)) {
      for (const s of resolveStrings(L.argumentExpression)) {
        globals.push({ name: s, via: "element-access(resolved)", line: lineOf(node) });
      }
      if (ts.isIdentifier(node.right)) assignedVars.add(node.right.text);
    }
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "fetch") {
    const a = node.arguments[0];
    fetchCalls.push({
      arg: a && ts.isStringLiteral(a) ? a.text : "<dynamic>",
      line: lineOf(node),
    });
  }
  if (ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
       node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)) {
    for (const [side, other] of [[node.left, node.right], [node.right, node.left]]) {
      if (ts.isPropertyAccessExpression(side) && side.name.text === "type" &&
          ts.isIdentifier(side.expression) && side.expression.text === "action" &&
          ts.isStringLiteral(other)) {
        actionTypes.add(other.text);
      }
    }
  }
  ts.forEachChild(node, walk);
})(sf);

// --- api object literals: methods of whatever was put on the window -
const apis = {};
for (const v of assignedVars) {
  const init = bindings.get(v);
  if (init && ts.isObjectLiteralExpression(init)) {
    apis[v] = init.properties.map((p) => p.name && p.name.text).filter(Boolean);
  }
}

console.log(JSON.stringify({
  file,
  globals,
  apis,
  action_types: [...actionTypes].sort(),
  fetch_calls: fetchCalls,
}, null, 1));
