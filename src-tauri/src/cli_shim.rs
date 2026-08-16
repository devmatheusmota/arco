//!
//! Equivalente ao "Install 'code' command in PATH" do VS Code: escreve um shim

//! `--open-path <dir>` (ver `cli_launch.rs`).
//!

//!

//!
//! | Plataforma      | Caminho                              | PATH                          |
//! |-----------------|--------------------------------------|-------------------------------|

//! | Windows         | `%LOCALAPPDATA%\Arco\bin\arco.cmd` | registrado em `HKCU\Environment` |
//!

use std::path::{Path, PathBuf};

use serde::Serialize;

#[cfg(windows)]
const SHIM_FILE_NAME: &str = "arco.cmd";
#[cfg(not(windows))]
const SHIM_FILE_NAME: &str = "arco";

#[derive(Serialize, Default)]
pub struct CliShimStatus {
    pub supported: bool,
    pub installed: bool,

    pub stale: bool,

    pub path: Option<String>,
    pub bin_dir: Option<String>,

    pub on_path: bool,
}

fn shim_bin_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let base = dirs_next::data_local_dir()
            .ok_or_else(|| "não foi possível resolver LOCALAPPDATA".to_string())?;
        Ok(base.join("Arco").join("bin"))
    }
    #[cfg(not(windows))]
    {
        let home =
            dirs_next::home_dir().ok_or_else(|| "não foi possível resolver o HOME".to_string())?;
        Ok(home.join(".local").join("bin"))
    }
}

fn shim_path() -> Result<PathBuf, String> {
    Ok(shim_bin_dir()?.join(SHIM_FILE_NAME))
}

fn current_binary() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn app_bundle(binary: &Path) -> Option<PathBuf> {
    binary
        .ancestors()
        .find(|ancestor| ancestor.extension().and_then(|ext| ext.to_str()) == Some("app"))
        .map(|bundle| bundle.to_path_buf())
}

fn dir_on_path(dir: &Path) -> bool {
    if let Some(path_var) = std::env::var_os("PATH") {
        if std::env::split_paths(&path_var).any(|entry| entry == dir) {
            return true;
        }
    }

    #[cfg(windows)]
    {
        return windows_path::user_path_contains(dir);
    }

    #[cfg(not(windows))]
    false
}

#[cfg(not(windows))]
fn sh_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

