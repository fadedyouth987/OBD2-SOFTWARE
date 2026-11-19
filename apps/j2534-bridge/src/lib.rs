//! J2534 PassThru bridge (A-ENG-1).
//!
//! Most J2534 vendor DLLs are 32-bit, and a crashing DLL takes its process
//! with it. So the 64-bit edge daemon never loads one: it starts this small
//! bridge (built for `i686-pc-windows-msvc`), which loads the DLL and speaks
//! line-delimited JSON over stdin/stdout ([`proto`]). One bridge process per
//! connection; it exits when stdin closes.
//!
//! `--loopback` runs an in-memory device instead of a DLL: frames you send come
//! back on receive. It exists so the bridge protocol and the daemon's client can
//! be tested on any OS; it is never offered to users.

pub mod proto;
pub mod serve;

#[cfg(windows)]
pub mod passthru;
