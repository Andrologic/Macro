import { useAppStore } from '../stores/useAppStore';
import { useGitStore } from '../stores/useGitStore';

/** The project registry owns cache identity, independently from mounted panels. */
export function startGitCacheComposition(): () => void {
  const projectPaths = (state: ReturnType<typeof useAppStore.getState>) => new Map([
    ...state.standaloneProjects,
    ...state.projectGroups.flatMap((group) => group.projects),
  ].map((project) => [project.id, project.path]));
  let previous = projectPaths(useAppStore.getState());
  let active = true;
  const unsubscribe = useAppStore.subscribe((state, old) => {
    if (!active || (state.standaloneProjects === old.standaloneProjects && state.projectGroups === old.projectGroups)) return;
    const next = projectPaths(state);
    for (const [id, path] of previous) {
      if (next.get(id) !== path) useGitStore.getState().invalidateProject(id);
    }
    previous = next;
  });
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    const state = useGitStore.getState();
    for (const id of new Set([...previous.keys(), ...Object.keys(state.trees), ...Object.keys(state.commitsByProject)])) {
      state.invalidateProject(id);
    }
  };
}
