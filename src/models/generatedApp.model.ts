import type { FileModel } from './file.model';

/**
 * Represents a generated application structure.
 * Contains the application name, version, list of files, and dependencies.
 */
export interface GeneratedApp {
  /**
   * The name of the generated application
   * @example "my-application"
   */
  name: string;

  /**
   * The version of the generated application
   * @example "1.0.0"
   */
  version?: string;

  /**
   * The list of files in the generated application
   * @example [
   *   {
   *     path: "src/index.ts",
   *     content: "console.log('Hello, world!');"
   *   }
   * ]
   */
  files: FileModel[];

  /**
   * The list of dependencies required by the application
   * @example ["express", "typescript"]
   */
  dependencies: string[];
}
