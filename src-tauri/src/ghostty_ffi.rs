//! FFI para o shim C do libghostty (`ghostty_shim.m`).
//!

//!

#![cfg(all(target_os = "macos", ghostty_linked))]

use std::os::raw::{c_char, c_void};

pub type ArcoSurface = *mut c_void;

#[allow(dead_code)]
extern "C" {
    pub fn arco_ghostty_ensure_app() -> bool;
    pub fn arco_ghostty_surface_new(
        nsview: *mut c_void,
        cwd: *const c_char,
        command: *const c_char,
        scale_factor: f64,
    ) -> ArcoSurface;
    pub fn arco_ghostty_surface_set_frame(surface: ArcoSurface, x: f64, y: f64, w: f64, h: f64);
    pub fn arco_ghostty_surface_set_hidden(surface: ArcoSurface, hidden: bool);
    pub fn arco_ghostty_surface_set_size(surface: ArcoSurface, width_px: u32, height_px: u32);
    pub fn arco_ghostty_surface_set_content_scale(surface: ArcoSurface, x: f64, y: f64);
    pub fn arco_ghostty_surface_set_focus(surface: ArcoSurface, focused: bool);
    pub fn arco_ghostty_surface_process_exited(surface: ArcoSurface) -> bool;
    pub fn arco_ghostty_surface_draw(surface: ArcoSurface);
    pub fn arco_ghostty_surface_free(surface: ArcoSurface);
    pub fn arco_ghostty_app_tick();
    pub fn arco_ghostty_kill_all();
    pub fn arco_ghostty_surface_send_text(
        surface: ArcoSurface,
        utf8: *const c_char,
        len: usize,
    );
    pub fn arco_ghostty_surface_read_screen(
        surface: ArcoSurface,
        out: *mut c_char,
        cap: usize,
    ) -> usize;
    pub fn arco_ghostty_draw_count() -> u64;
    pub fn arco_ghostty_test_ime_compose(
        surface: ArcoSurface,
        marked: *const c_char,
        final_: *const c_char,
    ) -> bool;
    pub fn arco_ghostty_test_type_key(
        surface: ArcoSurface,
        characters: *const c_char,
        keycode: u16,
    ) -> bool;
    pub fn arco_ghostty_test_last_key_text() -> *const c_char;
    pub fn arco_ghostty_test_last_key_composing() -> bool;
}
