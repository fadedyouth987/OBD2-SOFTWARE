//! j2534-bridge: see the library docs. Usage: `j2534-bridge [--loopback]`,
//! then JSON requests on stdin, one per line.

use std::io::{stdin, stdout, BufWriter};

#[cfg(not(windows))]
use j2534_bridge::proto::{Request, Response};
use j2534_bridge::serve::{run_loopback, Io};

fn main() {
    let loopback = std::env::args().any(|a| a == "--loopback");
    let mut io = Io::new(stdin().lock(), BufWriter::new(stdout().lock()));
    if loopback {
        run_loopback(&mut io);
        return;
    }
    #[cfg(windows)]
    j2534_bridge::passthru::run(&mut io);
    #[cfg(not(windows))]
    while let Some(req) = io.next_request() {
        let response = match req {
            Request::Hello => j2534_bridge::serve::hello(),
            _ => Response::Error {
                message: "J2534 needs Windows; --loopback is for tests".into(),
            },
        };
        io.reply(&response);
    }
}
