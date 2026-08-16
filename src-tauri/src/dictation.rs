//! Local speech-to-text dictation.
//!
//! The upstream `DictationButton` drives the browser `SpeechRecognition` API, which
//! WebKitGTK does not implement — the button is inert on Linux. This module replaces
//! the engine while keeping the existing flow: text still lands in the focused pane's
//! PTY through the frontend.
//!
//! Audio is captured natively with `cpal` instead of `getUserMedia` so capture does
//! not depend on the webview, and recognition runs through sherpa-onnx against an
//! on-device model. Nothing leaves the machine.

use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig};

/// Hold-to-talk sessions are short. This bounds a stuck stream instead of growing
/// the sample buffer until memory runs out.
const MAX_CAPTURE_SECS: usize = 300;

// ── Model location ───────────────────────────────────────────────────────

/// Directories searched for the model, in order. The Orca path comes first so an
/// existing 640 MB download is reused instead of duplicated while both apps coexist.
fn model_search_paths(id: &str) -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Ok(custom) = std::env::var("ARCO_SPEECH_MODEL_DIR") {
        paths.push(std::path::PathBuf::from(custom));
    }
    if let Some(config) = dirs_next::config_dir() {
        paths.push(config.join("arco").join("speech-models").join(id));
        // Orca's copy is a fallback, not the first choice. It led the list while
        // both apps were installed, to avoid a second download; models belong here
        // now, and this only rescues a machine that has not moved them.
        paths.push(config.join("orca").join("speech-models").join(id));
    }
    paths
}

struct ModelFiles {
    dir: std::path::PathBuf,
    kind: crate::speech_catalog::ModelKind,
    /// Files in catalogue order, resolved to absolute paths.
    paths: Vec<String>,
}

/// Resolves the selected model on disk.
///
/// The file names are not guessed: they come from the catalogue entry, which is
/// also what the downloader wrote. That keeps a renamed or half-installed model
/// from being reported as present.
fn locate_model(id: &str) -> Result<ModelFiles, String> {
    let spec = crate::speech_catalog::find(id).ok_or_else(|| "unknown_model".to_string())?;
    if !spec.kind.supported() {
        return Err("model_kind_unsupported".to_string());
    }
    for dir in model_search_paths(id) {
        let paths: Vec<std::path::PathBuf> =
            spec.files.iter().map(|file| dir.join(file.name)).collect();
        if paths.iter().all(|path| path.is_file()) {
            return Ok(ModelFiles {
                paths: paths
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect(),
                kind: spec.kind,
                dir,
            });
        }
    }
    Err("speech_model_not_found".to_string())
}

// ── Recognizer ───────────────────────────────────────────────────────────

/// The loaded model, keyed by id: switching models in preferences must not keep
/// serving the previous one from cache.
static RECOGNIZER: OnceLock<Mutex<Option<(String, Arc<OfflineRecognizer>)>>> = OnceLock::new();

fn recognizer_slot() -> &'static Mutex<Option<(String, Arc<OfflineRecognizer>)>> {
    RECOGNIZER.get_or_init(|| Mutex::new(None))
}

/// Fills in the model config for the shape this model has. Sherpa keys off which
/// sub-config is populated, so exactly one of these may be set.
fn apply_model_config(config: &mut OfflineRecognizerConfig, files: &ModelFiles) {
    use crate::speech_catalog::ModelKind;
    let path = |index: usize| files.paths.get(index).cloned();

    match files.kind {
        ModelKind::Transducer => {
            config.model_config.transducer = OfflineTransducerModelConfig {
                encoder: path(0),
                decoder: path(1),
                joiner: path(2),
            };
            config.model_config.tokens = path(3);
            // The encoder/decoder/joiner triple alone matches several
            // architectures; sherpa needs the family spelled out.
            config.model_config.model_type = Some("nemo_transducer".to_string());
        }
        ModelKind::Paraformer => {
            config.model_config.paraformer = sherpa_onnx::OfflineParaformerModelConfig {
                model: path(0),
            };
            config.model_config.tokens = path(2);
        }
        ModelKind::Ctc => {
            config.model_config.nemo_ctc = sherpa_onnx::OfflineNemoEncDecCtcModelConfig {
                model: path(0),
            };
            config.model_config.tokens = path(1);
        }
        ModelKind::SenseVoice => {
            config.model_config.sense_voice = sherpa_onnx::OfflineSenseVoiceModelConfig {
                model: path(0),
                language: None,
                use_itn: true,
            };
            config.model_config.tokens = path(1);
        }
        ModelKind::Whisper => {
            config.model_config.whisper = sherpa_onnx::OfflineWhisperModelConfig {
                encoder: path(0),
                decoder: path(1),
                language: None,
                task: None,
                tail_paddings: 0,
                enable_token_timestamps: false,
                enable_segment_timestamps: false,
            };
            config.model_config.tokens = path(2);
        }
        // Rejected in locate_model: this needs OnlineRecognizer, not this one.
        ModelKind::StreamingTransducer => {}
    }
}

