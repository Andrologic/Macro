import type { ProjectLocation, ProjectView } from "../ipc/architectLibrary";

/** Translate an assembled pointer into its authored file and local pointer. */
export function projectLocation(view: ProjectView, pointer: string): ProjectLocation {
  const origins = view.projection?.origins ?? {};
  for (let path = pointer; path; path = path.slice(0, path.lastIndexOf("/"))) {
    if (!Object.hasOwn(origins, path)) continue;
    const origin = origins[path];
    return { file: origin.file, pointer: origin.pointer + pointer.slice(path.length) };
  }
  return { file: "agsdl.json", pointer };
}
