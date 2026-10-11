import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface BlastRadiusResult {
  score: number;
  reasons: string[];
}

/**
 * Workspace Blast-Radius scorer.
 * Analyzes target files to estimate the potential risk / architectural impact of modifying them.
 * Computes:
 * 1. files_touched count
 * 2. Cross-module import/export depth via static regex scan (no heavy AST parser needed)
 * 3. Outstanding tsc diagnostics count for touched files
 */
export function computeBlastRadius(filePaths: string[]): BlastRadiusResult {
  const normalizedPaths = Array.from(
    new Set(filePaths.map((f) => f.trim()).filter((f) => Boolean(f)))
  );

  if (normalizedPaths.length === 0) {
    return { score: 0, reasons: ['No files specified'] };
  }

  const reasons: string[] = [];
  const fileCount = normalizedPaths.length;
  reasons.push(`${fileCount} file(s) touched`);

  // 1. Base files touched weight (up to 3.0 points for 10+ files)
  let filesScore = Math.min(3.0, fileCount * 0.3);

  // 2. Cross-module import/export depth scan
  let totalImports = 0;
  let totalExports = 0;
  let crossModuleDepth = 0;

  for (const filePath of normalizedPaths) {
    const absPath = resolve(process.cwd(), filePath);
    if (!existsSync(absPath)) continue;

    try {
      const content = readFileSync(absPath, 'utf-8');
      
      // Match static import statements: import ... from '...'; or require('...')
      const importMatches = content.match(/import\s+(?:[\w*\s{},]+from\s+)?['"][^'"]+['"]/g) || [];
      const requireMatches = content.match(/require\s*\(\s*['"][^'"]+['"]\s*\)/g) || [];
      const fileImports = importMatches.length + requireMatches.length;
      totalImports += fileImports;

      // Match export statements: export const/function/class/default/type/interface ...
      const exportMatches = content.match(/export\s+(?:default|const|let|var|function|class|type|interface|enum|\*|\{)/g) || [];
      const fileExports = exportMatches.length;
      totalExports += fileExports;

      // Approximate dependency depth: count relative imports that traverse up/across modules ("../")
      const crossModuleImports = (content.match(/(?:from|require\s*\()\s*['"](\.\.\/[^'"]+)['"]/g) || []).length;
      if (crossModuleImports > crossModuleDepth) {
        crossModuleDepth = crossModuleImports;
      }
    } catch {
      // Ignore read errors
    }
  }

  const importExportCount = totalImports + totalExports;
  if (importExportCount > 0) {
    reasons.push(`${totalImports} imports, ${totalExports} exports found across touched files`);
  }
  if (crossModuleDepth > 0) {
    reasons.push(`Cross-module import depth: ${crossModuleDepth}`);
  }

  // Import/export complexity score (up to 4.0 points)
  const importExportScore = Math.min(4.0, (importExportCount * 0.15) + (crossModuleDepth * 0.5));

  // 3. Outstanding tsc diagnostics count for touched files
  let tscErrors = 0;
  const tsFiles = normalizedPaths.filter((f) => /\.[mc]?[jt]sx?$/i.test(f));
  if (tsFiles.length > 0) {
    try {
      const tscRun = spawnSync('bunx', ['tsc', '--noEmit', '--skipLibCheck', ...tsFiles], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 5000
      });
      const output = (tscRun.stdout || '') + (tscRun.stderr || '');
      // Count lines formatted as "path/to/file.ts:line:col - error TSxxxx: message"
      const errorMatches = output.match(/error TS\d+:/g) || [];
      tscErrors = errorMatches.length;
      if (tscErrors > 0) {
        reasons.push(`${tscErrors} outstanding TypeScript diagnostic error(s) in touched files`);
      }
    } catch {
      // tsc scan failed or timed out; non-blocking
    }
  }

  // Diagnostics score (up to 3.0 points)
  const diagScore = Math.min(3.0, tscErrors * 0.5);

  const rawScore = filesScore + importExportScore + diagScore;
  const score = Math.round(Math.min(10.0, rawScore) * 10) / 10;

  return {
    score,
    reasons
  };
}
