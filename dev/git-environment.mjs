const REPOSITORY_LOCAL_GIT_VARIABLES = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);

export function withoutGitRepositoryEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !REPOSITORY_LOCAL_GIT_VARIABLES.has(key.toUpperCase()),
    ),
  );
}
