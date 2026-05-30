import * as fs from 'fs';
import * as path from 'path';
import type { SkillConfig, SkillDescriptor, SkillMatch } from '../types';

export class SkillManager {
  constructor(
    private readonly workspaceRoot: string,
    private readonly config?: Partial<SkillConfig>
  ) {}

  discoverSkills(): SkillDescriptor[] {
    const cfg = {
      enabled: true,
      skillDirs: ['.agent-workspace/skills', 'skills'],
      ...this.config,
    };
    if (!cfg.enabled) { return []; }

    const skills: SkillDescriptor[] = [];
    for (const skillDir of cfg.skillDirs) {
      const fullDir = path.isAbsolute(skillDir) ? skillDir : path.join(this.workspaceRoot, skillDir);
      this._scanSkillDir(fullDir, skills);
    }
    return skills;
  }

  match(prompt: string, maxMatches = 3): SkillMatch[] {
    const lowerPrompt = prompt.toLowerCase();
    return this.discoverSkills()
      .map(skill => {
        const matchedTriggers = skill.triggers.filter(trigger => lowerPrompt.includes(trigger.toLowerCase()));
        const nameWords = skill.name.split(/[-_\s]+/).filter(Boolean);
        const nameHits = nameWords.filter(word => lowerPrompt.includes(word.toLowerCase()));
        const score = matchedTriggers.length * 3 + nameHits.length;
        return { skill, score, matchedTriggers };
      })
      .filter(match => match.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxMatches);
  }

  readSkillContext(matches: SkillMatch[], maxChars = 12_000): string {
    const sections: string[] = [];
    let remaining = maxChars;
    for (const match of matches) {
      if (remaining <= 0) { break; }
      let raw = '';
      try { raw = fs.readFileSync(match.skill.path, 'utf8'); } catch { continue; }
      const excerpt = raw.length > remaining ? raw.slice(0, remaining) : raw;
      sections.push(
        `## Skill: ${match.skill.name}`,
        `Path: ${match.skill.path}`,
        `Matched triggers: ${match.matchedTriggers.join(', ') || 'name match'}`,
        '',
        excerpt
      );
      remaining -= excerpt.length;
    }
    return sections.length > 0 ? ['# Matched Local Skills', '', ...sections].join('\n') : '';
  }

  private _scanSkillDir(dir: string, skills: SkillDescriptor[]): void {
    if (!fs.existsSync(dir)) { return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      const skillPath = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) { continue; }
      const descriptor = this._readSkill(skillPath, entry.name);
      if (descriptor) {
        skills.push(descriptor);
      }
    }
  }

  private _readSkill(skillPath: string, fallbackName: string): SkillDescriptor | null {
    let raw: string;
    try { raw = fs.readFileSync(skillPath, 'utf8'); } catch { return null; }
    const firstHeading = /^#\s+(.+)$/m.exec(raw)?.[1]?.trim();
    const description =
      /^description:\s*(.+)$/mi.exec(raw)?.[1]?.trim()
      ?? raw.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'))?.trim()
      ?? '';
    const triggerLine = /^triggers?:\s*(.+)$/mi.exec(raw)?.[1]?.trim();
    const triggers = triggerLine
      ? triggerLine.split(',').map(item => item.trim()).filter(Boolean)
      : [fallbackName, ...(description.match(/[A-Za-z0-9_-]{4,}/g) ?? []).slice(0, 8)];

    return {
      name: firstHeading ?? fallbackName,
      path: skillPath,
      description,
      triggers,
    };
  }
}
