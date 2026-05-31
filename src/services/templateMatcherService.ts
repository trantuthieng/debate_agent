// src/services/templateMatcherService.ts
import type { PromptModel } from '../models';

type TemplateRule = {
  keywords: string[];
  templateId: string;
};

export class TemplateMatcherService {
  private readonly templateRules: TemplateRule[] = [
    {
      keywords: ['finance', 'expense', 'asset', 'gold', 'stock', 'currency', 'thu chi', 'tai san', 'vang', 'chung khoan', 'ngoai te'],
      templateId: 'personal-finance-tracker',
    },
    {
      keywords: ['react'],
      templateId: 'react-app',
    },
    {
      keywords: ['cli', 'node'],
      templateId: 'node-cli',
    },
  ];

  async matchTemplate(prompt: PromptModel): Promise<string> {
    const content = prompt.content.trim().toLowerCase();
    if (!content) {
      return 'default-template';
    }

    for (const rule of this.templateRules) {
      if (rule.keywords.some((keyword) => content.includes(keyword))) {
        return rule.templateId;
      }
    }

    return 'default-template';
  }
}
