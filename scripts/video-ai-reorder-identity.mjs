import { gateScope, safeError, SafeAcceptanceGateError } from './video-ai-reorder-diagnostics.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, dirname, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
const ts = localRequire('typescript');
const exec = promisify(execFile);
export const EXPECTED_AI_TASKS_VERSION = 70;
export function sourceHash(text) { return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'); }
export function assertExpectedRemoteVersion(metadata) {
  assert.equal(metadata?.version, EXPECTED_AI_TASKS_VERSION, 'Remote version mismatch');
  return metadata.version;
}

function isRelativeModuleSpecifier(specifier) { return /^\.\.?([\\/]|$)/.test(specifier); }
function namedBindingsAreTypeOnly(clause) {
  return clause && ts.isNamedImports(clause) && clause.elements.length > 0 && clause.elements.every(item => item.isTypeOnly);
}
function namedExportsAreTypeOnly(clause) {
  return clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every(item => item.isTypeOnly);
}
export function runtimeRelativeImports(source, fileName = 'source.ts') {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(parsed.parseDiagnostics.length, 0, 'Invalid TypeScript source');
  const specifiers = [];
  const add = specifier => {
    if (isRelativeModuleSpecifier(specifier) && !specifiers.includes(specifier)) specifiers.push(specifier);
  };
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (!clause || (!clause.isTypeOnly && (clause.name || !namedBindingsAreTypeOnly(clause.namedBindings))))
        add(statement.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) &&
        !statement.isTypeOnly && !namedExportsAreTypeOnly(statement.exportClause))
      add(statement.moduleSpecifier.text);
  }
  const visitDynamicImports = node => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text);
    ts.forEachChild(node, visitDynamicImports);
  };
  visitDynamicImports(parsed);
  return specifiers;
}
export async function collectRuntimeSourcePaths(localRoot) {
  const root = resolve(localRoot);
  const paths = [];
  const seen = new Set();
  const visit = async path => {
    if (seen.has(path)) return;
    const fromRoot = relative(root, path);
    assert.ok(fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)),
      'Source outside functions tree');
    seen.add(path);
    paths.push(path);
    const source = await readFile(path, 'utf8');
    for (const specifier of runtimeRelativeImports(source, path)) await visit(resolve(dirname(path), specifier));
  };
  await visit(resolve(root, 'ai-tasks/index.ts'));
  return paths;
}
export async function compareSources(localRoot, remoteRoot) {
  const paths = await collectRuntimeSourcePaths(localRoot);
  let hashMismatches = 0;
  for (const path of paths) {
    const local = await readFile(path, 'utf8');
    const remote = await readFile(join(remoteRoot, relative(localRoot, path)), 'utf8').catch(() => null);
    if (remote === null || sourceHash(local) !== sourceHash(remote)) hashMismatches++;
  }
  return { fileCount: paths.length, hashMismatches };
}
export async function verifyRemoteIdentity(env, fetcher = fetch) {
  return gateScope('REMOTE_VERSION', async stage => {
    const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
    assert.match(ref, /^[a-z0-9]+$/);
    assert.ok(env.SUPABASE_ACCESS_TOKEN, 'Management access required for source identity');
    const response = await fetcher(`https://api.supabase.com/v1/projects/${ref}/functions/ai-tasks`, {
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.ok, true);
    const metadata = await response.json();
    assertExpectedRemoteVersion(metadata);
    stage('REMOTE_SOURCE_IDENTITY');
    const directory = await mkdtemp(join(tmpdir(), 'medclip-reorder-identity-'));
    let primary;
    try {
      const cli = localRequire.resolve('supabase/dist/supabase.js');
      await exec(process.execPath, [cli, 'functions', 'download', 'ai-tasks', '--project-ref', ref,
        '--use-api', '--workdir', directory], { env, windowsHide: true, timeout: 120_000 });
      return { version: metadata.version, ...await compareSources(join(process.cwd(), 'supabase/functions'),
        join(directory, 'supabase/functions')) };
    } catch(error) { primary=safeError(error,'REMOTE_SOURCE_IDENTITY'); throw primary; }
    finally {
      try { await rm(directory, { recursive: true, force: true }); }
      catch { if(primary) Object.defineProperty(primary,'cleanupFailed',{value:true, configurable:true}); else throw new SafeAcceptanceGateError('CLEANUP'); }
    }
  });
}
