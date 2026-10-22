use super::allowlist::Family;
use super::{error, Result, BLOCK};
use sqlx::SqliteConnection;
use std::ffi::CString;

// No handle or pointer crosses an await. A probe closes before async quota
// admission; the second open reads only after rechecking type and length.
pub(super) async fn access(
    db: &mut SqliteConnection,
    family: Family,
    row: i64,
    tag: usize,
    offset: Option<i64>,
    expected: Option<i64>,
    #[cfg(test)] stats: &ReadStats,
) -> Result<(i64, Vec<u8>)> {
    let table = CString::new(family.table).unwrap();
    let column = CString::new(family.columns[tag]).unwrap();
    let mut handle = db.lock_handle().await.map_err(error)?;
    let mut blob = std::ptr::null_mut();
    let opened = unsafe {
        libsqlite3_sys::sqlite3_blob_open(
            handle.as_raw_handle().as_ptr(),
            c"main".as_ptr(),
            table.as_ptr(),
            column.as_ptr(),
            row,
            0,
            &mut blob,
        )
    };
    if opened != libsqlite3_sys::SQLITE_OK {
        if !blob.is_null() {
            unsafe { libsqlite3_sys::sqlite3_blob_close(blob) };
        }
        return Err("source_blob_unavailable".into());
    }
    let total = unsafe { libsqlite3_sys::sqlite3_blob_bytes(blob) } as i64;
    let result: Result<Vec<u8>> = (|| {
        if expected.is_some_and(|n| n != total) {
            return Err("stale_revision".into());
        }
        let Some(offset) = offset else {
            return Ok(Vec::new());
        };
        if offset < 0 || offset > total || offset > i32::MAX as i64 {
            return Err("invalid_offset".into());
        }
        let mut data = vec![0; (total - offset).min(BLOCK as i64) as usize];
        if unsafe {
            libsqlite3_sys::sqlite3_blob_read(
                blob,
                data.as_mut_ptr().cast(),
                data.len() as i32,
                offset as i32,
            )
        } != libsqlite3_sys::SQLITE_OK
        {
            return Err("source_blob_unavailable".into());
        }
        #[cfg(test)]
        {
            use std::sync::atomic::Ordering;
            stats.calls.fetch_add(1, Ordering::Relaxed);
            stats.bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
            stats.max.fetch_max(data.len() as u64, Ordering::Relaxed);
        }
        Ok(data)
    })();
    let closed = unsafe { libsqlite3_sys::sqlite3_blob_close(blob) };
    if closed != libsqlite3_sys::SQLITE_OK {
        return Err("source_blob_unavailable".into());
    }
    Ok((total, result?))
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct ReadStats {
    pub calls: std::sync::atomic::AtomicU64,
    pub bytes: std::sync::atomic::AtomicU64,
    pub max: std::sync::atomic::AtomicU64,
}
