//! Shared, editable thread titles stored as NIP-AR artifacts (kind 45010).
//!
//! Convention (client-defined; the relay treats it as opaque):
//! - `type` = [`THREAD_TITLE_TYPE`]
//! - `d` = UUIDv5([`THREAD_TITLE_NAMESPACE`], thread root event id as lowercase hex),
//!   so every client derives the same identity and a thread has at most one title
//! - `h` = channel, `root` = thread root, `title` = the title
//! - `content` = the title again, because relay search indexes `content`, not tags
//!
//! The relay enforces permissions (same as posting in the channel) and
//! compare-and-swap ordering through `prev`; clearing is a soft `delete`, and
//! setting a cleared title is a `restore`.

use nostr::{EventBuilder, Kind, Tag};
use uuid::Uuid;

use crate::client::{normalize_write_response, BuzzClient};
use crate::error::CliError;
use crate::validate::{parse_uuid, validate_hex64};

/// Artifact type for thread titles. Outside `buzz.*`, which NIP-AR reserves
/// for published Buzz client contracts.
pub const THREAD_TITLE_TYPE: &str = "matrixsi.thread-title";

/// Namespace for deriving a thread title's artifact id from its root event id.
pub const THREAD_TITLE_NAMESPACE: Uuid = uuid::uuid!("2039f9bf-c754-483e-a7cf-56f1ec0e4abe");

const KIND_ARTIFACT: u16 = 45010;
const MAX_TITLE_BYTES: usize = 512;
/// Concurrent edits surface as head conflicts; re-read and retry this many times.
const MAX_WRITE_ATTEMPTS: usize = 3;

/// Derive the artifact id (`d`) for a thread root.
pub fn thread_title_id(root_event_id: &str) -> Uuid {
    Uuid::new_v5(
        &THREAD_TITLE_NAMESPACE,
        root_event_id.to_ascii_lowercase().as_bytes(),
    )
}

fn validate_title(title: &str) -> Result<String, CliError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(CliError::Usage(
            "title must not be blank (use `threads title clear` to remove it)".into(),
        ));
    }
    if title.len() > MAX_TITLE_BYTES {
        return Err(CliError::Usage(format!(
            "title is {} bytes; the limit is {MAX_TITLE_BYTES} UTF-8 bytes",
            title.len()
        )));
    }
    Ok(title.to_string())
}

fn tag_value<'a>(event: &'a serde_json::Value, name: &str) -> Option<&'a str> {
    event
        .get("tags")?
        .as_array()?
        .iter()
        .filter_map(|t| t.as_array())
        .find(|t| t.first().and_then(|v| v.as_str()) == Some(name))
        .and_then(|t| t.get(1))
        .and_then(|v| v.as_str())
}

/// The artifact's current accepted revision, as seen by this reader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub event_id: String,
    pub deleted: bool,
    pub title: Option<String>,
}

fn head_from_event(event: &serde_json::Value) -> Option<Head> {
    let event_id = event.get("id")?.as_str()?.to_string();
    Some(Head {
        event_id,
        deleted: tag_value(event, "op") == Some("delete"),
        title: tag_value(event, "title").map(str::to_string),
    })
}

/// Pick the head of a revision history: the revision no other revision names
/// in `prev`. Redaction can hide a link and leave several candidates; the
/// newest wins, and the relay's `prev` check rejects the write if it is stale.
pub fn select_head(revisions: &[serde_json::Value]) -> Option<Head> {
    let superseded: std::collections::HashSet<&str> = revisions
        .iter()
        .filter_map(|e| tag_value(e, "prev"))
        .collect();
    revisions
        .iter()
        .filter(|e| {
            e.get("id")
                .and_then(|v| v.as_str())
                .is_some_and(|id| !superseded.contains(id))
        })
        .max_by_key(|e| e.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0))
        .and_then(head_from_event)
}

/// What a write must do, given the current head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    Create,
    Update {
        prev: String,
    },
    Restore {
        prev: String,
    },
    Delete {
        prev: String,
    },
    /// Already in the requested state.
    Unchanged,
}

