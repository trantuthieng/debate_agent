import * as path from 'path';
import type { CommandPolicyConfig } from '../types';

export type CommandRisk = 'safe' | 'needs_approval' | 'blocked';

export interface CommandPolicyDecision {
  risk: CommandRisk;
  reason: string;
  matchedRule?: string;
}

const DEFAULT_DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-[rRf]/i,
  /\bdel\s+\/[sS]/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[fFdD]/i,
  /\bgit\s+push/i,
  /\bcurl[^|]*\|\s*(bash|sh|zsh)/i,
  /\bwget[^|]*\|\s*(bash|sh|zsh)/i,
  /\bsudo\b/i,
  /\bchmod\s+-R\s+777/i,
  /\bDROP\s+DATABASE/i,
  /\bDROP\s+TABLE/i,
  /\btruncate\s+table/i,
  /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\bnpx\s+.*--yes\b.*install/i,
];

const DEFAULT_SAFE_PREFIXES = [
  'npm install',
  'npm run compile',
  'npm run build',
  'npm test',
  'npm run test',
  'npm run lint',
  'pnpm install',
  'pnpm run compile',
  'pnpm run build',
  'pnpm test',
  'pnpm run test',
  'yarn install',
  'yarn test',
  'yarn build',
  'node ',
  'python ',
  'python3 ',
  'pip install',
  'pip3 install',
  'go build',
  'go test',
  'cargo build',
  'cargo test',
  'mvn compile',
  'mvn test',
  'gradle build',
  'gradle test',
  'dotnet build',
  'dotnet test',
];

interface ShellToken { value: string; operator: boolean }

// This is a conservative command classifier, not a shell parser or OS sandbox.
// In particular, project scripts can themselves perform network I/O or writes.
// Complex shell syntax and inline programs need explicit approval; ordinary
// project scripts retain their existing execution path.
function scanShell(command: string): { tokens: ShellToken[]; complex: boolean } {
  const tokens: ShellToken[] = [];
  let word = '';
  let started = false;
  let quote = '';
  let complex = false;
  const flush = (): void => {
    if (started) { tokens.push({ value: word, operator: false }); }
    word = ''; started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === '\\' && quote !== "'") {
      const next = command[++i];
      if (next === undefined || /[\r\n]/.test(next)) { complex = true; }
      else { word += next; started = true; }
    } else if (quote) {
      if (char === quote) { quote = ''; }
      else {
        if (quote === '"' && /[$`]/.test(char)) { complex = true; }
        word += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char; started = true;
    } else if (char === '#' && !started) {
      // Stop at a comment, but still inspect any following command line.
      while (i + 1 < command.length && !/[\r\n]/.test(command[i + 1])) { i++; }
    } else if (/\s/.test(char)) {
      flush();
      if (/[\r\n]/.test(char)) { complex = true; }
    } else if (/[;&|<>()]/.test(char)) {
      flush();
      const operator = /^(?:&>>|&>|>>|>\||>&|<>|<<|<&|&&|\|\||[;&|<>()])/.exec(command.slice(i))![0];
      tokens.push({ value: operator, operator: true });
      if (!['>', '>>', '>|', '&>', '&>>', '>&', '<', '<&', '<>'].includes(operator)) { complex = true; }
      i += operator.length - 1;
    } else {
      if (/[$`{}~]/.test(char)) { complex = true; }
      word += char; started = true;
    }
  }
  flush();
  return { tokens, complex: complex || quote !== '' };
}

export class CommandPolicy {
  private readonly safePrefixes: string[];
  private readonly config: CommandPolicyConfig;

  constructor(config?: Partial<CommandPolicyConfig>) {
    this.config = {
      approvedPrefixes: [],
      requireApprovalForNetwork: true,
      requireApprovalForExternalWrites: true,
      allowLongRunningSessions: true,
      ...config,
    };
    this.safePrefixes = [...DEFAULT_SAFE_PREFIXES, ...this.config.approvedPrefixes];
  }

  isDangerous(command: string): boolean {
    return DEFAULT_DANGEROUS_PATTERNS.some(pattern => pattern.test(command));
  }

  isSafe(command: string): boolean {
    return this.evaluate(command).risk === 'safe';
  }

  evaluate(command: string, workspaceRoot?: string): CommandPolicyDecision {
    const trimmed = command.trim();
    const lower = trimmed.toLowerCase();
    const shell = scanShell(trimmed);
    const argv = shell.tokens.filter(token => !token.operator).map(token => token.value);

    const dangerous = DEFAULT_DANGEROUS_PATTERNS.find(pattern => pattern.test(trimmed) || pattern.test(argv.join(' ')));
    if (dangerous) {
      return {
        risk: 'needs_approval',
        reason: 'Command matches a destructive or publishing pattern.',
        matchedRule: dangerous.source,
      };
    }

    // An external-write redirection must always require approval, even when the
    // command otherwise matches a safe prefix (e.g. `node app.js 2>/etc/passwd`).
    if (this.config.requireApprovalForExternalWrites && this._looksLikeExternalWrite(shell.tokens, argv, workspaceRoot)) {
      return {
        risk: 'needs_approval',
        reason: 'Command appears to write outside the workspace.',
      };
    }

    if (this.config.requireApprovalForNetwork && this._looksLikeNetworkCommand(argv)) {
      return {
        risk: 'needs_approval',
        reason: 'Command may access the network or external package registries.',
      };
    }

    if (shell.complex || this._hasInlineProgram(argv)) {
      return {
        risk: 'needs_approval',
        reason: 'Compound shell syntax, expansions, or inline programs require explicit approval.',
      };
    }

    // Prefix approval never disables the network/external-write flags, or
    // grants arbitrary extra commands appended to an approved command.
    const safePrefix = this.safePrefixes.find(prefix => this._matchesSafePrefix(lower, prefix));
    if (safePrefix) {
      return { risk: 'safe', reason: 'Command matches an approved safe prefix.', matchedRule: safePrefix };
    }

    return {
      risk: 'safe',
      reason: 'Command does not match known dangerous, network, or external-write patterns.',
    };
  }

