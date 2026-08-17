use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::System;

#[derive(Serialize, Clone, Debug)]
pub struct MemoryStats {
    pub total_mb: f64,
    pub app_mb: f64,
    pub webview_mb: f64,
    pub ptys_mb: f64,
    pub process_count: usize,
    pub system_total_mb: f64,
    pub system_available_mb: f64,
}

/// A full process scan reads `/proc` for every process and every thread on the
/// machine, so the callers on a 5 s and a 6 s timer have to share one sample
/// instead of each paying for its own.
const CACHE_TTL: Duration = Duration::from_secs(5);

fn shared_system() -> &'static Mutex<System> {
    static SYS: OnceLock<Mutex<System>> = OnceLock::new();
    SYS.get_or_init(|| Mutex::new(System::new()))
}

pub fn collect_memory_stats() -> MemoryStats {
    use sysinfo::Pid;
    let sys_lock = shared_system();
    let mut sys = sys_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
    sys.refresh_memory();

    let system_total_mb = sys.total_memory() as f64 / 1024.0 / 1024.0;
    let system_available_mb = sys.available_memory() as f64 / 1024.0 / 1024.0;

    // BFS over the subtree rooted at this process. The parent index is built
    // once: walking every process for each visited pid turned a 30-process tree
    // into hundreds of thousands of comparisons, because Linux lists every
    // thread of every process on the machine as a process of its own.
    let root_pid = std::process::id() as usize;
    let mut children = std::collections::HashMap::<usize, Vec<usize>>::new();
    for (pid, process) in sys.processes() {
        if process.thread_kind().is_some() {
            continue;
        }
        if let Some(parent) = process.parent() {
            children
                .entry(parent.as_u32() as usize)
                .or_default()
                .push(pid.as_u32() as usize);
        }
    }
    let mut visited = std::collections::HashSet::<usize>::new();
    let mut frontier = vec![root_pid];
    while let Some(pid) = frontier.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if let Some(kids) = children.get(&pid) {
            frontier.extend(kids.iter().copied());
        }
    }

    let mut app_bytes: u64 = 0;
    let mut webview_bytes: u64 = 0;
    let mut pty_bytes: u64 = 0;
    for pid in &visited {
        let Some(process) = sys.process(Pid::from(*pid)) else {
            continue;
        };
        let mem = process.memory();
        let name = process.name().to_string_lossy().to_ascii_lowercase();
        if *pid == root_pid || name.contains("arco") || name.contains("ensemble") {
            app_bytes += mem;
        } else if name.contains("msedgewebview2") {
            webview_bytes += mem;
        } else {
            pty_bytes += mem;
        }
    }

    let total = app_bytes + webview_bytes + pty_bytes;
    let to_mb = |bytes: u64| (bytes as f64) / 1024.0 / 1024.0;
    MemoryStats {
        total_mb: to_mb(total),
        app_mb: to_mb(app_bytes),
        webview_mb: to_mb(webview_bytes),
        ptys_mb: to_mb(pty_bytes),
        process_count: visited.len(),
        system_total_mb,
        system_available_mb,
    }
}

/// Windows). O lock do cache serializa chamadas concorrentes.
fn cached_memory_stats() -> MemoryStats {
    static CACHE: OnceLock<Mutex<Option<(Instant, MemoryStats)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, stats)) = guard.as_ref() {
        if at.elapsed() < CACHE_TTL {
            return stats.clone();
        }
    }
    let fresh = collect_memory_stats();
    *guard = Some((Instant::now(), fresh.clone()));
    fresh
}

#[tauri::command]
pub fn get_memory_stats() -> MemoryStats {
    cached_memory_stats()
}

pub fn memory_stats_cached() -> MemoryStats {
    cached_memory_stats()
}
