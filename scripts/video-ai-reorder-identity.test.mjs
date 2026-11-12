import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  EXPECTED_AI_TASKS_VERSION,
  assertExpectedRemoteVersion,
  collectRuntimeSourcePaths,
  compareSources,
  runtimeRelativeImports,
} from './video-ai-reorder-identity.mjs';

const functionsRoot = resolve('supabase/functions');
const missingTypeOnlyBranch = [
  '_shared/ai-credentials/service.ts',
  '_shared/ai-credentials/request.ts',
  '_shared/ai-tasks/database.ts',
];

test('remote version identity rejects prior pins and accepts only observed version 70', () => {
  assert.equal(EXPECTED_AI_TASKS_VERSION, 70);
  assert.throws(() => assertExpectedRemoteVersion({ version: 68 }), /Remote version mismatch/);
  assert.throws(() => assertExpectedRemoteVersion({ version: 69 }), /Remote version mismatch/);
  assert.equal(assertExpectedRemoteVersion({ version: 70 }), 70);
});

test('normal static runtime import is included', () => {
  assert.deepEqual(runtimeRelativeImports('import value from "./runtime.ts";'), ['./runtime.ts']);
});
test('namespace import is included', () => {
  assert.deepEqual(runtimeRelativeImports('import * as values from "./runtime.ts";'), ['./runtime.ts']);
});
test('side-effect import is included', () => {
  assert.deepEqual(runtimeRelativeImports('import "./runtime.ts";'), ['./runtime.ts']);
});
test('dynamic string-literal import is included', () => {
  assert.deepEqual(runtimeRelativeImports('async function load() { return import("./runtime.ts"); }'), ['./runtime.ts']);
});
test('runtime named re-export is included', () => {
  assert.deepEqual(runtimeRelativeImports('export { value } from "./runtime.ts";'), ['./runtime.ts']);
});
test('export star is included', () => {
  assert.deepEqual(runtimeRelativeImports('export * from "./runtime.ts";'), ['./runtime.ts']);
});
test('import type is excluded', () => {
  assert.deepEqual(runtimeRelativeImports('import type { Value } from "./types.ts";'), []);
});
test('export type is excluded', () => {
  assert.deepEqual(runtimeRelativeImports('export type { Value } from "./types.ts";'), []);
});
test('mixed named import is included', () => {
  assert.deepEqual(runtimeRelativeImports('import { type Shape, value } from "./runtime.ts";'), ['./runtime.ts']);
});
test('all-type named import is excluded', () => {
  assert.deepEqual(runtimeRelativeImports('import { type Shape, type Size } from "./types.ts";'), []);
});
test('mixed named re-export is included', () => {
  assert.deepEqual(runtimeRelativeImports('export { type Shape, value } from "./runtime.ts";'), ['./runtime.ts']);
});
test('all-type named re-export is excluded', () => {
  assert.deepEqual(runtimeRelativeImports('export { type Shape, type Size } from "./types.ts";'), []);
});
test('non-relative package import is excluded', () => {
  assert.deepEqual(runtimeRelativeImports('import ts from "typescript";'), []);
});
test('duplicate runtime imports are deduplicated', () => {
  assert.deepEqual(runtimeRelativeImports('import first from "./runtime.ts"; import second from "./runtime.ts";'), ['./runtime.ts']);
});
test('path escaping the functions root is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reorder-identity-escape-'));
  const localRoot = join(root, 'functions');
  try {
    await mkdir(join(localRoot, 'ai-tasks'), { recursive: true });
    await writeFile(join(localRoot, 'ai-tasks/index.ts'), 'import "../../outside.ts";');
    await assert.rejects(collectRuntimeSourcePaths(localRoot), /Source outside functions tree/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function withRemoteGraph(action) {
  const root = await mkdtemp(join(tmpdir(), 'reorder-identity-remote-'));
  const remoteRoot = join(root, 'remote');
  const runtimePaths = await collectRuntimeSourcePaths(functionsRoot);
  try {
    for (const sourcePath of runtimePaths) {
      const target = join(remoteRoot, relative(functionsRoot, sourcePath));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(sourcePath, target);
    }
    await action({ remoteRoot, runtimePaths });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('current ai-tasks runtime graph is syntax-derived and excludes the type-only branch', async () => {
  const paths = await collectRuntimeSourcePaths(functionsRoot);
  const relativePaths = paths.map(path => relative(functionsRoot, path).replaceAll('\\', '/'));
  assert.equal(paths.length, 36);
  for (const excluded of missingTypeOnlyBranch) assert.equal(relativePaths.includes(excluded), false);
});
test('remote omission of the type-only branch passes identity', async () => {
  await withRemoteGraph(async ({ remoteRoot }) => {
    for (const excluded of missingTypeOnlyBranch)
      await assert.rejects(readFile(join(remoteRoot, ...excluded.split('/'))), { code: 'ENOENT' });
    assert.deepEqual(await compareSources(functionsRoot, remoteRoot), { fileCount: 36, hashMismatches: 0 });
  });
});
test('missing runtime module fails identity', async () => {
  await withRemoteGraph(async ({ remoteRoot, runtimePaths }) => {
    const required = runtimePaths.find(path => relative(functionsRoot, path).replaceAll('\\', '/') !== 'ai-tasks/index.ts');
    await rm(join(remoteRoot, relative(functionsRoot, required)));
    assert.equal((await compareSources(functionsRoot, remoteRoot)).hashMismatches, 1);
  });
});
test('true byte drift in a runtime module fails identity', async () => {
  await withRemoteGraph(async ({ remoteRoot, runtimePaths }) => {
    const required = runtimePaths.find(path => relative(functionsRoot, path).replaceAll('\\', '/') !== 'ai-tasks/index.ts');
    await appendFile(join(remoteRoot, relative(functionsRoot, required)), '\n// remote drift\n');
    assert.equal((await compareSources(functionsRoot, remoteRoot)).hashMismatches, 1);
  });
});
test('CRLF-only runtime source differences pass identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reorder-identity-crlf-'));
  try {
    for (const side of ['local', 'remote']) {
      await mkdir(join(root, side, 'ai-tasks'), { recursive: true });
      await mkdir(join(root, side, '_shared'), { recursive: true });
      await writeFile(join(root, side, 'ai-tasks/index.ts'), 'import { value } from "../_shared/value.ts";\n');
    }
    await writeFile(join(root, 'local/_shared/value.ts'), 'export const value = 1;\n');
    await writeFile(join(root, 'remote/_shared/value.ts'), 'export const value = 1;\r\n');
    assert.deepEqual(await compareSources(join(root, 'local'), join(root, 'remote')), { fileCount: 2, hashMismatches: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('extra remote wrapper or config does not affect identity', async () => {
  await withRemoteGraph(async ({ remoteRoot }) => {
    await writeFile(join(remoteRoot, 'deno.json'), '{}\n');
    assert.deepEqual(await compareSources(functionsRoot, remoteRoot), { fileCount: 36, hashMismatches: 0 });
  });
});
