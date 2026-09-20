/** repositoryInstructions IPC DTOs. Kept separate for generated Rust binding integration. */

export interface RepositoryInstructionProjectInputDto {
  projectId: string;
  projectName: string;
  rootPath: string;
  scopePath?: string | null;
}

export interface RepositoryInstructionSourceDto {
  projectId: string;
  projectName: string;
  sourcePath: string;
  relativePath: string;
  depth: number;
  sizeBytes: number;
  content: string;
}

export interface RepositoryInstructionIssueDto {
  projectId: string;
  code: string;
  sourcePath?: string | null;
  message: string;
}

export interface RepositoryInstructionLoadResultDto {
  sources: RepositoryInstructionSourceDto[];
  issues: RepositoryInstructionIssueDto[];
  totalBytes: number;
  fileLimit: number;
  byteLimit: number;
}
