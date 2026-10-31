import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import {
  SyntaxKind,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteral
} from 'typescript/unstable/ast';

const ALLOWED_EXACT = new Set([
  'server/index.ts',
  'server/session-entry.ts',
  'server/session-log.ts',
  'server/redact.ts',
  'server/untrusted.ts'
]);

const ALLOWED_PREFIXES = [
  'shared/',
  'server/v2/',
  'cli/v2/'
];

const FORBIDDEN_MARKERS = [
  'server/desk.ts',
  'server/app.ts',
  'server/runtime.ts',
  'providers/mock'
];

function toPosixRel(root, absFile) {
  return path.relative(root, absFile).replace(/\\/g, '/');
}

function normCmp(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function findProject(snapshot, configPath) {
  const direct = snapshot.getProject(configPath);
  if (direct) return direct;
  const target = normCmp(configPath);
  for (const proj of snapshot.getProjects()) {
    if (normCmp(proj.configFileName) === target || normCmp(proj.id) === target) {
      return proj;
    }
  }
  return undefined;
}

function findSourceFile(project, absFile) {
  const direct = project.program.getSourceFile(absFile);
  if (direct) return direct;
  const slash = absFile.replace(/\\/g, '/');
  const bySlash = project.program.getSourceFile(slash);
  if (bySlash) return bySlash;
  const target = normCmp(absFile);
  for (const sf of project.program.getSourceFiles()) {
    if (normCmp(sf.fileName) === target) return sf;
  }
  return undefined;
}

function walkAst(node, visit) {
  if (!node) return;
  visit(node);
  node.forEachChild((child) => {
    walkAst(child, visit);
  });
}

function resolveRelativeSource(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const dir = path.dirname(fromFile);
  const rawTarget = path.resolve(dir, spec);
  const candidates = [];
  if (spec.endsWith('.js')) {
    candidates.push(rawTarget.replace(/\.js$/, '.ts'));
    candidates.push(rawTarget.replace(/\.js$/, '.tsx'));
    candidates.push(rawTarget);
  } else if (spec.endsWith('.mjs') || spec.endsWith('.ts') || spec.endsWith('.tsx')) {
    candidates.push(rawTarget);
  } else {
    candidates.push(`${rawTarget}.ts`, `${rawTarget}.tsx`, `${rawTarget}.js`, path.join(rawTarget, 'index.ts'), path.join(rawTarget, 'index.js'));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

function isAllowedRepoFile(relPath) {
  if (ALLOWED_EXACT.has(relPath)) return true;
  return ALLOWED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function collectJsClosure(root, distEntryAbs, distRootAbs) {
  const visited = new Set();
  const queue = [distEntryAbs];
  const relImportRe = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current) || !existsSync(current)) continue;
    visited.add(current);
    const code = readFileSync(current, 'utf8');
    let match;
    while ((match = relImportRe.exec(code)) !== null) {
      const spec = match[1];
      const target = path.resolve(path.dirname(current), spec);
      if (existsSync(target) && !visited.has(target)) {
        queue.push(target);
      }
    }
  }

  return [...visited]
    .map((abs) => toPosixRel(distRootAbs ?? root, abs))
    .sort((a, b) => a.localeCompare(b));
}

export function collectRuntimeBoundary(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const configFile = path.join(
    resolvedRoot,
    options.tsconfig ?? (existsSync(path.join(resolvedRoot, 'tsconfig.rebirth.json')) ? 'tsconfig.rebirth.json' : 'tsconfig.server.json')
  );
  const entryRel = options.entry ?? 'server/index.ts';
  const entryAbs = path.join(resolvedRoot, entryRel);

  const api = new API({ cwd: resolvedRoot });
  const visitedAbs = new Set();
  const edges = [];

  try {
    const snapshot = api.updateSnapshot({ openProjects: [configFile] });
    const project = findProject(snapshot, configFile);
    if (!project) {
      throw new Error(`Failed to open TypeScript project ${configFile}`);
    }

    const queue = [entryAbs];
    while (queue.length > 0) {
      const currentAbs = queue.shift();
      if (!currentAbs || visitedAbs.has(currentAbs)) continue;
      visitedAbs.add(currentAbs);

      const sf = findSourceFile(project, currentAbs);
      const specs = new Set();
      if (sf) {
        walkAst(sf, (node) => {
          if (isImportDeclaration(node) && node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
            specs.add(node.moduleSpecifier.text);
          } else if (isExportDeclaration(node) && node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
            specs.add(node.moduleSpecifier.text);
          } else if (
            isCallExpression(node) &&
            node.expression.kind === SyntaxKind.ImportKeyword &&
            node.arguments[0] &&
            isStringLiteral(node.arguments[0])
          ) {
            specs.add(node.arguments[0].text);
          }
        });
      } else if (existsSync(currentAbs)) {
        const text = readFileSync(currentAbs, 'utf8');
        const re = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g;
        let m;
        while ((m = re.exec(text)) !== null) specs.add(m[1]);
      }

      for (const spec of specs) {
        const resolved = resolveRelativeSource(currentAbs, spec);
        if (!resolved) continue;
        edges.push({
          from: toPosixRel(resolvedRoot, currentAbs),
          to: toPosixRel(resolvedRoot, resolved)
        });
        if (!visitedAbs.has(resolved)) {
          queue.push(resolved);
        }
      }
    }
  } finally {
    api.close();
  }

  const sourceClosure = [...visitedAbs]
    .map((abs) => toPosixRel(resolvedRoot, abs))
    .sort((a, b) => a.localeCompare(b));

  const violations = [];
  for (const rel of sourceClosure) {
    if (!isAllowedRepoFile(rel)) {
      violations.push(`Disallowed module in runtime source closure: ${rel}`);
    }
    for (const marker of FORBIDDEN_MARKERS) {
      if (rel.includes(marker)) {
        violations.push(`Forbidden legacy module in runtime source closure: ${rel}`);
      }
    }
  }

  const distRebirthEntry = path.join(resolvedRoot, options.distEntry ?? 'dist-rebirth/server/index.js');
  const emittedClosure = existsSync(distRebirthEntry)
    ? collectJsClosure(resolvedRoot, distRebirthEntry, path.join(resolvedRoot, path.dirname(options.distEntry ?? 'dist-rebirth/server/index.js'), '..'))
    : [];

  for (const relJs of emittedClosure) {
    const candidateTs = relJs.replace(/\.js$/, '.ts');
    if (!isAllowedRepoFile(candidateTs)) {
      violations.push(`Disallowed emitted module in dist closure: ${relJs}`);
    }
  }

  return {
    entry: entryRel,
    sourceClosure,
    emittedClosure,
    edges,
    violations
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = collectRuntimeBoundary(root);
  if (report.violations.length > 0) {
    console.error('Runtime boundary violations detected:');
    for (const v of report.violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(
    `Runtime boundary OK (${report.sourceClosure.length} source files, ${report.emittedClosure.length} emitted files).`
  );
}
