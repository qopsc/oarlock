//! Compare a directory entry with a retained file without reading contents.
use cap_std::fs::Dir;
use std::{fs::File, io, path::Path};

pub(crate) fn entry_matches(directory: &Dir, name: &Path, file: &File) -> io::Result<bool> {
    let named = directory.symlink_metadata(name)?;
    let held = file.metadata()?;
    if !(named.is_file() && held.is_file() || named.is_dir() && held.is_dir()) {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        use std::os::unix::fs::MetadataExt as _;
        // The retained descriptor prevents inode reuse until it is closed.
        // lstat avoids following a substituted symlink or opening a FIFO,
        // and does not require read-data permission on the finished file.
        Ok(named.dev() == held.dev() && named.ino() == held.ino())
    }
    #[cfg(windows)]
    {
        use cap_std::fs::{OpenOptions, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        };
        let mut options = OpenOptions::new();
        options
            .access_mode(FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
        let named_file = directory.open_with(name, &options)?.into_std();
        let opened = named_file.metadata()?;
        if !(opened.is_file() && held.is_file() || opened.is_dir() && held.is_dir()) {
            return Ok(false);
        }
        Ok(super::document_save::version(&named_file, &[])?
            == super::document_save::version(file, &[])?)
    }
}