/// `desired = None` clears the title.
pub fn plan(head: Option<&Head>, desired: Option<&str>) -> Plan {
    match (head, desired) {
        (None, Some(_)) => Plan::Create,
        (None, None) => Plan::Unchanged,
        (Some(h), None) if h.deleted => Plan::Unchanged,
        (Some(h), None) => Plan::Delete {
            prev: h.event_id.clone(),
        },
        (Some(h), Some(_)) if h.deleted => Plan::Restore {
            prev: h.event_id.clone(),
        },
        (Some(h), Some(t)) if h.title.as_deref() == Some(t) => Plan::Unchanged,
        (Some(h), Some(_)) => Plan::Update {
            prev: h.event_id.clone(),
        },
    }
}

fn op_name(plan: &Plan) -> &'static str {
    match plan {
        Plan::Create => "create",
        Plan::Update { .. } => "update",
        Plan::Restore { .. } => "restore",
        Plan::Delete { .. } => "delete",
        Plan::Unchanged => "unchanged",
    }
}

/// Build the revision for `plan`. Returns `None` for [`Plan::Unchanged`].
pub fn build_revision(
    channel: Uuid,
    root: &str,
    plan: &Plan,
    title: Option<&str>,
) -> Result<Option<EventBuilder>, CliError> {
    let prev = match plan {
        Plan::Unchanged => return Ok(None),
        Plan::Create => None,
        Plan::Update { prev } | Plan::Restore { prev } | Plan::Delete { prev } => {
            Some(prev.as_str())
        }
    };
    let id = thread_title_id(root).to_string();
    let channel = channel.to_string();
    let mut tags: Vec<[&str; 2]> = vec![
        ["ar", "1"],
        ["d", &id],
        ["h", &channel],
        ["type", THREAD_TITLE_TYPE],
        ["op", op_name(plan)],
        ["root", root],
    ];
    if let Some(prev) = prev {
        tags.push(["prev", prev]);
    }
    let content = if matches!(plan, Plan::Delete { .. }) {
        ""
    } else {
        let title = title.ok_or_else(|| CliError::Other("title required for this op".into()))?;
        tags.push(["title", title]);
        title
    };
    let tags = tags
        .into_iter()
        .map(|t| Tag::parse(t).map_err(|e| CliError::Other(format!("invalid tag: {e}"))))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(
        EventBuilder::new(Kind::Custom(KIND_ARTIFACT), content).tags(tags),
    ))
}

fn parse_events(raw: &str) -> Result<Vec<serde_json::Value>, CliError> {
    serde_json::from_str(raw)
        .map_err(|e| CliError::Other(format!("failed to parse artifact query response: {e}")))
}

/// Fetch the current head, including a deleted one (which `current` omits).
async fn fetch_head(client: &BuzzClient, id: Uuid) -> Result<Option<Head>, CliError> {
    let id = id.to_string();
    let current = parse_events(
        &client
            .query(&serde_json::json!({"artifact": "current", "#d": [id], "limit": 1}))
            .await?,
    )?;
    if let Some(event) = current.first() {
        return Ok(head_from_event(event));
    }
    let history = parse_events(
        &client
            .query(&serde_json::json!({"artifact": "history", "#d": [id], "limit": 1000}))
            .await?,
    )?;
    Ok(select_head(&history))
}

/// Resolve any message in a thread to the channel-checked thread root.
async fn resolve_root(client: &BuzzClient, channel: Uuid, event: &str) -> Result<String, CliError> {
    validate_hex64(event)?;
    let event = event.to_ascii_lowercase();
    let selected = super::messages::fetch_event(client, &event).await?;
    super::messages::resolve_thread_target(channel, &event, None, &selected)
}

fn is_head_conflict(err: &CliError) -> bool {
    matches!(err, CliError::Relay { status: 409, body }
        if body.contains("artifact head changed") || body.contains("artifact identity is taken"))
}

