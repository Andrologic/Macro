//! Test-only private proof files. This per-file logical disk allowance is not
//! a production quota, native E charge, free-space guarantee or physical usage.
use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    path::Path,
};
const PROOF_FILE_BYTES: u64 = 128 * 1024 * 1024;
pub(crate) struct ProofWriter {
    file: File,
    remaining: u64,
}
impl Write for ProofWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            return Err(io::Error::new(io::ErrorKind::Other, "proof_file_allowance"));
        }
        let written = self.file.write(bytes)?;
        self.remaining -= written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}
pub(crate) fn private_file(path: &Path) -> ProofWriter {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    ProofWriter {
        file: options.open(path).unwrap(),
        remaining: PROOF_FILE_BYTES,
    }
}
#[test]
fn proof_disk_allowance_refuses_before_file_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("proof");
    let mut writer = private_file(&path);
    writer.remaining = 3;
    assert_eq!(
        writer.write(b"four").unwrap_err().to_string(),
        "proof_file_allowance"
    );
    assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
    writer.write_all(b"one").unwrap();
    writer.flush().unwrap();
    assert!(writer.write(b"x").is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"one");
}