#[cfg(not(windows))]
fn unix_shim_script(target_marker: &str, launch: &str) -> String {
    format!(
        r#"#!/bin/sh
# arco — abre diretórios e comanda o Arco a partir do terminal.
#
# Gerado automaticamente pelo Arco (Configurações ▸ Integrações ▸ Comando de
# terminal). Não edite à mão: reinstale por lá, principalmente depois de mover
# ou reinstalar o app.
#
# arco                        → abre o diretório atual
# arco ~/projeto              → abre o diretório informado
#
# arco session [opções]       → cria uma sessão de agente
#     --agent claude|codex|opencode|shell   (padrão: claude)
#     --project <nome>        projeto alvo; sem isso, deduz pelo diretório atual
#     --name <rótulo>         nome do pane
#     --prompt <texto>        texto enviado ao agente ao abrir
#     --worktree              força worktree nova
#     --no-worktree           força a mesma árvore
#                             sem nenhum dos dois, segue o padrão do projeto
#
# arco todo <título> [--project <nome>] [--tag <tag>]...
# arco todo list --json         → lista as tarefas em JSON
#
# Os subcomandos exigem o app aberto: falam com o listener local dele.
#
# ARCO_TARGET_BIN: {target_marker}

set -e

arco_api_get() {{
  route=$1
  hooks=${{TMPDIR:-/tmp}}/arco-agent-hooks.json

  if [ ! -f "$hooks" ]; then
    echo "arco: o app não está rodando (sem $hooks)" >&2
    exit 1
  fi

  endpoint=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)\/hook".*/\1/p' "$hooks" | head -1)
  token=$(sed -n 's/.*"X-Arco-Token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$hooks" | head -1)

  if [ -z "$endpoint" ] || [ -z "$token" ]; then
    echo "arco: não consegui ler endpoint/token em $hooks" >&2
    exit 1
  fi

  curl -sS -f -X POST "$endpoint/cli/$route" \
    -H "X-Arco-Token: $token" --data '{{}}' || {{
      echo "arco: falha ao consultar o app" >&2
      exit 1
    }}
}}

arco_api() {{
  route=$1
  payload=$2
  hooks=${{TMPDIR:-/tmp}}/arco-agent-hooks.json

  if [ ! -f "$hooks" ]; then
    echo "arco: o app não está rodando (sem $hooks)" >&2
    exit 1
  fi

  # O mesmo arquivo que configura os hooks carrega endpoint e token.
  endpoint=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)\/hook".*/\1/p' "$hooks" | head -1)
  token=$(sed -n 's/.*"X-Arco-Token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$hooks" | head -1)

  if [ -z "$endpoint" ] || [ -z "$token" ]; then
    echo "arco: não consegui ler endpoint/token em $hooks" >&2
    exit 1
  fi

  code=$(curl -sS -o /dev/null -w '%{{http_code}}' \
    -X POST "$endpoint/cli/$route" \
    -H 'Content-Type: application/json' \
    -H "X-Arco-Token: $token" \
    --data "$payload") || {{
      echo "arco: falha ao falar com o app" >&2
      exit 1
    }}

  if [ "$code" != "200" ]; then
    echo "arco: o app respondeu $code" >&2
    exit 1
  fi
}}

# Escapa aspas e barras para interpolar com segurança num literal JSON.
json_escape() {{
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}}

case "${{1:-}}" in
  session)
    shift
    agent=claude; project=; name=; prompt=; worktree=inherit
    while [ $# -gt 0 ]; do
      case $1 in
        --agent) agent=$2; shift 2 ;;
        --project) project=$2; shift 2 ;;
        --name) name=$2; shift 2 ;;
        --prompt) prompt=$2; shift 2 ;;
        --worktree) worktree=new; shift ;;
        --no-worktree) worktree=none; shift ;;
        *) echo "arco session: opção desconhecida: $1" >&2; exit 1 ;;
      esac
    done
    body=$(printf '{{"agent":"%s","cwd":"%s","worktree":"%s"' \
      "$(json_escape "$agent")" "$(json_escape "$(pwd)")" "$worktree")
    [ -n "$project" ] && body="$body,\"project\":\"$(json_escape "$project")\""
    [ -n "$name" ] && body="$body,\"name\":\"$(json_escape "$name")\""
    [ -n "$prompt" ] && body="$body,\"prompt\":\"$(json_escape "$prompt")\""
    arco_api session "$body}}"
    exit 0
    ;;
  todo)
    shift
    # `todo list --json` responde; os outros subcomandos so enfileiram.
    if [ "${{1:-}}" = "list" ]; then
      shift
      [ "${{1:-}}" = "--json" ] && shift
      arco_api_get todo/list
      echo
      exit 0
    fi
    title=; project=; tags=
    while [ $# -gt 0 ]; do
      case $1 in
        --project) project=$2; shift 2 ;;
        --tag) tags="$tags\"$(json_escape "$2")\","; shift 2 ;;
        *) title="$title${{title:+ }}$1"; shift ;;
      esac
    done
    if [ -z "$title" ]; then
      echo "arco todo: informe um título" >&2
      exit 1
    fi
    body=$(printf '{{"title":"%s","tags":[%s]' \
      "$(json_escape "$title")" "${{tags%,}}")
    [ -n "$project" ] && body="$body,\"project\":\"$(json_escape "$project")\""
    arco_api todo "$body}}"
    exit 0
    ;;
esac

target=${{1:-.}}

