import * as fs from 'fs';
import { findBrowserDeliveryIssues } from '../utils/browserDelivery';
import { isPlaceholderScript } from '../utils/testTaskContracts';
import * as path from 'path';
import type { VerificationCommand, VerificationPlan, VerificationStack } from '../types';

/** Builds a source-backed verification plan for every stack in the artifact. */
export class VerificationPlanner {
  constructor(private readonly rootDir: string) {}

  plan(packageManager: 'npm' | 'pnpm' | 'yarn' = 'npm'): VerificationPlan {
    const files = this._files();
    const stacks: VerificationStack[] = [];
    const commands: VerificationCommand[] = [];
    const blockingIssues: string[] = [];
    const inspectedTestFiles: string[] = [];
    const addStack = (stack: VerificationStack): void => {
      if (!stacks.includes(stack)) { stacks.push(stack); }
    };
    const addCommand = (command: VerificationCommand): void => {
      if (!commands.some(item => item.command === command.command)) { commands.push(command); }
    };

    const packageJson = this._readJson('package.json');
    if (files.includes('package.json')) {
      addStack('node');
      if (!packageJson) {
        blockingIssues.push('package.json is missing or invalid JSON.');
      } else {
        const scripts = packageJson.scripts && typeof packageJson.scripts === 'object'
          ? packageJson.scripts as Record<string, unknown>
          : {};
        const run = (name: string): string => packageManager === 'npm'
          ? (name === 'test' ? 'npm test' : `npm run ${name}`)
          : packageManager === 'pnpm'
            ? (name === 'test' ? 'pnpm test' : `pnpm run ${name}`)
            : (name === 'test' ? 'yarn test' : `yarn ${name}`);
        for (const name of ['compile', 'build', 'lint', 'typecheck', 'test']) {
          if (typeof scripts[name] !== 'string') { continue; }
          addCommand({
            stack: 'node',
            kind: name === 'test' ? 'test' : name === 'lint' ? 'lint' : name === 'typecheck' ? 'typecheck' : 'build',
            command: run(name),
            reason: `package.json defines the ${name} script.`,
          });
        }
        // A dev server compiling on demand is not evidence of a distributable build.
        // Infer only tools explicitly present in the artifact; never download an arbitrary CLI.
        if (!scripts.build) {
          const dependencies = { ...(packageJson.dependencies as Record<string, unknown> ?? {}),
            ...(packageJson.devDependencies as Record<string, unknown> ?? {}) };
          const scriptText = Object.values(scripts).filter(value => typeof value === 'string').join('\n');
          if (dependencies.webpack || files.some(file => /^webpack\.config\.[cm]?[jt]s$/.test(file))) {
            addCommand({ stack: 'node', kind: 'build', command: 'node node_modules/webpack/bin/webpack.js --mode production',
              reason: 'Webpack artifact has no build script; compile the actual configured entry point and bundle.' });
          } else if (dependencies.vite || /\bvite\b/.test(scriptText)) {
            addCommand({ stack: 'node', kind: 'build', command: 'node node_modules/vite/bin/vite.js build',
              reason: 'Vite artifact has no build script; verify the production entry point and bundle.' });
          }
        }
        if (!scripts.test) { blockingIssues.push('Node artifact has no package.json test script.'); }
        else if (typeof scripts.test === 'string' && isPlaceholderScript(scripts.test)) {
          // Benchmark run 7: "echo \"Tests will be implemented in a later step\" && exit 0"
          // made npm test pass while real test files sat unrun.
          blockingIssues.push(`package.json test script is a placeholder ("${scripts.test}"); it must run the project's real tests.`);
        }
      }
    }

    const pythonFiles = files.filter(file => file.endsWith('.py'));
    if (pythonFiles.length > 0) {
      addStack('python');
      const manifest = files.includes('pyproject.toml') ? 'pyproject.toml'
        : files.includes('requirements.txt') ? 'requirements.txt'
          : '';
      if (!manifest) {
        blockingIssues.push('Python artifact is missing requirements.txt or pyproject.toml.');
      } else if (!this._isValidPythonManifest(manifest)) {
        blockingIssues.push(`${manifest} is empty or does not contain a recognizable dependency/project declaration.`);
      }
      const pythonTests = pythonFiles.filter(file => /(^|\/)(tests?|test)\/.*\.py$|(^|\/)test_.*\.py$|_test\.py$/i.test(file));
      inspectedTestFiles.push(...pythonTests);
      if (pythonTests.length > 0) {
        addCommand({ stack: 'python', kind: 'test', command: 'python3 -m pytest', reason: 'Python test modules were discovered.' });
      } else {
        addCommand({ stack: 'python', kind: 'smoke', command: 'python3 -m compileall -q .', reason: 'Python sources need at least a syntax smoke test.' });
        blockingIssues.push('Python artifact has no discoverable test modules.');
      }
    }

    if (files.includes('go.mod')) {
      addStack('go');
      addCommand({ stack: 'go', kind: 'test', command: 'go test ./...', reason: 'go.mod identifies a Go module.' });
    }
    if (files.includes('Cargo.toml')) {
      addStack('rust');
      addCommand({ stack: 'rust', kind: 'test', command: 'cargo test', reason: 'Cargo.toml identifies a Rust crate.' });
    }
    if (files.includes('pom.xml')) {
      addStack('java');
      addCommand({ stack: 'java', kind: 'test', command: 'mvn test', reason: 'pom.xml identifies a Maven project.' });
    } else if (files.includes('gradlew')) {
      addStack('java');
      addCommand({ stack: 'java', kind: 'test', command: './gradlew test', reason: 'The Gradle wrapper identifies a JVM project.' });
    }
    if (files.some(file => file.endsWith('.csproj') || file.endsWith('.sln'))) {
      addStack('dotnet');
      addCommand({ stack: 'dotnet', kind: 'test', command: 'dotnet test', reason: '.NET project/solution files were discovered.' });
    }
    if (files.includes('Package.swift')) {
      addStack('swift');
      addCommand({ stack: 'swift', kind: 'test', command: 'swift test', reason: 'Package.swift identifies a Swift package.' });
    }

    for (const testFile of this._testFiles(files)) {
      if (!inspectedTestFiles.includes(testFile)) { inspectedTestFiles.push(testFile); }
      const content = this._read(testFile);
      if (this._looksLikePlaceholderTest(testFile, content)) {
        blockingIssues.push(`Placeholder or assertion-free test detected: ${testFile}.`);
      }
    }

    for (const issue of findBrowserDeliveryIssues(this.rootDir)) {
      blockingIssues.push(issue.message);
    }

    if (!files.includes('package.json') && files.some(file => /(^|\/)index\.html$/i.test(file))) {
      addStack('web');
    }
    if (stacks.length === 0) {
      blockingIssues.push('No supported artifact stack was detected.');
    }
    if (commands.length === 0 && !stacks.includes('web')) {
      blockingIssues.push('No artifact-aware verification command could be planned.');
    }

    return {
      generatedAt: new Date().toISOString(),
      stacks,
      commands,
      blockingIssues: [...new Set(blockingIssues)],
      inspectedTestFiles: [...new Set(inspectedTestFiles)],
    };
  }

