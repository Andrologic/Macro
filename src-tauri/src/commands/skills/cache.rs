use super::*;
use std::sync::{OnceLock, RwLock};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SkillCatalogCacheKey {
    project_roots: Vec<(String, String, String)>,
    home_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PathSignature {
    path: String,
    exists: bool,
    is_dir: bool,
    is_file: bool,
    len: u64,
    modified_nanos: Option<u128>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillCatalogSignature {
    search_roots: Vec<PathSignature>,
    skill_files: Vec<PathSignature>,
    resource_dirs: Vec<PathSignature>,
}

#[derive(Debug, Clone)]
pub(super) struct SkillCatalog {
    pub(super) skills: Vec<SkillManifestDto>,
    pub(super) skills_by_id: HashMap<String, SkillManifestDto>,
    signature: SkillCatalogSignature,
}

static SKILL_CATALOG_CACHE: OnceLock<RwLock<HashMap<SkillCatalogCacheKey, SkillCatalog>>> =
    OnceLock::new();

fn normalized_path_string(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

fn catalog_cache_key(project_roots: &[SkillProjectRootDto]) -> SkillCatalogCacheKey {
    let mut roots = project_roots
        .iter()
        .map(|project| {
            (
                project.project_id.clone(),
                project.project_name.clone(),
                normalized_path_string(Path::new(&project.path)),
            )
        })
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();

    SkillCatalogCacheKey {
        project_roots: roots,
        home_path: home_dir().map(|home| normalized_path_string(&home)),
    }
}

fn catalog_search_root_paths(project_roots: &[SkillProjectRootDto]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for project in project_roots {
        let project_path = PathBuf::from(&project.path);
        roots.extend(
            project_skill_search_roots(&project_path)
                .into_iter()
                .map(|root| root.path),
        );
    }
    if let Some(home) = home_dir() {
        roots.extend(
            global_skill_search_roots(&home)
                .into_iter()
                .map(|root| root.path),
        );
    }
    roots.sort();
    roots.dedup();
    roots
}

fn path_signature(path: &Path) -> PathSignature {
    let normalized = normalized_path_string(path);
    match fs::symlink_metadata(path) {
        Ok(metadata) => PathSignature {
            path: normalized,
            exists: true,
            is_dir: metadata.is_dir(),
            is_file: metadata.is_file(),
            len: metadata.len(),
            modified_nanos: metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos()),
        },
        Err(_) => PathSignature {
            path: normalized,
            exists: false,
            is_dir: false,
            is_file: false,
            len: 0,
            modified_nanos: None,
        },
    }
}

fn catalog_signature(
    project_roots: &[SkillProjectRootDto],
    skills: &[SkillManifestDto],
) -> SkillCatalogSignature {
    let mut search_roots = catalog_search_root_paths(project_roots)
        .iter()
        .map(|path| path_signature(path))
        .collect::<Vec<_>>();
    search_roots.sort_by(|a, b| a.path.cmp(&b.path));
    search_roots.dedup_by(|a, b| a.path == b.path);

    let mut skill_files = skills
        .iter()
        .map(|skill| path_signature(Path::new(&skill.skill_file_path)))
        .collect::<Vec<_>>();
    skill_files.sort_by(|a, b| a.path.cmp(&b.path));
    skill_files.dedup_by(|a, b| a.path == b.path);

    let mut resource_dirs = skills
        .iter()
        .flat_map(|skill| {
            ["references", "assets", "scripts"]
                .into_iter()
                .map(|dirname| PathBuf::from(&skill.root_path).join(dirname))
                .collect::<Vec<_>>()
        })
        .map(|path| path_signature(&path))
        .collect::<Vec<_>>();
    resource_dirs.sort_by(|a, b| a.path.cmp(&b.path));
    resource_dirs.dedup_by(|a, b| a.path == b.path);

    SkillCatalogSignature {
        search_roots,
        skill_files,
        resource_dirs,
    }
}

fn build_skill_catalog(project_roots: &[SkillProjectRootDto]) -> SkillCatalog {
    let skills = discover_skills(project_roots);
    let skills_by_id = skills
        .iter()
        .map(|skill| (skill.id.clone(), skill.clone()))
        .collect::<HashMap<_, _>>();
    let signature = catalog_signature(project_roots, &skills);
    SkillCatalog {
        skills,
        skills_by_id,
        signature,
    }
}

fn cached_catalog_is_fresh(catalog: &SkillCatalog, project_roots: &[SkillProjectRootDto]) -> bool {
    catalog.signature == catalog_signature(project_roots, &catalog.skills)
}

pub(super) fn load_skill_catalog(
    project_roots: &[SkillProjectRootDto],
    refresh: bool,
) -> SkillCatalog {
    let key = catalog_cache_key(project_roots);
    let cache = SKILL_CATALOG_CACHE.get_or_init(|| RwLock::new(HashMap::new()));

    if !refresh {
        if let Ok(cache_guard) = cache.read() {
            if let Some(catalog) = cache_guard.get(&key) {
                if cached_catalog_is_fresh(catalog, project_roots) {
                    return catalog.clone();
                }
            }
        }
    }

    let catalog = build_skill_catalog(project_roots);
    if let Ok(mut cache_guard) = cache.write() {
        cache_guard.insert(key, catalog.clone());
    }
    catalog
}
