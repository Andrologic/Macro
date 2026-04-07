use git2::{Repository, DiffFormat, DiffOptions};

fn main() {
    let repo = Repository::open("/Users/oscarlahaie/github/Macro").unwrap();
    let mut opts = DiffOptions::new();
    let diff = repo.diff_index_to_workdir(None, Some(&mut opts)).unwrap();
    diff.print(DiffFormat::Patch, |_, _, line| {
        let origin = line.origin();
        println!("Origin: '{}' ({:?})", origin, origin as u32);
        println!("Content string: {:?}", std::str::from_utf8(line.content()).unwrap());
        true
    }).unwrap();
}
