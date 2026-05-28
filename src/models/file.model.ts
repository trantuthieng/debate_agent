/**
 * Represents an individual file in the generated application.
 * Contains the file path, content, and programming language.
 */
export interface FileModel {
  /** The relative path of the file within the application */
  filePath: string;

  /** The content of the file */
  fileContent: string;

  /** The programming language of the file */
  programmingLanguage: string;
}