# Architecture Plan

_Generated: 2026-05-28T14:13:40.938Z_

# Architecture Document

## Project Overview
This project is a VSCode extension that generates applications from user prompts. The extension is fully autonomous, requiring only a user prompt to generate a complete application.

## Technology Stack
- **Language**: TypeScript
- **Framework**: VSCode Extension API
- **Build Tool**: npm
- **Testing**: Jest
- **Linter**: ESLint
- **Formatter**: Prettier

## Project Structure
```
src/
├── extension.ts          # Main extension entry point
├── commands/
│   └── generateAppCommand.ts  # Command to generate app from prompt
├── models/
│   ├── prompt.model.ts   # Prompt model
│   ├── generatedApp.model.ts  # Generated app model
│   ├── file.model.ts     # File model
│   └── types.ts          # Type definitions
├── services/
│   ├── appGeneratorService.ts  # Core app generation logic
│   ├── templateMatcherService.ts  # Template matching logic
│   ├── codeGenerationService.ts  # Code generation logic
│   └── dependencyResolverService.ts  # Dependency resolution logic
├── utils/
│   ├── stringUtils.ts    # String utilities
│   ├── dateUtils.ts      # Date utilities
│   └── arrayUtils.ts     # Array utilities
├── templates/
│   ├── common/
│   │   └── header.ts     # Common header template
│   ├── components/
│   │   └── button.ts     # Button component template
│   ├── layouts/
│   │   └── main.ts       # Main layout template
│   └── index.ts          # Template index
test/
├── unit/
│   └── appGeneratorService.test.ts  # Unit tests for appGeneratorService
└── integration/
    └── appGeneratorService.test.ts  # Integration tests for appGeneratorService
```

## Key Data Models
1. **Prompt Model**: Defines the structure of user prompts.
2. **GeneratedApp Model**: Represents the generated application structure.
3. **File Model**: Defines the structure of files in the generated application.
4. **Types**: Contains shared type definitions.

## API Design
- **Command API**: `generateAppCommand` - Takes a user prompt and generates an application.
- **Service API**: `appGeneratorService` - Core service for generating applications.
- **Template API**: `templateMatcherService` - Matches templates to user prompts.
- **Code Generation API**: `codeGenerationService` - Generates code from templates.
- **Dependency Resolution API**: `dependencyResolverService` - Resolves dependencies for the generated application.

## Key Algorithms
1. **Template Matching Algorithm**: Matches user prompts to appropriate templates.
2. **Code Generation Algorithm**: Generates code from templates and user prompts.
3. **Dependency Resolution Algorithm**: Resolves and installs dependencies for the generated application.

## Assumptions
1. The project is version-controlled using Git.
2. The project has clear build and run instructions.
3. The project is modular enough for incremental improvements.
4. The project uses TypeScript and the VSCode Extension API.
5. The project uses npm for dependency management.
6. The project uses Jest for testing.
7. The project uses ESLint for linting and Prettier for formatting.

## Constraints
1. No major architectural overhaul is required.
2. No entirely new features not related to existing scope are to be added.
3. No migration to a different tech stack is required.
4. The project must maintain backward compatibility and existing functionality.

## Key Decisions
1. **Tech Stack**: TypeScript with VSCode Extension API.
2. **Project Structure**: Modular structure with clear separation of concerns.
3. **Data Models**: Prompt, GeneratedApp, File, and Types models.
4. **API Design**: Command, Service, Template, Code Generation, and Dependency Resolution APIs.
5. **Algorithms**: Template Matching, Code Generation, and Dependency Resolution algorithms.

## Missing Information
1. Specific details about the existing project's codebase and structure.
2. Current test coverage and performance baseline.
3. Documentation quality and current state.
4. Team expertise and constraints.

## Resolved Assumptions
1. The project is version-controlled using Git.
2. The project has clear build and run instructions.
3. The project is modular enough for incremental improvements.
4. The project uses TypeScript and the VSCode Extension API.
5. The project uses npm for dependency management.
6. The project uses Jest for testing.
7. The project uses ESLint for linting and Prettier for formatting.

```json
{
  "summary": "VSCode extension for generating applications from user prompts",
  "technology": ["TypeScript", "VSCode Extension API", "npm", "Jest", "ESLint", "Prettier"],
  "projectStructure": ["src/extension.ts", "src/commands/generateAppCommand.ts", "src/models/prompt.model.ts", "src/models/generatedApp.model.ts", "src/models/file.model.ts", "src/models/types.ts", "src/services/appGeneratorService.ts", "src/services/templateMatcherService.ts", "src/services/codeGenerationService.ts", "src/services/dependencyResolverService.ts", "src/utils/stringUtils.ts", "src/utils/dateUtils.ts", "src/utils/arrayUtils.ts", "src/templates/common/header.ts", "src/templates/components/button.ts", "src/templates/layouts/main.ts", "src/templates/index.ts", "test/unit/appGeneratorService.test.ts", "test/integration/appGeneratorService.test.ts"],
  "keyDecisions": ["Use TypeScript with VSCode Extension API", "Modular project structure with clear separation of concerns", "Prompt, GeneratedApp, File, and Types data models", "Command, Service, Template, Code Generation, and Dependency Resolution APIs", "Template Matching, Code Generation, and Dependency Resolution algorithms"],
  "constraints": ["No major architectural overhaul", "No entirely new features not related to existing scope", "No migration to a different tech stack", "Maintain backward compatibility and existing functionality"],
  "needUserInput": false,
  "questions": [],
  "readyToCode": true
}
```