  private _files(): string[] {
    const result: string[] = [];
    const visit = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (['.git', '.agent-workspace', 'node_modules', 'out', 'dist', '.pytest_cache'].includes(entry.name)) { continue; }
        const full = path.join(dir, entry.name);
        const relative = path.relative(this.rootDir, full).replace(/\\/g, '/');
        if (entry.isDirectory()) { visit(full); }
        else if (entry.isFile()) { result.push(relative); }
      }
    };
    visit(this.rootDir);
    return result.sort();
  }

  private _testFiles(files: string[]): string[] {
    return files.filter(file =>
      /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_.*\.py$|_test\.py$/i.test(file)
    );
  }

  private _looksLikePlaceholderTest(file: string, content: string): boolean {
    if (!content.trim()) { return true; }
    if (file.endsWith('.py')) {
      if (/\bassert\s+(True|1)\b/.test(content)) { return true; }
      if (/def\s+test_[^(]*\([^)]*\):\s*(?:#.*\s*)?(?:pass|\.\.\.)\s*$/m.test(content)) { return true; }
      return false;
    }
    if (/\b(?:it|test)\s*\([^,]+,\s*(?:async\s*)?\(.*?\)\s*=>\s*\{\s*\}\s*\)/s.test(content)) { return true; }
    if (/\b(?:it|test)\s*\([^,]+,\s*(?:async\s*)?function\s*\([^)]*\)\s*\{\s*\}\s*\)/s.test(content)) { return true; }
    return false;
  }

  private _isValidPythonManifest(file: string): boolean {
    const content = this._read(file).trim();
    if (!content) { return false; }
    if (file === 'requirements.txt') {
      return content.split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith('#'));
    }
    return /\[(project|build-system|tool\.[^\]]+)\]/.test(content);
  }

  private _read(file: string): string {
    try { return fs.readFileSync(path.join(this.rootDir, file), 'utf8'); } catch { return ''; }
  }

  private _readJson(file: string): Record<string, unknown> | null {
    try { return JSON.parse(this._read(file)) as Record<string, unknown>; } catch { return null; }
  }
}