/// Loads the model once and keeps it warm. Reading a 622 MB int8 encoder costs
/// seconds, which is unacceptable between pressing the key and speaking.
fn load_recognizer(id: &str) -> Result<Arc<OfflineRecognizer>, String> {
    let slot = recognizer_slot();
    let mut guard = slot
        .lock()
        .map_err(|_| "dictation recognizer lock poisoned".to_string())?;
    if let Some((loaded_id, existing)) = guard.as_ref() {
        if loaded_id == id {
            return Ok(existing.clone());
        }
    }

    let files = locate_model(id)?;
    let mut config = OfflineRecognizerConfig::default();
    apply_model_config(&mut config, &files);
    // Leave headroom: dictation runs while several agents compile and test.
    config.model_config.num_threads = (num_cpus_capped() / 2).max(1);

    let recognizer =
        OfflineRecognizer::create(&config).ok_or_else(|| "recognizer_create_failed".to_string())?;
    let recognizer = Arc::new(recognizer);
    *guard = Some((id.to_string(), recognizer.clone()));
    Ok(recognizer)
}

fn num_cpus_capped() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4)
        .clamp(1, 8)
}

// ── Capture ──────────────────────────────────────────────────────────────

struct Capture {
    stop: Sender<()>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    handle: JoinHandle<()>,
}

static CAPTURE: OnceLock<Mutex<Option<Capture>>> = OnceLock::new();

fn capture_slot() -> &'static Mutex<Option<Capture>> {
    CAPTURE.get_or_init(|| Mutex::new(None))
}

/// Downmixes to mono by averaging frames; the model expects a single channel and
/// picking one channel would drop half the signal on stereo inputs.
fn push_mono(buffer: &Arc<Mutex<Vec<f32>>>, data: &[f32], channels: usize, cap: usize) {
    let Ok(mut samples) = buffer.lock() else { return };
    if samples.len() >= cap {
        return;
    }
    if channels <= 1 {
        samples.extend_from_slice(data);
        return;
    }
    for frame in data.chunks(channels) {
        let sum: f32 = frame.iter().sum();
        samples.push(sum / frame.len() as f32);
    }
}

/// Owns the cpal stream on a dedicated thread: `cpal::Stream` is not `Send`, so it
/// cannot live in the shared state the Tauri commands touch.
fn spawn_capture() -> Result<Capture, String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let thread_samples = samples.clone();

    let handle = std::thread::spawn(move || {
        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            let _ = ready_tx.send(Err("no_input_device".to_string()));
            return;
        };
        let config = match device.default_input_config() {
            Ok(config) => config,
            Err(error) => {
                let _ = ready_tx.send(Err(format!("input_config_failed:{error}")));
                return;
            }
        };

        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as usize;
        let cap = sample_rate as usize * MAX_CAPTURE_SECS;
        let stream_config: cpal::StreamConfig = config.clone().into();

        let build = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                let buffer = thread_samples.clone();
                device.build_input_stream(
                    &stream_config,
                    move |data: &[f32], _: &_| push_mono(&buffer, data, channels, cap),
                    |error| eprintln!("[dictation] input stream error: {error}"),
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let buffer = thread_samples.clone();
                device.build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &_| {
                        let converted: Vec<f32> = data
                            .iter()
                            .map(|value| *value as f32 / i16::MAX as f32)
                            .collect();
                        push_mono(&buffer, &converted, channels, cap)
                    },
                    |error| eprintln!("[dictation] input stream error: {error}"),
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let buffer = thread_samples.clone();
                device.build_input_stream(
                    &stream_config,
                    move |data: &[u16], _: &_| {
                        let converted: Vec<f32> = data
                            .iter()
                            .map(|value| (*value as f32 / u16::MAX as f32) * 2.0 - 1.0)
                            .collect();
                        push_mono(&buffer, &converted, channels, cap)
                    },
                    |error| eprintln!("[dictation] input stream error: {error}"),
                    None,
                )
            }
            other => Err(cpal::BuildStreamError::BackendSpecific {
                err: cpal::BackendSpecificError {
                    description: format!("unsupported sample format: {other:?}"),
                },
            }),
        };

        let stream = match build {
            Ok(stream) => stream,
            Err(error) => {
                let _ = ready_tx.send(Err(format!("build_stream_failed:{error}")));
                return;
            }
        };
        if let Err(error) = stream.play() {
            let _ = ready_tx.send(Err(format!("stream_play_failed:{error}")));
            return;
        }

        let _ = ready_tx.send(Ok(sample_rate));
        // Blocks until stop_dictation drops the sender or sends; the stream is dropped
        // on this thread, which is where it was built.
        let _ = stop_rx.recv();
        drop(stream);
    });

    match ready_rx.recv() {
        Ok(Ok(sample_rate)) => Ok(Capture {
            stop: stop_tx,
            samples,
            sample_rate,
            handle,
        }),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("capture_thread_died".to_string()),
    }
}

// ── Commands ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    pub model_found: bool,
    pub model_dir: Option<String>,
    pub model_loaded: bool,
    pub capturing: bool,
}

