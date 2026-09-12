import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { renderLocalScanForPrompt, scanLocalProjects, scanProjectFolder } from '@/lib/profile/localScan';

/**
 * Local scan branch coverage: every manifest reader, stack mapping, markers,
 * language counting, ignored directories, corrupt manifests, BOM handling,
 * and the not-a-directory paths. All from real temporary fixture trees.
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function write(file: string, content: string | Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content);
}

async function polyglot(): Promise<string> {
  const root = tmpDir('poly-');
  await write(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'poly',
      type: 'module',
      dependencies: { next: '15.0.0', zod: '4.0.0', leftpad: '1.0.0' },
      devDependencies: { vitest: '5.0.0' },
      scripts: { dev: 'next dev', test: 'vitest run', build: 'next build' },
    }),
  );
  await write(
    path.join(root, 'pyproject.toml'),
    [
      '[project]',
      'name = "poly"',
      'dependencies = ["fastapi>=0.100", "requests", "not-a-real-dep>=1", ""]',
      '',
      '[tool.poetry.dependencies]',
      'python = "^3.12"',
      'pytest = "^8"',
      '',
      '[tool.poetry]',
      'name = "poly"',
      '',
      '[tool.ruff]',
      'line-length = 100',
    ].join('\n'),
  );
  await write(
    path.join(root, 'go.mod'),
    ['module example.com/poly', '', 'go 1.23', '', 'require (', '\tgithub.com/gin-gonic/gin v1.10.0', ')', '', 'require github.com/labstack/echo v4.12.0'].join('\n'),
  );
  await write(
    path.join(root, 'Cargo.toml'),
    ['[package]', 'name = "poly"', 'edition = "2021"', '', '[dependencies]', 'tokio = "1"', 'serde = "1"', '', '[dev-dependencies]', 'tokio = "1"'].join('\n'),
  );
  await write(path.join(root, 'Dockerfile'), 'FROM node:20\n');
  await write(path.join(root, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  await write(path.join(root, 'tests', 'a.test.ts'), 'x\n');
  await write(path.join(root, 'docs', 'index.md'), '# Docs\n');
  await write(path.join(root, 'drizzle', '0000.sql'), 'select 1;\n');
  await write(path.join(root, 'LICENSE'), 'MIT\n');
  await write(path.join(root, '.env.example'), 'FOO=\n');
  await write(path.join(root, 'pnpm-workspace.yaml'), 'packages: ["*"]\n');
  await write(path.join(root, 'README.md'), '# Poly\nA little bit of everything.\n');
  await write(path.join(root, 'src', 'index.ts'), 'export {};\n'.repeat(20));
  await write(path.join(root, 'src', 'app.py'), 'print(1)\n'.repeat(20));
  await write(path.join(root, 'src', 'main.go'), 'package main\n'.repeat(20));
  await write(path.join(root, 'src', 'main.rs'), 'fn main() {}\n'.repeat(20));
  // Ignored: must not be walked or counted.
  await write(path.join(root, 'node_modules', 'dep', 'index.js'), 'x\n'.repeat(500));
  await write(path.join(root, '.git', 'HEAD'), 'ref: main\n');
  return root;
}

describe('polyglot project', () => {
  it('detects every stack, marker and language', async () => {
    const root = await polyglot();
    const result = await scanLocalProjects([root], { now: () => 1_789_084_800_000 });
    expect(result.missingPaths).toEqual([]);
    expect(result.projects).toHaveLength(1);

    const proj = result.projects[0]!;
    expect(proj.name).toBe('poly');
    expect(proj.manifests.map((m) => m.file).sort()).toEqual(
      ['Cargo.toml', 'go.mod', 'package.json', 'pyproject.toml'].sort(),
    );
    expect(proj.manifests.every((m) => m.parseError === null)).toBe(true);

    for (const stack of ['Next.js', 'Zod', 'Vitest', 'Node.js', 'ESM', 'FastAPI', 'pytest', 'Ruff', 'Poetry', 'Gin', 'Echo', 'Go 1.23', 'Tokio', 'Serde', 'Rust 2021', 'Python', 'Go', 'Rust']) {
      expect(proj.stacks, `stack ${stack}`).toContain(stack);
    }
    expect(result.stacks).toContain('Next.js');

    for (const marker of ['docker', 'ci', 'tests', 'docs', 'database', 'license', 'env-config', 'monorepo']) {
      expect(proj.markers, `marker ${marker}`).toContain(marker);
    }

    const langs = Object.fromEntries(proj.languages.map((l) => [l.language, l.files]));
    for (const lang of ['TypeScript', 'Python', 'Go', 'Rust']) {
      expect(langs[lang]).toBeGreaterThanOrEqual(1);
    }
    // Ignored directories contribute nothing.
    expect(langs['JavaScript'] ?? 0).toBe(0);

    expect(proj.readmeFirstLine).toBe('Poly');
    expect(proj.fileCount).toBeGreaterThan(0);
    expect(proj.lastModifiedAt).not.toBeNull();

    const pkg = proj.manifests.find((m) => m.file === 'package.json')!;
    expect(pkg.scripts).toMatchObject({ dev: 'next dev' });
    expect(pkg.dependencies).toContain('next');

    const rendered = renderLocalScanForPrompt(result);
    expect(rendered).toContain('poly');
    expect(renderLocalScanForPrompt({ ...result, projects: [] })).toContain('No local project folders configured');
  });

  it('handles BOM-prefixed manifests', async () => {
    const root = tmpDir('bom-');
    await write(path.join(root, 'package.json'), '﻿' + JSON.stringify({ name: 'bommed' }));
    const proj = await scanProjectFolder(root, {});
    expect(proj!.manifests[0]!.name).toBe('bommed');
  });

  it('reports corrupt manifests as parse errors, not throws', async () => {
    const root = tmpDir('corrupt-');
    await write(path.join(root, 'package.json'), '{ not json');
    await write(path.join(root, 'go.mod'), 'just some words\n');
    const proj = await scanProjectFolder(root, {});
    const pkg = proj!.manifests.find((m) => m.file === 'package.json')!;
    expect(pkg.parseError).not.toBeNull();
    const go = proj!.manifests.find((m) => m.file === 'go.mod')!;
    expect(go.parseError).toBe('no module directive found');
  });

  it('treats files and absent paths as missing, never throwing', async () => {
    const root = tmpDir('missing-');
    const file = path.join(root, 'file.txt');
    await write(file, 'x');
    const result = await scanLocalProjects([file, path.join(root, 'nope')], {});
    expect(result.projects).toHaveLength(0);
    expect(result.missingPaths).toHaveLength(2);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('scans an empty directory into an empty project', async () => {
    const root = tmpDir('empty-');
    const proj = await scanProjectFolder(root, {});
    expect(proj!.manifests).toEqual([]);
    expect(proj!.stacks).toEqual([]);
    expect(proj!.languages).toEqual([]);
  });
});
