/**
 * Type definitions for the application generation system.
 * These types are used across multiple models and services to ensure type safety.
 */

/**
 * Represents a timestamp in ISO 8601 format.
 * Used for tracking when prompts or other events occur.
 * Example: "2024-01-01T00:00:00.000Z"
 */
export type Timestamp = string;

/**
 * Represents the status of a generated application or process.
 * Used to track the current state of operations.
 */
export type Status = 'pending' | 'generating' | 'completed' | 'failed' | 'cancelled';

/**
 * Represents the severity level of a message or error.
 * Used for logging and error reporting.
 */
export type Severity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

/**
 * Represents the type of a generated application.
 * Used to categorize different types of applications.
 */
export type AppType = 'web' | 'mobile' | 'desktop' | 'api' | 'library' | 'other';

/**
 * Represents the programming language used in a generated application.
 * Used for dependency resolution and code generation.
 */
export type Language = 
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'java'
  | 'csharp'
  | 'go'
  | 'rust'
  | 'php'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'dart'
  | 'other';

/**
 * Represents the framework or library used in a generated application.
 * Used for template matching and dependency resolution.
 */
export type Framework = string;

/**
 * Represents the operating system target for a generated application.
 * Used for platform-specific code generation.
 */
export type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web' | 'other';

/**
 * Represents the result of an operation that can succeed or fail.
 * Used for error handling and result propagation.
 */
export type Result<T> = {
  success: true;
  data: T;
} | {
  success: false;
  error: Error;
};

/**
 * Represents a key-value pair for configuration or metadata.
 * Used for flexible configuration options.
 */
export type ConfigEntry = {
  key: string;
  value: string | number | boolean;
};

/**
 * Represents a file path, either absolute or relative.
 * Used for file operations and path manipulation.
 */
export type FilePath = string;

/**
 * Represents a directory path, either absolute or relative.
 * Used for directory operations.
 */
export type DirectoryPath = string;

/**
 * Represents a version number in semantic versioning format.
 * Used for dependency management.
 */
export type Version = string;

/**
 * Represents a package dependency with version information.
 * Used for dependency resolution and package management.
 */
export type Dependency = {
  name: string;
  version: Version;
  optional?: boolean;
};

/**
 * Represents a template identifier for code generation.
 * Used for template matching and selection.
 */
export type TemplateId = string;

/**
 * Represents a unique identifier for any entity in the system.
 * Used for tracking and referencing entities.
 */
export type Id = string;

/**
 * Represents a user-defined tag for categorization.
 * Used for organizing and filtering entities.
 */
export type Tag = string;

/**
 * Represents a pagination cursor for paginated results.
 * Used for pagination in APIs and data fetching.
 */
export type Cursor = string;

/**
 * Represents a range of values, typically used for pagination.
 * Used for limiting and offsetting results.
 */
export type Range = {
  limit: number;
  offset?: number;
};
