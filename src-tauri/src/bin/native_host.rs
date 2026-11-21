use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const DEVELOPMENT_EXTENSION_ID: &str = "dpogajmenckmdbpacaoilnhhdcjpbheb";
const STORE_EXTENSION_ID: &str = "maenmnckhgckmkcaijmpeghkcfhchiha";
const TRUSTED_EXTENSION_IDS: [&str; 2] = [DEVELOPMENT_EXTENSION_ID, STORE_EXTENSION_ID];
const EXTENSION_STATUS_FILE: &str = ".extension-status";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    protocol_version: u32,
    request_id: String,
    #[serde(rename = "type")]
    message_type: String,
    payload: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<'a> {
    ok: bool,
    request_id: &'a str,
    accepted: bool,
    error: Option<String>,
}

fn queue_dir() -> Result<PathBuf, String> {
    if let Some(override_path) = env::var_os("CLIPCARGO_BRIDGE_ROOT") {
        return Ok(PathBuf::from(override_path));
    }
    let local = env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
    Ok(PathBuf::from(local)
        .join("net.clipcargo.desktop")
        .join("bridge-inbox"))
}

fn safe_request_id(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid request ID".into());
    }
    Ok(value)
}

fn persist(queue: &Path, envelope: &Envelope) -> Result<(), String> {
    if envelope.protocol_version != 1 {
        return Err("Unsupported protocol version".into());
    }
    if envelope.message_type == "bridge_status" {
        return persist_bridge_status(queue, envelope);
    }
    if envelope.message_type != "capture_page" {
        return Err("Unsupported message type".into());
    }
    let request_id = safe_request_id(&envelope.request_id)?;
    fs::create_dir_all(queue).map_err(|error| format!("Cannot create queue: {error}"))?;
    let final_path = queue.join(format!("{request_id}.json"));
    if final_path.exists() {
        return Ok(());
    }
    let temporary_path = queue.join(format!(".{request_id}.tmp"));
    let bytes =
        serde_json::to_vec(envelope).map_err(|error| format!("Cannot encode message: {error}"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|error| format!("Cannot create queued message: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("Cannot write queued message: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Cannot sync queued message: {error}"))?;
    fs::rename(&temporary_path, &final_path)
        .map_err(|error| format!("Cannot commit queued message: {error}"))?;
    Ok(())
}

fn persist_bridge_status(queue: &Path, envelope: &Envelope) -> Result<(), String> {
    let extension_id = envelope
        .payload
        .get("extensionId")
        .and_then(Value::as_str)
        .ok_or("Missing extension ID")?;
    if !TRUSTED_EXTENSION_IDS.contains(&extension_id) {
        return Err("Unexpected extension ID".into());
    }
    fs::create_dir_all(queue).map_err(|error| format!("Cannot create queue: {error}"))?;
    let received_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Cannot read system time: {error}"))?
        .as_secs();
    let status = serde_json::json!({
        "extensionId": extension_id,
        "version": envelope.payload.get("version").and_then(Value::as_str).unwrap_or(""),
        "receivedAt": received_at,
    });
    let final_path = queue.join(EXTENSION_STATUS_FILE);
    let temporary_path = queue.join(format!("{EXTENSION_STATUS_FILE}.tmp"));
    fs::write(
        &temporary_path,
        serde_json::to_vec(&status).map_err(|error| format!("Cannot encode status: {error}"))?,
    )
    .map_err(|error| format!("Cannot write status: {error}"))?;
    if final_path.exists() {
        fs::remove_file(&final_path).map_err(|error| format!("Cannot update status: {error}"))?;
    }
    fs::rename(&temporary_path, &final_path)
        .map_err(|error| format!("Cannot commit status: {error}"))?;
    Ok(())
}

fn read_message<R: Read>(reader: &mut R) -> Result<Option<Vec<u8>>, String> {
    let mut length = [0u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(format!("Cannot read message length: {error}")),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err("Message length is invalid".into());
    }
    let mut payload = vec![0u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| format!("Cannot read message: {error}"))?;
    Ok(Some(payload))
}

fn write_message<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), String> {
    let payload =
        serde_json::to_vec(value).map_err(|error| format!("Cannot encode response: {error}"))?;
    writer
        .write_all(&(payload.len() as u32).to_le_bytes())
        .and_then(|_| writer.write_all(&payload))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Cannot write response: {error}"))
}

fn main() {
    let queue = match queue_dir() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let Some(message) = read_message(&mut input).unwrap_or_else(|error| {
            eprintln!("{error}");
            None
        }) else {
            break;
        };
        let parsed = serde_json::from_slice::<Envelope>(&message);
        match parsed {
            Ok(envelope) => {
                let result = persist(&queue, &envelope);
                let response = Response {
                    ok: result.is_ok(),
                    request_id: &envelope.request_id,
                    accepted: result.is_ok(),
                    error: result.err(),
                };
                if let Err(error) = write_message(&mut output, &response) {
                    eprintln!("{error}");
                    break;
                }
            }
            Err(error) => {
                let response = Response {
                    ok: false,
                    request_id: "",
                    accepted: false,
                    error: Some(format!("Invalid JSON: {error}")),
                };
                let _ = write_message(&mut output, &response);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_safe_request_ids_only() {
        assert!(safe_request_id("abc-123_DEF").is_ok());
        assert!(safe_request_id("../escape").is_err());
    }

    #[test]
    fn chrome_frame_round_trip() {
        let mut bytes = Vec::new();
        write_message(&mut bytes, &serde_json::json!({"ok": true})).unwrap();
        let payload = read_message(&mut bytes.as_slice()).unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&payload).unwrap()["ok"],
            true
        );
    }

    #[test]
    fn records_only_trusted_extension_heartbeats() {
        let directory = std::env::temp_dir().join(format!(
            "clipcargo-native-status-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let valid = Envelope {
            protocol_version: 1,
            request_id: "status-1".into(),
            message_type: "bridge_status".into(),
            payload: serde_json::json!({"extensionId": DEVELOPMENT_EXTENSION_ID, "version": "0.1.0"}),
        };
        persist(&directory, &valid).unwrap();
        let status: Value =
            serde_json::from_slice(&fs::read(directory.join(EXTENSION_STATUS_FILE)).unwrap())
                .unwrap();
        assert_eq!(status["extensionId"], DEVELOPMENT_EXTENSION_ID);
        assert_eq!(status["version"], "0.1.0");

        let store = Envelope {
            protocol_version: 1,
            request_id: "status-2".into(),
            message_type: "bridge_status".into(),
            payload: serde_json::json!({"extensionId": STORE_EXTENSION_ID, "version": "0.1.4"}),
        };
        persist(&directory, &store).unwrap();
        let status: Value =
            serde_json::from_slice(&fs::read(directory.join(EXTENSION_STATUS_FILE)).unwrap())
                .unwrap();
        assert_eq!(status["extensionId"], STORE_EXTENSION_ID);

        let invalid = Envelope {
            payload: serde_json::json!({"extensionId": "abcdefghijklmnopabcdefghijklmnop", "version": "0.1.0"}),
            ..store
        };
        assert!(persist(&directory, &invalid).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
