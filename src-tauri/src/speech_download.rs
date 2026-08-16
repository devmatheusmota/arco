//! Downloading and removing speech models.
//!
//! Files land in a `.partial` sibling and are renamed only after the digest
//! matches, so an interrupted download never leaves a half file that looks
//! installed. A partial that already exists is resumed with a Range request
//! rather than restarted — the largest model here is 652 MB in one file.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::speech_catalog::{self, ModelFile, ModelSpec};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    pub id: String,
    pub label: String,
    pub description: String,
    pub language: String,
    pub streaming: bool,
    pub recommended: bool,
    pub size_bytes: u64,
    pub installed: bool,
    /// Bytes already on disk, counting a partial download.
    pub local_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: String,
    pub received: u64,
    pub total: u64,
    pub file: String,
    pub done: bool,
    pub error: Option<String>,
}

/// Where models live. Kept next to the app's own config so removing another app
/// cannot take the models with it.
pub fn models_root() -> Result<PathBuf, String> {
    let base = dirs_next::config_dir().ok_or_else(|| "no_config_dir".to_string())?;
    Ok(base.join("arco").join("speech-models"))
}

pub fn model_dir(id: &str) -> Result<PathBuf, String> {
    // The id comes from the catalogue, never from the caller, but a traversal
    // check costs nothing and this builds a filesystem path.
    if id.contains(['/', '\\']) || id.contains("..") {
        return Err("invalid_model_id".to_string());
    }
    Ok(models_root()?.join(id))
}

fn file_complete(path: &Path, expected: u64) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.len() == expected)
        .unwrap_or(false)
}

fn spec_installed(spec: &ModelSpec) -> bool {
    let Ok(dir) = model_dir(spec.id) else {
        return false;
    };
    spec.files
        .iter()
        .all(|file| file_complete(&dir.join(file.name), file.size_bytes))
}

fn spec_local_bytes(spec: &ModelSpec) -> u64 {
    let Ok(dir) = model_dir(spec.id) else {
        return 0;
    };
    spec.files
        .iter()
        .map(|file| {
            let complete = std::fs::metadata(dir.join(file.name))
                .map(|meta| meta.len())
                .unwrap_or(0);
            let partial = std::fs::metadata(dir.join(format!("{}.partial", file.name)))
                .map(|meta| meta.len())
                .unwrap_or(0);
            complete.max(partial)
        })
        .sum()
}

#[tauri::command]
pub fn dictation_models() -> Vec<ModelView> {
    speech_catalog::catalog()
        .iter()
        .map(|spec| ModelView {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
            description: spec.description.to_string(),
            language: spec.language.to_string(),
            streaming: spec.streaming,
            recommended: spec.recommended,
            size_bytes: spec.total_bytes(),
            installed: spec_installed(spec),
            local_bytes: spec_local_bytes(spec),
        })
        .collect()
}

fn verify(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path).map_err(|error| format!("open:{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("read:{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    // sha2 0.11 returns a generic Array, which has no LowerHex impl.
    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if digest == expected {
        Ok(())
    } else {
        Err(format!("hash_mismatch: expected {expected}, got {digest}"))
    }
}

fn download_file(
    app: &AppHandle,
    id: &str,
    dir: &Path,
    file: &ModelFile,
    already: u64,
    total: u64,
) -> Result<u64, String> {
    let final_path = dir.join(file.name);
    if file_complete(&final_path, file.size_bytes) {
        return Ok(file.size_bytes);
    }

    let partial_path = dir.join(format!("{}.partial", file.name));
    let resume_from = std::fs::metadata(&partial_path)
        .map(|meta| meta.len())
        .unwrap_or(0);

    let client = reqwest::blocking::Client::builder()
        .timeout(None)
        .build()
        .map_err(|error| format!("client:{error}"))?;
    let mut request = client.get(file.url);
    if resume_from > 0 && resume_from < file.size_bytes {
        request = request.header("Range", format!("bytes={resume_from}-"));
    }

    let mut response = request.send().map_err(|error| format!("request:{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("http_{}", status.as_u16()));
    }

    // A 200 to a Range request means the server ignored it and restarted from
    // zero; appending to the partial would corrupt the file.
    let append = resume_from > 0 && status.as_u16() == 206;
    let mut sink = std::fs::OpenOptions::new()
        .create(true)
        .append(append)
        .write(true)
        .truncate(!append)
        .open(&partial_path)
        .map_err(|error| format!("open_partial:{error}"))?;

    let mut written = if append { resume_from } else { 0 };
    let mut buffer = vec![0u8; 512 * 1024];
    let mut since_emit = 0u64;
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("stream:{error}"))?;
        if read == 0 {
            break;
        }
        sink.write_all(&buffer[..read])
            .map_err(|error| format!("write:{error}"))?;
        written += read as u64;
        since_emit += read as u64;
        // Emitting every chunk floods the frontend; every 4 MB is enough for a
        // progress bar that moves.
        if since_emit >= 4 * 1024 * 1024 {
            since_emit = 0;
            let _ = app.emit(
                "dictation://download",
                DownloadProgress {
                    id: id.to_string(),
                    received: already + written,
                    total,
                    file: file.name.to_string(),
                    done: false,
                    error: None,
                },
            );
        }
    }
    drop(sink);

    verify(&partial_path, file.sha256).inspect_err(|_| {
        // A bad digest means the partial is poisoned; keeping it would make the
        // next attempt resume from corrupt bytes forever.
        let _ = std::fs::remove_file(&partial_path);
    })?;

    std::fs::rename(&partial_path, &final_path).map_err(|error| format!("rename:{error}"))?;
    Ok(written)
}

#[tauri::command]
pub async fn dictation_download(app: AppHandle, id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let spec = speech_catalog::find(&id).ok_or_else(|| "unknown_model".to_string())?;
        let dir = model_dir(&id)?;
        std::fs::create_dir_all(&dir).map_err(|error| format!("mkdir:{error}"))?;

        let total = spec.total_bytes();
        let mut done_bytes = 0u64;
        for file in spec.files {
            match download_file(&app, &id, &dir, file, done_bytes, total) {
                Ok(written) => done_bytes += written,
                Err(error) => {
                    let _ = app.emit(
                        "dictation://download",
                        DownloadProgress {
                            id: id.clone(),
                            received: done_bytes,
                            total,
                            file: file.name.to_string(),
                            done: true,
                            error: Some(error.clone()),
                        },
                    );
                    return Err(error);
                }
            }
        }

        let _ = app.emit(
            "dictation://download",
            DownloadProgress {
                id: id.clone(),
                received: total,
                total,
                file: String::new(),
                done: true,
                error: None,
            },
        );
        Ok(())
    })
    .await
    .map_err(|error| format!("dictation_download: blocking task failed: {error}"))?
}

#[tauri::command]
pub async fn dictation_delete(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir = model_dir(&id)?;
        if !dir.is_dir() {
            return Ok(());
        }
        std::fs::remove_dir_all(&dir).map_err(|error| format!("remove:{error}"))
    })
    .await
    .map_err(|error| format!("dictation_delete: blocking task failed: {error}"))?
}
