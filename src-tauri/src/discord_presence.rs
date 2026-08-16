use std::sync::mpsc::{self, Sender};

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use tauri::State;

const APPLICATION_ID: &str = "1517303547761528942";
const LARGE_IMAGE_ASSET: &str = "arco";

enum PresenceCommand {
    Set {
        details: String,
        state: String,
        started_at: i64,
    },
    Clear,
}

pub struct DiscordPresence {
    sender: Sender<PresenceCommand>,
}

impl DiscordPresence {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel();

        std::thread::spawn(move || {
            let mut client: Option<DiscordIpcClient> = None;

            while let Ok(command) = receiver.recv() {
                match command {
                    PresenceCommand::Set {
                        details,
                        state,
                        started_at,
                    } => {
                        set_activity(&mut client, &details, &state, started_at);
                    }
                    PresenceCommand::Clear => {
                        if let Some(mut current) = client.take() {
                            let _ = current.clear_activity();
                            let _ = current.close();
                        }
                    }
                }
            }
        });

        Self { sender }
    }
}

fn connect() -> Option<DiscordIpcClient> {
    let mut client = DiscordIpcClient::new(APPLICATION_ID);
    client.connect().ok()?;
    Some(client)
}

fn set_activity(
    client: &mut Option<DiscordIpcClient>,
    details: &str,
    state: &str,
    started_at: i64,
) {
    let activity = || {
        activity::Activity::new()
            .details(details)
            .state(state)
            .timestamps(activity::Timestamps::new().start(started_at))
            .assets(
                activity::Assets::new()
                    .large_image(LARGE_IMAGE_ASSET)
                    .large_text("Arco"),
            )
    };

    if client.is_none() {
        *client = connect();
    }

    let sent = client
        .as_mut()
        .is_some_and(|current| current.set_activity(activity()).is_ok());

    if !sent {
        *client = connect();
        if let Some(current) = client.as_mut() {
            if current.set_activity(activity()).is_err() {
                *client = None;
            }
        }
    }
}

#[tauri::command]
pub fn set_discord_presence(
    presence: State<'_, DiscordPresence>,
    details: String,
    state: String,
    started_at: i64,
) -> Result<(), String> {
    presence
        .sender
        .send(PresenceCommand::Set {
            details,
            state,
            started_at,
        })
        .map_err(|_| "Discord presence worker is unavailable".to_string())
}

#[tauri::command]
pub fn clear_discord_presence(presence: State<'_, DiscordPresence>) -> Result<(), String> {
    presence
        .sender
        .send(PresenceCommand::Clear)
        .map_err(|_| "Discord presence worker is unavailable".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_id_is_numeric() {
        assert!(APPLICATION_ID.parse::<u64>().is_ok());
    }
}