if [ ! -d "$target" ]; then
  echo "arco: diretório não encontrado: $target" >&2
  exit 1
fi

# Caminho absoluto: o app compara com o cwd salvo dos projetos.
target=$(cd "$target" && pwd)

{launch}
"#
    )
}

fn render_shim(binary: &Path) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(bundle) = app_bundle(binary) {
            let quoted = sh_single_quote(&bundle.to_string_lossy());
            return Ok(unix_shim_script(
                &bundle.to_string_lossy(),
                &format!("exec open -na {quoted} --args --open-path \"$target\""),
            ));
        }
        let quoted = sh_single_quote(&binary.to_string_lossy());
        return Ok(unix_shim_script(
            &binary.to_string_lossy(),
            &format!(
                "nohup {quoted} --open-path \"$target\" >/dev/null 2>&1 &\n\
                 exit 0"
            ),
        ));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let quoted = sh_single_quote(&binary.to_string_lossy());
        return Ok(unix_shim_script(
            &binary.to_string_lossy(),
            &format!(
                "nohup {quoted} --open-path \"$target\" >/dev/null 2>&1 &\n\
                 exit 0"
            ),
        ));
    }

    #[cfg(windows)]
    {
        let binary = binary.to_string_lossy().to_string();
        return Ok(format!(
            r#"@echo off
rem arco - abre um diretorio no Arco a partir do terminal.
rem
rem Gerado automaticamente pelo Arco (Configuracoes > Integracoes > Comando de
rem terminal). Nao edite a mao: reinstale por la, principalmente depois de mover
rem ou reinstalar o app.
rem
rem ARCO_TARGET_BIN: {binary}

setlocal
set "target=%~1"
if "%target%"=="" set "target=%CD%"

rem Caminho absoluto: o app compara com o cwd salvo dos projetos.
for %%I in ("%target%") do set "target=%%~fI"

if not exist "%target%\" (
  echo arco: diretorio nao encontrado: %target% 1>&2
  exit /b 1
)

start "" "{binary}" --open-path "%target%"
"#
        ));
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = binary;
        Err("plataforma sem suporte a comando de terminal".to_string())
    }
}

fn shim_targets_binary(contents: &str, binary: &Path) -> bool {
    let Some(line) = contents
        .lines()
        .find_map(|line| line.split_once("ARCO_TARGET_BIN:"))
        .map(|(_, rest)| rest.trim())
    else {
        return false;
    };
    #[cfg(target_os = "macos")]
    if let Some(bundle) = app_bundle(binary) {
        return line == bundle.to_string_lossy();
    }
    line == binary.to_string_lossy()
}

fn build_status() -> Result<CliShimStatus, String> {
    let bin_dir = shim_bin_dir()?;
    let path = shim_path()?;
    let binary = current_binary()?;

    let contents = std::fs::read_to_string(&path).ok();
    let installed = contents.is_some();
    let stale = contents
        .map(|contents| !shim_targets_binary(&contents, &binary))
        .unwrap_or(false);

    Ok(CliShimStatus {
        supported: cfg!(any(unix, windows)),
        installed,
        stale,
        path: Some(path.to_string_lossy().to_string()),
        bin_dir: Some(bin_dir.to_string_lossy().to_string()),
        on_path: dir_on_path(&bin_dir),
    })
}

#[tauri::command]
pub fn cli_shim_status() -> Result<CliShimStatus, String> {
    build_status()
}

#[tauri::command]
pub fn cli_shim_install() -> Result<CliShimStatus, String> {
    let bin_dir = shim_bin_dir()?;
    let path = shim_path()?;
    let binary = current_binary()?;

    std::fs::create_dir_all(&bin_dir).map_err(|error| error.to_string())?;
    std::fs::write(&path, render_shim(&binary)?).map_err(|error| error.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }

    #[cfg(windows)]
    {
        windows_path::add_to_user_path(&bin_dir)?;
        windows_path::add_to_process_path(&bin_dir);
    }

    build_status()
}

