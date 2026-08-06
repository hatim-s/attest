import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(packageDirectory, 'dist');

/** Writes the single-file dashboard as a typed ESM string asset for the CLI. */
const writeEmbeddedDashboard = async (html: string): Promise<void> => {
  const source = `const dashboardHtml = ${JSON.stringify(html)};\n\nexport { dashboardHtml };\n`;
  const declaration = 'declare const dashboardHtml: string;\n\nexport { dashboardHtml };\n';
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, 'embedded-dashboard.js'), source, 'utf8'),
    writeFile(resolve(outputDirectory, 'embedded-dashboard.d.ts'), declaration, 'utf8'),
  ]);
};

/** Builds in an isolated temporary directory so concurrent workspace commands cannot race. */
const buildDashboard = async (): Promise<void> => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'attest-web-build-'));
  try {
    await build({
      root: packageDirectory,
      configFile: false,
      build: {
        cssCodeSplit: false,
        emptyOutDir: true,
        outDir: temporaryDirectory,
        target: 'es2022',
      },
      plugins: [react(), tailwindcss(), viteSingleFile()],
    });
    const html = await readFile(resolve(temporaryDirectory, 'index.html'), 'utf8');
    await writeEmbeddedDashboard(html);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
};

await buildDashboard();

export { buildDashboard, writeEmbeddedDashboard };
