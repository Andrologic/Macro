const WSL_UNC_PREFIX_PATTERN = /^[/\\]{2}wsl(?:\$|\.localhost)[/\\][^/\\]+/i;

export const isWslProjectPath = (value?: string | null): boolean => {
  const normalized = value?.trim();
  return Boolean(normalized && WSL_UNC_PREFIX_PATTERN.test(normalized));
};

export const filterNonWslProjectPaths = (paths: string[]): string[] =>
  paths.filter((path) => !isWslProjectPath(path));