#[tauri::command]
pub fn cli_shim_uninstall() -> Result<CliShimStatus, String> {
    let path = shim_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }

    #[cfg(windows)]
    windows_path::remove_from_user_path(&shim_bin_dir()?)?;

    build_status()
}

///

/// `REG_EXPAND_SZ` (comum, com entradas tipo `%USERPROFILE%\bin`) e a gente

#[cfg(windows)]
mod windows_path {
    use std::path::Path;

    use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::types::FromRegValue;
    use winreg::{RegKey, RegValue};

    fn open_environment() -> Result<RegKey, String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
            .map_err(|error| error.to_string())
    }

    fn read_path(key: &RegKey) -> (String, RegType) {
        match key.get_raw_value("Path") {
            Ok(value) => {
                let vtype = value.vtype.clone();
                let text = String::from_reg_value(&value).unwrap_or_default();
                (text, vtype)
            }
            Err(_) => (String::new(), RegType::REG_EXPAND_SZ),
        }
    }

    fn write_path(key: &RegKey, value: &str, vtype: RegType) -> Result<(), String> {
        let mut bytes: Vec<u8> = value
            .encode_utf16()
            .flat_map(|unit| unit.to_ne_bytes())
            .collect();
        // Terminador UTF-16 — o registro guarda string larga com NUL final.
        bytes.extend_from_slice(&[0, 0]);
        key.set_raw_value("Path", &RegValue { bytes, vtype })
            .map_err(|error| error.to_string())
    }

    fn entries(path: &str) -> Vec<&str> {
        path.split(';')
            .filter(|entry| !entry.trim().is_empty())
            .collect()
    }

    pub fn user_path_contains(dir: &Path) -> bool {
        let Ok(key) = open_environment() else {
            return false;
        };
        let (current, _) = read_path(&key);
        let target = dir.to_string_lossy().to_string();
        entries(&current).iter().any(|entry| {
            entry
                .trim_end_matches('\\')
                .eq_ignore_ascii_case(target.trim_end_matches('\\'))
        })
    }

    pub fn add_to_user_path(dir: &Path) -> Result<(), String> {
        let key = open_environment()?;
        let (current, vtype) = read_path(&key);
        let target = dir.to_string_lossy().to_string();

        if entries(&current).iter().any(|entry| {
            entry
                .trim_end_matches('\\')
                .eq_ignore_ascii_case(target.trim_end_matches('\\'))
        }) {
            return Ok(());
        }

        let updated = if current.trim().is_empty() {
            target
        } else {
            format!("{};{}", current.trim_end_matches(';'), target)
        };
        write_path(&key, &updated, vtype)?;
        broadcast_environment_change();
        Ok(())
    }

    pub fn add_to_process_path(dir: &Path) {
        let Some(current) = std::env::var_os("PATH") else {
            std::env::set_var("PATH", dir);
            return;
        };
        if std::env::split_paths(&current).any(|entry| {
            entry
                .to_string_lossy()
                .trim_end_matches('\\')
                .eq_ignore_ascii_case(dir.to_string_lossy().trim_end_matches('\\'))
        }) {
            return;
        }
        let updated = format!("{};{}", current.to_string_lossy(), dir.to_string_lossy());
        std::env::set_var("PATH", updated);
    }

    pub fn remove_from_user_path(dir: &Path) -> Result<(), String> {
        let key = open_environment()?;
        let (current, vtype) = read_path(&key);
        let target = dir.to_string_lossy().to_string();
        let target = target.trim_end_matches('\\');

        let all = entries(&current);
        let kept: Vec<&str> = all
            .iter()
            .copied()
            .filter(|entry| !entry.trim_end_matches('\\').eq_ignore_ascii_case(target))
            .collect();

        if kept.len() == all.len() {
            return Ok(());
        }
        write_path(&key, &kept.join(";"), vtype)?;
        broadcast_environment_change();
        Ok(())
    }

    fn broadcast_environment_change() {
        use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };

        let param: Vec<u16> = "Environment\0".encode_utf16().collect();
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST as HWND,
                WM_SETTINGCHANGE,
                0 as WPARAM,
                param.as_ptr() as LPARAM,
                SMTO_ABORTIFHUNG,
                5000,
                std::ptr::null_mut(),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shim_mentions_target_binary() {
        let binary = PathBuf::from("/opt/arco/arco");
        let script = render_shim(&binary).expect("script");
        assert!(shim_targets_binary(&script, &binary));
    }

    #[test]
    fn stale_shim_is_detected() {
        let old = PathBuf::from("/opt/arco-antigo/arco");
        let script = render_shim(&old).expect("script");
        assert!(!shim_targets_binary(
            &script,
            Path::new("/opt/arco-novo/arco")
        ));
    }

    #[test]
    fn shim_without_marker_counts_as_stale() {
        assert!(!shim_targets_binary(
            "#!/bin/sh\necho oi\n",
            Path::new("/opt/arco/arco")
        ));
    }

    #[cfg(not(windows))]
    #[test]
    fn shim_defaults_to_current_dir_and_is_a_posix_script() {
        let script = render_shim(Path::new("/opt/arco/arco")).expect("script");
        assert!(script.starts_with("#!/bin/sh"));

        assert!(script.contains("target=${1:-.}"));
        assert!(script.contains("--open-path"));
    }

    #[cfg(not(windows))]
    #[test]
    fn generated_shim_is_valid_shell_syntax() {
        use std::io::Write;
        use std::process::Command;

        for binary in [
            "/opt/arco/arco",
            "/Applications/Arco.app/Contents/MacOS/Arco",
        ] {
            let script = render_shim(Path::new(binary)).expect("script");
            let file = std::env::temp_dir().join(format!(
                "arco-shim-syntax-{}.sh",
                binary.replace(['/', '.'], "_")
            ));
            std::fs::File::create(&file)
                .and_then(|mut handle| handle.write_all(script.as_bytes()))
                .expect("escrever shim");

            let output = Command::new("sh")
                .arg("-n")
                .arg(&file)
                .output()
                .expect("rodar sh -n");
            let _ = std::fs::remove_file(&file);

            assert!(
                output.status.success(),
                "shim inválido para {binary}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn single_quotes_in_path_are_escaped() {
        let script = render_shim(Path::new("/opt/arco's app/arco")).expect("script");

        assert!(script.contains(r"'\''"));
    }
}

#[cfg(all(test, unix))]
mod shim_script_tests {
    use super::*;
    use std::io::Write;

    /// The shim is a shell script assembled inside `format!`, where every literal
    /// brace has to be doubled. A slip there compiles fine and only fails when the
    /// user runs the command, so parse it with `sh -n`.
    #[test]
    fn generated_shim_is_valid_shell() {
        let script = render_shim(Path::new("/opt/arco/arco")).expect("render");
        let mut file = tempfile();
        file.write_all(script.as_bytes()).expect("write");
        let path = file.path.clone();

        let output = std::process::Command::new("sh")
            .arg("-n")
            .arg(&path)
            .output()
            .expect("run sh -n");

        assert!(
            output.status.success(),
            "shim has a syntax error:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn generated_shim_exposes_the_subcommands() {
        let script = render_shim(Path::new("/opt/arco/arco")).expect("render");
        for needle in ["session)", "todo)", "/cli/", "X-Arco-Token"] {
            assert!(script.contains(needle), "shim is missing {needle}");
        }
    }

    struct TempFile {
        path: PathBuf,
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    impl TempFile {
        fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
            std::fs::write(&self.path, bytes)
        }
    }

    fn tempfile() -> TempFile {
        let path = std::env::temp_dir().join(format!("arco-shim-{}.sh", nanoid::nanoid!(8)));
        TempFile { path }
    }
}
