// Independent static AST validation for Apps Script cutover maintenance freeze guard.
// Uses TypeScript compiler API to parse legacy-gas/src/backend/*.gs as JS AST.
// Validates declaration inventory, duplicate _formatDate across files, first statement guard,
// Cutover.gs helper isolation, API_HANDLERS mapping, and absence of unguarded declarations.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const BACKEND_DIR = new URL('../../legacy-gas/src/backend/', import.meta.url);
const GS_FILES = readdirSync(BACKEND_DIR).filter((f) => f.endsWith('.gs')).sort();
const SOURCES = Object.fromEntries(
  GS_FILES.map((f) => [f, readFileSync(new URL(f, BACKEND_DIR), 'utf8')]),
);

const GUARD = 'assertCutoverOpen_';
const CUTOVER_FILE = 'Cutover.gs';
const LEGACY_FILES = GS_FILES.filter((f) => f !== CUTOVER_FILE);

// Parse AST per file using TypeScript compiler API
const PARSED = Object.fromEntries(
  GS_FILES.map((file) => [
    file,
    ts.createSourceFile(file, SOURCES[file], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS),
  ]),
);

// Enumerate top-level FunctionDeclaration nodes by FILE (not deduplicated by name)
const DECLARATIONS_BY_FILE = GS_FILES.flatMap((file) => {
  const sf = PARSED[file];
  return sf.statements
    .filter(ts.isFunctionDeclaration)
    .map((node) => ({
      file,
      name: node.name ? node.name.text : null,
      node,
    }));
});

const GUARDED_DECLARATIONS = DECLARATIONS_BY_FILE.filter((d) => d.name !== GUARD);

test('AST inventory: exact 11 legacy files + 1 Cutover helper, 122 guarded declarations', () => {
  assert.equal(GS_FILES.length, 12, '12 .gs files in backend');
  assert.equal(LEGACY_FILES.length, 11, '11 legacy .gs files');
  assert.ok(GS_FILES.includes(CUTOVER_FILE), 'Cutover.gs present');
  assert.equal(DECLARATIONS_BY_FILE.length, 123, '123 total top-level function declarations');
  assert.equal(GUARDED_DECLARATIONS.length, 122, '122 declarations must be guarded');

  // Verify duplicate _formatDate across Pegawai.gs and Dokumen.gs
  const formatDates = GUARDED_DECLARATIONS.filter((d) => d.name === '_formatDate');
  assert.equal(formatDates.length, 2, '_formatDate declared in 2 files');
  assert.deepEqual(
    formatDates.map((d) => d.file).sort(),
    ['Dokumen.gs', 'Pegawai.gs'].sort(),
  );

  const uniqueGuardedNames = new Set(GUARDED_DECLARATIONS.map((d) => d.name));
  assert.equal(uniqueGuardedNames.size, 121, '121 unique guarded function names');
});

test('AST guard: every legacy function declaration calls assertCutoverOpen_() as first statement', () => {
  for (const { file, name, node } of GUARDED_DECLARATIONS) {
    assert.ok(name, `${file}: function declaration must be named`);
    assert.ok(node.body, `${file}:${name} function declaration must have a body`);
    assert.ok(node.body.statements.length > 0, `${file}:${name} function body must not be empty`);

    const first = node.body.statements[0];
    assert.ok(ts.isExpressionStatement(first), `${file}:${name} first statement must be expression`);
    assert.ok(ts.isCallExpression(first.expression), `${file}:${name} first expression must be a call`);
    assert.ok(
      ts.isIdentifier(first.expression.expression) && first.expression.expression.text === GUARD,
      `${file}:${name} first call must be ${GUARD}`,
    );
    assert.equal(first.expression.arguments.length, 0, `${file}:${name} ${GUARD} must be called with 0 args`);
  }
});

test('AST Cutover helper: private _, single function declaration, no public setter or property writes', () => {
  const cutoverDecls = DECLARATIONS_BY_FILE.filter((d) => d.file === CUTOVER_FILE);
  assert.equal(cutoverDecls.length, 1, 'Cutover.gs defines exactly 1 function');
  assert.equal(cutoverDecls[0].name, GUARD, `Cutover.gs defines ${GUARD}`);
  assert.ok(cutoverDecls[0].name.endsWith('_'), 'Cutover helper has private _ suffix');

  const sf = PARSED[CUTOVER_FILE];
  // Verify no other top-level statements in Cutover.gs
  const nonFns = sf.statements.filter((s) => !ts.isFunctionDeclaration(s));
  assert.equal(nonFns.length, 0, 'Cutover.gs contains no executable top-level statements or vars');

  // Verify helper body contains no property writes or public setters
  const src = SOURCES[CUTOVER_FILE];
  for (const forbidden of ['setProperty', 'setProperties', 'deleteProperty', 'deleteAllProperties']) {
    assert.ok(!src.includes(forbidden), `Cutover.gs must not write properties (${forbidden})`);
  }
});

test('AST API_HANDLERS capture: all 38 whitelist actions map to guarded functions', () => {
  const sf = PARSED['API.gs'];
  let handlersObj = null;

  function findHandlers(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'API_HANDLERS' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      handlersObj = node.initializer;
      return;
    }
    ts.forEachChild(node, findHandlers);
  }
  findHandlers(sf);

  assert.ok(handlersObj, 'API_HANDLERS object literal found in API.gs AST');
  const properties = handlersObj.properties.filter(ts.isPropertyAssignment);
  assert.equal(properties.length, 38, 'API_HANDLERS has exactly 38 properties');

  const guardedNames = new Set(GUARDED_DECLARATIONS.map((d) => d.name));
  for (const prop of properties) {
    const key = prop.name.text;
    assert.ok(ts.isIdentifier(prop.initializer), `${key}: handler initializer must be an identifier`);
    const val = prop.initializer.text;
    assert.equal(key, val, `${key} maps to same-named function`);
    assert.ok(guardedNames.has(val), `${val} in API_HANDLERS must be a guarded function`);
  }

  // Count non-API unique names
  const nonApiNames = [...guardedNames].filter((name) => !properties.some((p) => p.name.text === name));
  assert.equal(nonApiNames.length, 83, '121 unique guarded - 38 API_HANDLERS = 83 non-API functions');
});

test('AST anti-bypass: no unhandled top-level function expressions or arrow functions', () => {
  for (const file of GS_FILES) {
    const sf = PARSED[file];
    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (decl.initializer) {
            assert.ok(
              !ts.isFunctionExpression(decl.initializer) && !ts.isArrowFunction(decl.initializer),
              `${file}: top-level variable ${decl.name.text} must not be a function expression or arrow function`,
            );
          }
        }
      }
      assert.ok(!ts.isClassDeclaration(stmt), `${file}: no top-level class declarations`);
    }
  }
});
