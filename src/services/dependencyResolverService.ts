// src/services/dependencyResolverService.ts
import type { GeneratedApp } from '../models';

/**
 * Dependency detection rules mapping file patterns to package names.
 * Each rule specifies:
 * - patterns: array of strings to search for in file content or language
 * - package: the npm package name to install
 */
const DEPENDENCY_RULES = [
  {
    patterns: ['react', 'tsx', 'jsx'],
    package: 'react'
  },
  {
    patterns: ['react', 'tsx', 'jsx'],
    package: 'react-dom'
  },
  {
    patterns: ['express'],
    package: 'express'
  }
];

export class DependencyResolverService {
  /**
   * Resolves dependencies for a generated application by analyzing file content and languages.
   * Returns a unique list of package names that should be installed.
   * 
   * @param app - The generated application containing files to analyze
   * @returns Promise resolving to array of dependency package names
   */
  async resolveDependencies(app: GeneratedApp): Promise<string[]> {
    const dependencies = new Set<string>();

    // Check each file against all dependency rules
    for (const file of app.files) {
      this.checkFileAgainstRules(file, dependencies);
    }

    return Array.from(dependencies);
  }

  /**
   * Checks a single file against all dependency rules and adds matching packages to the set.
   * 
   * @param file - The file to analyze
   * @param dependencies - Set to accumulate found dependencies
   */
  private checkFileAgainstRules(file: any, dependencies: Set<string>): void {
    for (const rule of DEPENDENCY_RULES) {
      const matchesPattern = rule.patterns.some(pattern =>
        file.content.includes(pattern) || file.language === pattern
      );

      if (matchesPattern) {
        dependencies.add(rule.package);
      }
    }
  }
}