#[tauri::command]
pub fn dictation_status(model: String) -> DictationStatus {
    let located = locate_model(&model).ok();
    let loaded = recognizer_slot()
        .lock()
        .map(|guard| guard.as_ref().is_some_and(|(id, _)| *id == model))
        .unwrap_or(false);
    let capturing = capture_slot()
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false);
    DictationStatus {
        model_found: located.is_some(),
        model_dir: located.map(|files| files.dir.to_string_lossy().into_owned()),
        model_loaded: loaded,
        capturing,
    }
}

/// Warms the model up front so the first hold does not pay the load.
#[tauri::command]
pub async fn dictation_preload(model: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || load_recognizer(&model).map(|_| ()))
        .await
        .map_err(|error| format!("dictation_preload: blocking task failed: {error}"))?
}

#[tauri::command]
pub async fn dictation_start(model: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Load before opening the microphone: a missing model must fail before the
        // user starts speaking, not after.
        load_recognizer(&model)?;

        let slot = capture_slot();
        let mut guard = slot
            .lock()
            .map_err(|_| "dictation capture lock poisoned".to_string())?;
        if guard.is_some() {
            return Err("already_capturing".to_string());
        }
        *guard = Some(spawn_capture()?);
        Ok(())
    })
    .await
    .map_err(|error| format!("dictation_start: blocking task failed: {error}"))?
}

/// Stops capture and returns the transcript. Empty string when nothing was said.
#[tauri::command]
pub async fn dictation_stop(model: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let capture = {
            let slot = capture_slot();
            let mut guard = slot
                .lock()
                .map_err(|_| "dictation capture lock poisoned".to_string())?;
            guard.take().ok_or_else(|| "not_capturing".to_string())?
        };

        let _ = capture.stop.send(());
        let _ = capture.handle.join();

        let samples = capture
            .samples
            .lock()
            .map_err(|_| "dictation sample buffer poisoned".to_string())?
            .clone();

        // Anything shorter than a syllable is a stray keypress, not speech.
        if samples.len() < capture.sample_rate as usize / 10 {
            return Ok(String::new());
        }

        let recognizer = load_recognizer(&model)?;
        let stream = recognizer.create_stream();
        stream.accept_waveform(capture.sample_rate as i32, &samples);
        recognizer.decode(&stream);
        Ok(stream
            .get_result()
            .map(|result| result.text.trim().to_string())
            .unwrap_or_default())
    })
    .await
    .map_err(|error| format!("dictation_stop: blocking task failed: {error}"))?
}

/// Drops capture without transcribing — for aborting a hold.
#[tauri::command]
pub fn dictation_cancel() -> Result<(), String> {
    let slot = capture_slot();
    let mut guard = slot
        .lock()
        .map_err(|_| "dictation capture lock poisoned".to_string())?;
    if let Some(capture) = guard.take() {
        let _ = capture.stop.send(());
        let _ = capture.handle.join();
    }
    Ok(())
}

// ── Smoke tests ──────────────────────────────────────────────────────────
//
// Ignored by default: they touch the real model on disk and the real microphone,
// so they belong to a manual run, not to CI.
//
//   cargo test --lib dictation -- --ignored --nocapture --test-threads=1

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// The model the tests expect installed; the same default the app ships with.
    const DEFAULT_TEST_MODEL: &str = "parakeet-tdt-0.6b-v3-int8";

    #[test]
    #[ignore = "requires the on-device model"]
    fn locates_and_loads_model() {
        let files = locate_model(DEFAULT_TEST_MODEL).expect("model not found in any search path");
        println!("model dir: {}", files.dir.display());

        let started = Instant::now();
        let recognizer = load_recognizer(DEFAULT_TEST_MODEL).expect("recognizer failed to load");
        println!("cold load: {:?}", started.elapsed());

        // Warm reuse must not re-read 622 MB.
        let started = Instant::now();
        let again = load_recognizer(DEFAULT_TEST_MODEL).expect("warm load failed");
        println!("warm load: {:?}", started.elapsed());
        assert!(Arc::ptr_eq(&recognizer, &again), "warm load rebuilt the model");
    }

    #[test]
    #[ignore = "requires the on-device model"]
    fn decodes_silence_without_panicking() {
        let recognizer = load_recognizer(DEFAULT_TEST_MODEL).expect("recognizer failed to load");
        let stream = recognizer.create_stream();
        stream.accept_waveform(16_000, &vec![0.0f32; 16_000]);
        recognizer.decode(&stream);
        let text = stream
            .get_result()
            .map(|result| result.text)
            .unwrap_or_default();
        println!("silence decoded as: {text:?}");
    }

    #[test]
    #[ignore = "opens the real microphone"]
    fn captures_audio_from_default_input() {
        let capture = spawn_capture().expect("failed to open the input device");
        println!("sample rate: {} Hz", capture.sample_rate);
        std::thread::sleep(std::time::Duration::from_millis(1200));

        let _ = capture.stop.send(());
        let _ = capture.handle.join();

        let samples = capture.samples.lock().expect("sample buffer poisoned");
        let peak = samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
        println!("captured {} samples, peak {:.4}", samples.len(), peak);
        assert!(
            !samples.is_empty(),
            "no audio captured — the input device produced nothing"
        );
    }
}