async fn write_title(
    client: &BuzzClient,
    channel: &str,
    event: &str,
    desired: Option<&str>,
) -> Result<(), CliError> {
    let channel = parse_uuid(channel)?;
    let root = resolve_root(client, channel, event).await?;
    let id = thread_title_id(&root);
    for attempt in 1..=MAX_WRITE_ATTEMPTS {
        let head = fetch_head(client, id).await?;
        let plan = plan(head.as_ref(), desired);
        let Some(builder) = build_revision(channel, &root, &plan, desired)? else {
            println!(
                "{}",
                serde_json::json!({
                    "event_id": head.map(|h| h.event_id),
                    "accepted": true,
                    "message": "unchanged",
                    "artifact": id.to_string(),
                    "root": root,
                })
            );
            return Ok(());
        };
        let signed = client.sign_event(builder)?;
        match client.submit_event(signed).await {
            Ok(resp) => {
                let mut out: serde_json::Value =
                    serde_json::from_str(&normalize_write_response(&resp))
                        .unwrap_or_else(|_| serde_json::json!({"raw": resp}));
                out["artifact"] = id.to_string().into();
                out["root"] = root.into();
                out["op"] = op_name(&plan).into();
                println!("{out}");
                return Ok(());
            }
            Err(e) if is_head_conflict(&e) && attempt < MAX_WRITE_ATTEMPTS => continue,
            Err(e) if is_head_conflict(&e) => {
                return Err(CliError::Conflict(format!(
                    "thread title for {root} kept changing during {MAX_WRITE_ATTEMPTS} attempts; re-run to apply"
                )))
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!("loop returns on its last attempt")
}

fn summarize(event: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "title": tag_value(event, "title"),
        "channel": tag_value(event, "h"),
        "root": tag_value(event, "root"),
        "artifact": tag_value(event, "d"),
        "revision": event.get("id"),
        "author": event.get("pubkey"),
        "updated_at": event.get("created_at"),
    })
}

async fn cmd_get(client: &BuzzClient, channel: &str, event: &str) -> Result<(), CliError> {
    let channel = parse_uuid(channel)?;
    let root = resolve_root(client, channel, event).await?;
    let id = thread_title_id(&root).to_string();
    let current = parse_events(
        &client
            .query(&serde_json::json!({"artifact": "current", "#d": [id], "limit": 1}))
            .await?,
    )?;
    let out = match current.first() {
        Some(event) if tag_value(event, "type") == Some(THREAD_TITLE_TYPE) => summarize(event),
        _ => {
            serde_json::json!({"title": null, "channel": channel.to_string(), "root": root, "artifact": id})
        }
    };
    println!("{out}");
    Ok(())
}

async fn cmd_list(client: &BuzzClient, channel: Option<&str>, limit: u32) -> Result<(), CliError> {
    let mut filter =
        serde_json::json!({"artifact": "current", "#type": [THREAD_TITLE_TYPE], "limit": limit});
    if let Some(channel) = channel {
        filter["#h"] = serde_json::json!([parse_uuid(channel)?.to_string()]);
    }
    let events = parse_events(&client.query(&filter).await?)?;
    let titles: Vec<_> = events.iter().map(summarize).collect();
    println!("{}", serde_json::Value::Array(titles));
    Ok(())
}

pub async fn dispatch(cmd: crate::ThreadsCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::{ThreadTitleCmd, ThreadsCmd};
    match cmd {
        ThreadsCmd::Title(sub) => match sub {
            ThreadTitleCmd::Set {
                channel,
                event,
                title,
            } => {
                let title = validate_title(&title)?;
                write_title(client, &channel, &event, Some(&title)).await
            }
            ThreadTitleCmd::Clear { channel, event } => {
                write_title(client, &channel, &event, None).await
            }
            ThreadTitleCmd::Get { channel, event } => cmd_get(client, &channel, &event).await,
            ThreadTitleCmd::List { channel, limit } => {
                cmd_list(client, channel.as_deref(), limit).await
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;
    use serde_json::json;

    const ROOT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn rev(
        id: &str,
        created_at: u64,
        op: &str,
        title: Option<&str>,
        prev: Option<&str>,
    ) -> serde_json::Value {
        let mut tags = vec![json!(["op", op])];
        if let Some(t) = title {
            tags.push(json!(["title", t]));
        }
        if let Some(p) = prev {
            tags.push(json!(["prev", p]));
        }
        json!({"id": id, "created_at": created_at, "tags": tags})
    }

    #[test]
    fn id_is_uuidv5_of_root_hex() {
        // Independently computed with Python's uuid.uuid5.
        assert_eq!(
            thread_title_id(ROOT).to_string(),
            "87145d70-befc-5aeb-8431-9fcbec2d2d75"
        );
        assert_eq!(thread_title_id(&ROOT.to_uppercase()), thread_title_id(ROOT));
    }

    #[test]
    fn head_follows_prev_chain_not_timestamps() {
        // The newest-looking event is superseded; chain order decides.
        let history = vec![
            rev("a", 100, "create", Some("one"), None),
            rev("b", 300, "update", Some("two"), Some("a")),
            rev("c", 200, "delete", None, Some("b")),
        ];
        let head = select_head(&history).unwrap();
        assert_eq!(head.event_id, "c");
        assert!(head.deleted);
        assert_eq!(select_head(&[]), None);
    }

    #[test]
    fn plan_covers_lifecycle() {
        let live = Head {
            event_id: "h".into(),
            deleted: false,
            title: Some("x".into()),
        };
        let gone = Head {
            event_id: "h".into(),
            deleted: true,
            title: None,
        };
        assert_eq!(plan(None, Some("x")), Plan::Create);
        assert_eq!(plan(None, None), Plan::Unchanged);
        assert_eq!(plan(Some(&live), Some("x")), Plan::Unchanged);
        assert_eq!(
            plan(Some(&live), Some("y")),
            Plan::Update { prev: "h".into() }
        );
        assert_eq!(plan(Some(&live), None), Plan::Delete { prev: "h".into() });
        assert_eq!(
            plan(Some(&gone), Some("y")),
            Plan::Restore { prev: "h".into() }
        );
        assert_eq!(plan(Some(&gone), None), Plan::Unchanged);
    }

    /// Every op this module emits must pass the relay's own envelope validator.
    #[test]
    fn revisions_pass_relay_validation() {
        let channel = Uuid::new_v4();
        let prev = "b".repeat(64);
        for (plan, title) in [
            (Plan::Create, Some("Release checklist")),
            (Plan::Update { prev: prev.clone() }, Some("Renamed")),
            (Plan::Restore { prev: prev.clone() }, Some("Back")),
            (Plan::Delete { prev: prev.clone() }, None),
        ] {
            let event = build_revision(channel, ROOT, &plan, title)
                .unwrap()
                .unwrap()
                .sign_with_keys(&Keys::generate())
                .unwrap();
            let env =
                buzz_core::artifact::validate(&event).unwrap_or_else(|e| panic!("{plan:?}: {e}"));
            assert_eq!(env.id, thread_title_id(ROOT));
            assert_eq!(env.home, channel);
            assert_eq!(env.artifact_type, THREAD_TITLE_TYPE);
            assert_eq!(env.root, Some(hex::decode(ROOT).unwrap()));
            assert_eq!(event.content, title.unwrap_or(""));
        }
        assert!(build_revision(channel, ROOT, &Plan::Unchanged, Some("x"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn title_validation() {
        assert_eq!(validate_title("  Spaced  ").unwrap(), "Spaced");
        assert!(matches!(validate_title("   "), Err(CliError::Usage(_))));
        assert!(validate_title(&"é".repeat(256)).is_ok()); // 512 bytes
        assert!(matches!(
            validate_title(&"é".repeat(257)),
            Err(CliError::Usage(_))
        ));
    }

    #[test]
    fn only_head_conflicts_retry() {
        let conflict = |body: &str| CliError::Relay {
            status: 409,
            body: body.into(),
        };
        assert!(is_head_conflict(&conflict(
            "conflict: artifact head changed"
        )));
        assert!(is_head_conflict(&conflict(
            "conflict: artifact identity is taken"
        )));
        assert!(!is_head_conflict(&conflict(
            "conflict: artifact home changed"
        )));
        assert!(!is_head_conflict(&CliError::Relay {
            status: 400,
            body: "artifact head changed".into()
        }));
    }
}
