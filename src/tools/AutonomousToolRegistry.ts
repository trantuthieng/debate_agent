import type { ToolCallRequest, ToolCallResult, ToolDefinition } from '../types';
import { FileManager } from '../workspace/FileManager';
import { SearchService } from '../services/searchService';
import { TerminalRunner } from '../terminal/TerminalRunner';
import { PatchService } from '../services/patchService';
import { WebFetcherService } from '../services/webFetcherService';
import { ResearchService } from '../services/researchService';
import { AssetLibraryService } from '../services/assetLibraryService';
import type { ConnectorToolExecutor } from '../connectors/ConnectorManager';

export class AutonomousToolRegistry {
  constructor(
    private readonly fileManager: FileManager,
    private readonly search: SearchService,
    private readonly terminal: TerminalRunner,
    private readonly patchService: PatchService,
    private readonly webFetcher: WebFetcherService,
    /**
     * Asks the boss (or the configured ask-policy) to approve a command that the
     * safety policy flagged as risky. Resolves true to run it as an approved
     * command, false to decline. When omitted, risky commands are declined.
     */
    private readonly approveCommand?: (command: string, reason: string) => Promise<boolean>,
    /** Optional governed network research capability (web + public repos). */
    private readonly research?: ResearchService,
    private readonly connectors?: ConnectorToolExecutor,
    /** Optional governed visual-asset search/download capability (Openverse). */
    private readonly assetLibrary?: AssetLibraryService
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
      ...(this.research?.webEnabled
        ? [{
            name: 'web_search',
            description: 'Search the web and return cited, freshness-stamped findings for grounding decisions in current sources.',
            safe: false,
            inputSchema: { query: 'string' },
          } as ToolDefinition]
        : []),
      ...(this.research?.repoReadsEnabled
        ? [
            {
              name: 'find_code_examples',
              description: 'Discover relevant public GitHub repositories (ranked by stars) and pull their READMEs to learn from existing high-quality code. Returns cited findings.',
              safe: false,
              inputSchema: { query: 'string' },
            } as ToolDefinition,
            {
              name: 'read_repo_file',
              description: 'Read a specific source file from a public GitHub/GitLab repo (blob or raw URL). Returns the cited file contents.',
              safe: false,
              inputSchema: { url: 'string' },
            } as ToolDefinition,
          ]
        : []),
      ...(this.assetLibrary?.enabled
        ? [
            {
              name: 'search_image_assets',
              description: 'Search Openverse for openly-licensed images (game art, illustrations, photos) matching a query. Returns license, creator, and a direct image URL for each hit.',
              safe: false,
              inputSchema: { query: 'string' },
            } as ToolDefinition,
            {
              name: 'fetch_image_asset',
              description: 'Download one image found via search_image_assets into the workspace and record its license/attribution in ASSET_LICENSES.md.',
              safe: false,
              inputSchema: {
                imageUrl: 'string', destPath: 'string', title: 'string', creator: 'string',
                license: 'string', licenseVersion: 'string?', source: 'string?', foreignLandingUrl: 'string?',
              },
            } as ToolDefinition,
          ]
        : []),
      ...(this.connectors
        ? [
            { name: 'youtube_research', description: 'Research YouTube videos/channels with the configured API key.', safe: false, inputSchema: { query: 'string', maxResults: 'number?' } },
            { name: 'youtube_upload_draft', description: 'Queue an approved private YouTube draft upload.', safe: false, inputSchema: { videoPath: 'string', title: 'string', description: 'string?', tags: 'string[]?', musicRightsConfirmed: 'boolean', idempotencyKey: 'string?' } },
            { name: 'youtube_schedule', description: 'Queue an approved private upload with a publishAt schedule; requires auto-publish policy.', safe: false, inputSchema: { videoPath: 'string', title: 'string', publishAt: 'string', musicRightsConfirmed: 'boolean', idempotencyKey: 'string?' } },
            { name: 'youtube_thumbnail', description: 'Set a thumbnail on an uploaded YouTube video.', safe: false, inputSchema: { videoId: 'string', thumbnailPath: 'string', idempotencyKey: 'string?' } },
            { name: 'youtube_status', description: 'Read YouTube upload/processing status.', safe: false, inputSchema: { videoId: 'string', idempotencyKey: 'string?' } },
          ] as ToolDefinition[]
        : []),
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
          const command = String(request.args.command ?? '');
          const timeoutMs = Number(request.args.timeoutMs ?? 120_000);
          const decision = this.terminal.evaluateCommand(command);
          if (decision.risk === 'safe') {
            const result = await this.terminal.runSafeCommand(command, timeoutMs);
            return this._ok(request, JSON.stringify(result, null, 2));
          }
          // Risky command: ask the boss instead of silently failing. If no
          // approval handler is wired (or it declines), report a clear reason.
          const approved = this.approveCommand
            ? await this.approveCommand(command, decision.reason)
            : false;
          if (!approved) {
            return this._fail(
              request,
              `Command requires approval and was not approved (${decision.reason}): ${command}`
            );
          }
          const result = await this.terminal.runApprovedCommand(command, timeoutMs);
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
        case 'web_search': {
          if (!this.research?.webEnabled) { return this._fail(request, 'Web research is disabled in config.'); }
          const outcome = await this.research.webResearch(String(request.args.query ?? ''));
          return this._ok(request, ResearchService.format(outcome));
        }
        case 'find_code_examples': {
          if (!this.research?.repoReadsEnabled) { return this._fail(request, 'External repo research is disabled in config.'); }
          const outcome = await this.research.findCodeExamples(String(request.args.query ?? ''));
          return this._ok(request, ResearchService.format(outcome));
        }
        case 'read_repo_file': {
          if (!this.research?.repoReadsEnabled) { return this._fail(request, 'External repo reads are disabled in config.'); }
          const finding = await this.research.readRepoFile(String(request.args.url ?? ''));
          return 'error' in finding
            ? this._fail(request, finding.error)
            : this._ok(request, `Source: ${finding.source} (retrieved ${finding.retrievedAt})\n\n${finding.snippet}`);
        }
        case 'search_image_assets': {
          if (!this.assetLibrary?.enabled) { return this._fail(request, 'Asset library is disabled in config.'); }
          const outcome = await this.assetLibrary.searchImages(String(request.args.query ?? ''));
          return this._ok(request, JSON.stringify(outcome, null, 2));
        }
        case 'fetch_image_asset': {
          if (!this.assetLibrary?.enabled) { return this._fail(request, 'Asset library is disabled in config.'); }
          const result = await this.assetLibrary.fetchImage(
            String(request.args.imageUrl ?? ''),
            String(request.args.destPath ?? ''),
            {
              title: String(request.args.title ?? ''),
              creator: String(request.args.creator ?? 'unknown'),
              license: String(request.args.license ?? ''),
              licenseVersion: String(request.args.licenseVersion ?? ''),
              source: String(request.args.source ?? ''),
              foreignLandingUrl: String(request.args.foreignLandingUrl ?? ''),
            }
          );
          return result.success
            ? this._ok(request, JSON.stringify(result, null, 2))
            : this._fail(request, result.error ?? 'Image download failed.');
        }
        case 'youtube_research':
        case 'youtube_upload_draft':
        case 'youtube_schedule':
        case 'youtube_thumbnail':
        case 'youtube_status': {
          if (!this.connectors) { return this._fail(request, 'External connectors are not configured.'); }
          return this._ok(request, await this.connectors.executeTool(request.name, request.args, request.id));
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
