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

const NETWORK_PATTERNS: RegExp[] = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bgh\b/i,
  /\bgit\s+(clone|fetch|pull|push)\b/i,
  /\b(npm|pnpm|yarn|pip|pip3|cargo|go)\s+(install|add|get)\b/i,
];

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

    const dangerous = DEFAULT_DANGEROUS_PATTERNS.find(pattern => pattern.test(trimmed));
    if (dangerous) {
      return {
        risk: 'needs_approval',
        reason: 'Command matches a destructive or publishing pattern.',
        matchedRule: dangerous.source,
      };
    }

    // An external-write redirection must always require approval, even when the
    // command otherwise matches a safe prefix (e.g. `node app.js 2>/etc/passwd`).
    if (workspaceRoot && this.config.requireApprovalForExternalWrites && this._looksLikeExternalWrite(trimmed, workspaceRoot)) {
      return {
        risk: 'needs_approval',
        reason: 'Command appears to write outside the workspace.',
      };
    }

    const safePrefix = this.safePrefixes.find(prefix => this._matchesSafePrefix(lower, prefix));
    if (safePrefix && !this._hasShellControlOperator(trimmed)) {
      return { risk: 'safe', reason: 'Command matches an approved safe prefix.', matchedRule: safePrefix };
    }

    if (this.config.requireApprovalForNetwork) {
      const network = NETWORK_PATTERNS.find(pattern => pattern.test(trimmed));
      if (network) {
        return {
          risk: 'needs_approval',
          reason: 'Command may access the network or external package registries.',
          matchedRule: network.source,
        };
      }
    }

    return {
      risk: 'safe',
      reason: 'Command does not match known dangerous, network, or external-write patterns.',
    };
  }

  private _looksLikeExternalWrite(command: string, workspaceRoot: string): boolean {
    // Catch stdout/stderr/combined redirections: `>`, `>>`, `2>`, `2>>`, `&>`, `&>>`.
    const redirectionPattern = /(?:^|\s)(?:\d*&?>|>>|\d+>>)\s*([^\s]+)/g;
    let match: RegExpExecArray | null;
    while ((match = redirectionPattern.exec(command)) !== null) {
      const target = match[1].replace(/^['"]|['"]$/g, '');
      if (!path.isAbsolute(target)) { continue; }
      const relative = path.relative(workspaceRoot, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { return true; }
    }
    return false;
  }

  private _matchesSafePrefix(lowerCommand: string, prefix: string): boolean {
    const lowerPrefix = prefix.toLowerCase();
    if (!lowerCommand.startsWith(lowerPrefix)) { return false; }
    if (lowerPrefix.endsWith(' ')) { return true; }
    const next = lowerCommand[lowerPrefix.length];
    return next === undefined || /\s/.test(next);
  }

  private _hasShellControlOperator(command: string): boolean {
    return /(?:&&|\|\||[;|`]|[$]\(|\r|\n)/.test(command);
  }
}
