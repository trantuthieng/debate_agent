import type { ToolCallRequest, ToolCallResult, ToolDefinition } from '../types';
import { FileManager } from '../workspace/FileManager';
import { SearchService } from '../services/searchService';
import { TerminalRunner } from '../terminal/TerminalRunner';
import { PatchService } from '../services/patchService';
import { WebFetcherService } from '../services/webFetcherService';

export class AutonomousToolRegistry {
  constructor(
    private readonly fileManager: FileManager,
    private readonly search: SearchService,
    private readonly terminal: TerminalRunner,
    private readonly patchService: PatchService,
    private readonly webFetcher: WebFetcherService
  ) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: 'read_file',
        description: 'Read a workspace file by relative path.',
        safe: true,
        inputSchema: { path: 'string' },
      },
      {
        name: 'search',
        description: 'Search the workspace for a literal query.',
        safe: true,
        inputSchema: { query: 'string', maxResults: 'number?' },
      },
      {
        name: 'run_command',
        description: 'Run a safe terminal command in the workspace.',
        safe: false,
        inputSchema: { command: 'string', timeoutMs: 'number?' },
      },
      {
        name: 'apply_patch',
        description: 'Apply a unified patch to workspace files.',
        safe: false,
        inputSchema: { path: 'string', patch: 'string' },
      },
      {
        name: 'fetch_url',
        description: 'Fetch a URL and return readable text.',
        safe: false,
        inputSchema: { url: 'string' },
      },
    ];
  }

  manifestForPrompt(): string {
    return [
      '# Available Autonomous Tools',
      '',
      ...this.definitions().map(tool =>
        `- ${tool.name}: ${tool.description} Safe without approval: ${tool.safe ? 'yes' : 'policy-gated'}.`
      ),
      '',
      'The current implementation exposes these tools to the orchestrator. Model roles should request focused file reads/searches and small patches instead of rewriting broad file sets.',
    ].join('\n');
  }

  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    try {
      switch (request.name) {
        case 'read_file':
          return this._ok(request, this.fileManager.readWorkspaceFile(String(request.args.path ?? '')) ?? '');
        case 'search': {
          const results = await this.search.search(String(request.args.query ?? ''), {
            maxResults: Number(request.args.maxResults ?? 20),
          });
          return this._ok(request, JSON.stringify(results, null, 2));
        }
        case 'run_command': {
          const result = await this.terminal.runSafeCommand(
            String(request.args.command ?? ''),
            Number(request.args.timeoutMs ?? 120_000)
          );
          return this._ok(request, JSON.stringify(result, null, 2));
        }
        case 'apply_patch': {
          const path = String(request.args.path ?? '');
          const patch = String(request.args.patch ?? '');
          this.patchService.parse(patch, path);
          return this._ok(
            request,
            'Patch parsed successfully. For safety, include this patch in the final files array so the orchestrator can validate allowedFiles, baselines, approval policy, and audit logs before applying it.'
          );
        }
        case 'fetch_url': {
          const result = await this.webFetcher.fetchUrl(String(request.args.url ?? ''));
          return result.success ? this._ok(request, result.text) : this._fail(request, result.error ?? 'Fetch failed.');
        }
        default:
          return this._fail(request, `Unknown tool: ${request.name}`);
      }
    } catch (err) {
      return this._fail(request, err instanceof Error ? err.message : String(err));
    }
  }

  private _ok(request: ToolCallRequest, output: string): ToolCallResult {
    return {
      id: request.id,
      name: request.name,
      success: true,
      output,
    };
  }

  private _fail(request: ToolCallRequest, error: string): ToolCallResult {
    return {
      id: request.id,
      name: request.name,
      success: false,
      output: '',
      error,
    };
  }
}
