//! Two bounded staging slots. The account itself is the only publication point.
//! Callers serialize the whole operation with SecretsState's lock.
use super::{chunk_account, digest, parse_head, Head, Items, HEAD, MAX_CHUNKS};

fn account(base: &str, slot: u8, index: usize) -> String {
    format!("{base}:gen:{slot}:{index}")
}

pub(super) fn read(
    items: &mut impl Items,
    base: &str,
    slot: u8,
    count: usize,
    digest: &str,
) -> Result<Option<String>, String> {
    let chunks = (0..count)
        .map(|i| items.get(&account(base, slot, i)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(super::join_value(digest, "", chunks))
}

fn retire(items: &mut impl Items, key: &str) {
    // Publication has already succeeded. Cleanup cannot turn it into a failed save.
    if let Err(error) = items.delete(key) {
        log::warn!("secrets: could not retire an unused item: {error}");
    }
}

pub(super) fn write(
    items: &mut impl Items,
    base: &str,
    value: &str,
    chunks: &[String],
) -> Result<(), String> {
    let previous = items.get(base)?;
    let old = previous.as_deref().map(parse_head);
    if chunks.len() == 1 && matches!(parse_head(&chunks[0]), Head::Whole) {
        // A plain value still uses the legacy single-item layout.
        items.set(base, &chunks[0])?;
    } else {
        let slot = match old {
            Some(Head::Generation { slot, .. }) => 1 - slot,
            _ => 0,
        };
        // split_value has already bounded the value and preserved UTF-16 boundaries.
        // Its legacy inline head is metadata; stage only the first chunk's data.
        let Head::Split { data, .. } = parse_head(&chunks[0]) else {
            return Err("secrets: invalid staged value".into());
        };
        for (index, chunk) in chunks.iter().enumerate() {
            items.set(
                &account(base, slot, index),
                if index == 0 { data } else { chunk },
            )?;
        }
        // Credential Manager replaces this single item atomically. Until it succeeds,
        // every read still names the untouched previous generation (or legacy record).
        items.set(
            base,
            &format!("{HEAD}g:{slot}:{}:{}", chunks.len(), digest(value)),
        )?;
    }
    match old {
        Some(Head::Generation { slot, count, .. }) => {
            for i in 0..count {
                retire(items, &account(base, slot, i));
            }
        }
        Some(Head::Split { count, .. }) => {
            for i in 1..count {
                retire(items, &chunk_account(base, i));
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn delete(items: &mut impl Items, base: &str) -> Result<(), String> {
    // A failed head deletion preserves the entire readable value. Once removed,
    // failed cleanup must never make the caller keep using its cached credential.
    items.delete(base)?;
    for slot in 0..2 {
        for i in 0..MAX_CHUNKS {
            retire(items, &account(base, slot, i));
        }
    }
    // Include interrupted legacy writes and staging attempts, including gaps.
    for i in 1..MAX_CHUNKS {
        retire(items, &chunk_account(base, i));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::secrets::{
        delete_value, read_value, split_value, write_value, MAX_VALUE_BYTES,
    };
    use std::collections::HashMap;

    const WINDOWS: Option<usize> = Some(1280);
    #[derive(Clone, Default)]
    struct Memory {
        data: HashMap<String, String>,
        writes: usize,
        fail_write: Option<usize>,
        fail_delete: Option<String>,
    }
    impl Items for Memory {
        fn get(&mut self, key: &str) -> Result<Option<String>, String> {
            Ok(self.data.get(key).cloned())
        }
        fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
            self.writes += 1;
            if self.fail_write == Some(self.writes) {
                return Err("injected write failure".into());
            }
            self.data.insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&mut self, key: &str) -> Result<(), String> {
            if self
                .fail_delete
                .as_deref()
                .is_some_and(|k| k == "*" || k == key)
            {
                return Err("injected deletion failure".into());
            }
            self.data.remove(key);
            Ok(())
        }
    }
    fn legacy(value: &str) -> Memory {
        let mut items = Memory::default();
        for (i, chunk) in split_value(value, WINDOWS).unwrap().iter().enumerate() {
            items.data.insert(
                if i == 0 {
                    "key".into()
                } else {
                    chunk_account("key", i)
                },
                chunk.clone(),
            );
        }
        items
    }

    #[test]
    fn every_failed_staging_or_publication_write_preserves_the_previous_value() {
        for old in [
            "short".into(),
            "old".repeat(2000),
            format!("{HEAD}g:0:2:fake"),
        ] {
            for mut initial in [legacy(&old), Memory::default()] {
                if initial.data.is_empty() {
                    write_value(&mut initial, "key", &old, WINDOWS).unwrap();
                }
                for new in ["new-short".into(), "new".repeat(3000), "🔑".repeat(4000)] {
                    let mut successful = initial.clone();
                    successful.writes = 0;
                    write_value(&mut successful, "key", &new, WINDOWS).unwrap();
                    assert_eq!(
                        read_value(&mut successful, "key").unwrap(),
                        Some(new.clone())
                    );
                    for failure in 1..=successful.writes {
                        let mut failed = initial.clone();
                        failed.writes = 0;
                        failed.fail_write = Some(failure);
                        assert!(write_value(&mut failed, "key", &new, WINDOWS).is_err());
                        assert_eq!(
                            read_value(&mut failed, "key").unwrap(),
                            Some(old.clone()),
                            "write {failure}"
                        );
                        failed.fail_write = None;
                        write_value(&mut failed, "key", &new, WINDOWS).unwrap();
                        assert_eq!(read_value(&mut failed, "key").unwrap(), Some(new.clone()));
                    }
                }
            }
        }
    }

    #[test]
    fn legacy_reads_do_not_migrate_and_successful_updates_retire_legacy_chunks() {
        let old = "old".repeat(3000);
        let mut items = legacy(&old);
        let before = items.data.clone();
        assert_eq!(read_value(&mut items, "key").unwrap(), Some(old));
        assert_eq!(items.data, before);
        for value in ["new".repeat(4000), "small".into(), "🔑".repeat(5000)] {
            write_value(&mut items, "key", &value, WINDOWS).unwrap();
            assert_eq!(read_value(&mut items, "key").unwrap(), Some(value));
            assert!(!items.data.contains_key("key:1"));
        }
        delete_value(&mut items, "key", WINDOWS).unwrap();
        assert!(items.data.is_empty());
    }

    #[test]
    fn cleanup_failures_do_not_undo_commits_or_allow_unbounded_orphan_growth() {
        let mut items = Memory {
            fail_delete: Some("*".into()),
            ..Default::default()
        };
        for i in 0..80 {
            let value = i.to_string().repeat(1500);
            write_value(&mut items, "key", &value, WINDOWS).unwrap();
            assert_eq!(read_value(&mut items, "key").unwrap(), Some(value));
            assert!(items.data.len() <= 1 + 2 * MAX_CHUNKS);
        }
        let before = read_value(&mut items, "key").unwrap();
        assert!(delete_value(&mut items, "key", WINDOWS).is_err());
        assert_eq!(read_value(&mut items, "key").unwrap(), before);
        items.fail_delete = Some(account("key", 0, 0));
        delete_value(&mut items, "key", WINDOWS).unwrap();
        assert_eq!(read_value(&mut items, "key").unwrap(), None);
        items.fail_delete = None;
        delete_value(&mut items, "key", WINDOWS).unwrap();
        assert!(items.data.is_empty());
    }

    #[test]
    fn interrupted_staging_and_gaps_are_bounded_and_removed_on_delete() {
        let mut items = Memory::default();
        for i in 1..=MAX_CHUNKS {
            items.writes = 0;
            items.fail_write = Some(i);
            let _ = write_value(&mut items, "key", &"x".repeat(MAX_VALUE_BYTES), WINDOWS);
        }
        items.fail_write = None;
        // A successful short replacement need not scan every abandoned staging item.
        write_value(&mut items, "key", "short", WINDOWS).unwrap();
        items.data.remove(&account("key", 0, 1));
        delete_value(&mut items, "key", WINDOWS).unwrap();
        assert!(items.data.is_empty());
    }

    #[test]
    fn missing_or_modified_generation_chunks_fail_closed() {
        let mut items = Memory::default();
        write_value(&mut items, "key", &"token".repeat(1500), WINDOWS).unwrap();
        items.data.insert(account("key", 0, 1), "wrong".into());
        assert_eq!(read_value(&mut items, "key").unwrap(), None);
        items.data.remove(&account("key", 0, 1));
        assert_eq!(read_value(&mut items, "key").unwrap(), None);
    }

    #[test]
    fn malformed_generation_pointers_never_address_other_accounts() {
        for bad in [
            "g:2:1:0123456789abcdef",
            "g:0:33:0123456789abcdef",
            "g:0:01:0123456789abcdef",
            "g:0:1:0123456789ABCDEF",
            "g:0:1:0123456789abcdef:extra",
            "g:../key:1:0123456789abcdef",
        ] {
            assert_eq!(parse_head(&format!("{HEAD}{bad}")), Head::Damaged);
        }
        for value in [format!("{HEAD}g:0:1:0123456789abcdef"), "🔑".repeat(8000)] {
            let mut items = Memory::default();
            write_value(&mut items, "key", &value, WINDOWS).unwrap();
            assert_eq!(read_value(&mut items, "key").unwrap(), Some(value));
            assert!(items
                .data
                .values()
                .all(|v| v.encode_utf16().count() <= 1280));
        }
    }
}