  private _looksLikeExternalWrite(tokens: ShellToken[], argv: string[], workspaceRoot?: string): boolean {
    const outside = (target: string): boolean => {
      if (!workspaceRoot || !target || /[*?\[\]]/.test(target)) { return true; }
      const relative = path.relative(path.resolve(workspaceRoot), path.resolve(workspaceRoot, target));
      return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    };
    for (let i = 0; i < tokens.length; i++) {
      if (!tokens[i].operator || !['>', '>>', '>|', '&>', '&>>', '>&', '<>'].includes(tokens[i].value)) { continue; }
      const target = tokens[i + 1];
      if (!target || target.operator) { return true; }
      if (tokens[i].value === '>&' && /^(?:\d+|-)$/.test(target.value)) { continue; }
      if (outside(target.value)) { return true; }
    }
    const executable = path.basename(argv[0] ?? '').toLowerCase().replace(/\.exe$/, '');
    const writesOperands = /^(?:cp|mv|install|mkdir|touch|tee|truncate|dd|ln|rm|rmdir)$/.test(executable);
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      // Global package installation writes beyond the project even without a
      // literal path argument. Prefix/output options can redirect approved tools.
      if (/^(?:npm|pnpm|yarn|pip|pip3)$/.test(executable) && /^(?:-g|--global|--user)(?:=|$)|^--location=global$/.test(arg)) { return true; }
      const option = /^(--(?:prefix|cwd|dir|directory|target|root|output|out-dir|cache|store-dir)|-[Cot])(?:=(.*))?$/.exec(arg);
      if (option && outside(option[2] ?? argv[i + 1] ?? '')) { return true; }
      const attached = /^(?:-[Cot]|of=)(.+)$/.exec(arg);
      if (attached && outside(attached[1])) { return true; }
      if (writesOperands && !arg.startsWith('-') && outside(arg)) { return true; }
    }
    return false;
  }

  private _looksLikeNetworkCommand(argv: string[]): boolean {
    return argv.some((arg, index) => {
      const executable = path.basename(arg).toLowerCase().replace(/\.exe$/, '');
      const rest = argv.slice(index + 1);
      if (/^(?:curl|wget|gh|npx)$/.test(executable)) { return true; }
      if (executable === 'git') { return rest.some(value => /^(?:clone|fetch|pull|push|ls-remote)$/.test(value)); }
      if (/^(?:npm|pnpm|yarn|pip|pip3|cargo|go)$/.test(executable)) {
        return (executable === 'yarn' && rest.length === 0) ||
          rest.some(value => /^(?:install|i|ci|add|get|update|upgrade|exec|dlx|download)$/.test(value));
      }
      return false;
    });
  }

  private _hasInlineProgram(argv: string[]): boolean {
    if (/^[A-Za-z_]\w*=/.test(argv[0] ?? '')) { return true; }
    return argv.some((arg, index) => {
      const executable = path.basename(arg).toLowerCase().replace(/\.exe$/, '');
      const rest = argv.slice(index + 1);
      if (/^(?:sh|bash|zsh|dash|ksh|fish|cmd|powershell|pwsh)$/.test(executable) ||
          (index === 0 && /^(?:eval|source|\.|env|command|exec|xargs)$/.test(executable))) {
        return !(rest.length === 1 && rest[0] === '--version');
      }
      if (/^(?:node|nodejs)$/.test(executable)) {
        return rest.some(value => value === '-' || /^(?:-[epr]|--(?:eval|print|require|import|loader)(?:=|$))/.test(value));
      }
      if (/^python\d*(?:\.\d+)?$/.test(executable)) {
        return rest.some(value => value === '-' || value.startsWith('-c'));
      }
      if (/^(?:ruby|perl)$/.test(executable)) {
        return rest.some(value => value === '-' || /^-[er]/.test(value));
      }
      return false;
    });
  }

  private _matchesSafePrefix(lowerCommand: string, prefix: string): boolean {
    const lowerPrefix = prefix.toLowerCase();
    if (!lowerCommand.startsWith(lowerPrefix)) { return false; }
    if (lowerPrefix.endsWith(' ')) { return true; }
    const next = lowerCommand[lowerPrefix.length];
    return next === undefined || /\s/.test(next);
  }
}
