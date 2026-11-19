//! A-ENG-1 bridge round trip: the daemon's real `J2534Adapter` starts this
//! crate's real `j2534-bridge` binary and exchanges CAN frames through it.
//!
//! On any OS this uses the bridge's `--loopback` device. With a J2534 device
//! attached on Windows, run the ignored `real_device_round_trip` with
//! `J2534_TEST_DLL` set (frames then come from the vehicle, so only the
//! open/send/close path is asserted).

use std::time::Duration;

use edge_daemon::hal::{j2534_win::J2534Adapter, CanFilter, CanFrame, HalError, VehicleBusAdapter};

const BRIDGE: &str = env!("CARGO_BIN_EXE_j2534-bridge");

#[tokio::test]
async fn bridge_round_trip_through_loopback() {
    let mut adapter = J2534Adapter::loopback(BRIDGE);
    adapter
        .open(500_000)
        .await
        .expect("bridge starts and opens the device");
    adapter
        .set_filter(&[
            CanFilter::exact(0x7E8, false),
            CanFilter::exact(0x18DA_F110, true),
        ])
        .await
        .unwrap();

    let std = CanFrame::std(0x7E8, &[0x03, 0x41, 0x0D, 0x00]);
    let ext = CanFrame::ext(0x18DA_F110, &[1, 2, 3, 4, 5, 6, 7, 8]);
    adapter
        .send_frame(&CanFrame::std(0x123, &[0xFF]))
        .await
        .unwrap(); // filtered out
    adapter.send_frame(&std).await.unwrap();
    adapter.send_frame(&ext).await.unwrap();
    assert_eq!(
        adapter
            .recv_frame(Duration::from_millis(100))
            .await
            .unwrap(),
        std
    );
    assert_eq!(
        adapter
            .recv_frame(Duration::from_millis(100))
            .await
            .unwrap(),
        ext
    );
    assert!(matches!(
        adapter.recv_frame(Duration::from_millis(50)).await,
        Err(HalError::Timeout(_))
    ));
    adapter.close().await.unwrap();
    assert!(matches!(
        adapter.send_frame(&std).await,
        Err(HalError::NotOpen)
    ));
}

#[tokio::test]
async fn unknown_dll_is_reported() {
    let mut adapter = J2534Adapter::new(BRIDGE, "C:\\missing\\driver.dll");
    // Off Windows the bridge refuses every DLL; on Windows the load fails.
    assert!(matches!(
        adapter.open(500_000).await,
        Err(HalError::Protocol(_))
    ));
}

#[tokio::test]
async fn missing_bridge_executable_is_an_io_error() {
    let mut adapter = J2534Adapter::new("/nonexistent/j2534-bridge", "driver.dll");
    assert!(matches!(adapter.open(500_000).await, Err(HalError::Io(_))));
}

/// Hardware (A-ENG-10 checklist): `J2534_TEST_DLL=C:\\path\\driver.dll cargo test -p j2534-bridge -- --ignored`.
#[tokio::test]
#[ignore = "needs a J2534 device; set J2534_TEST_DLL"]
async fn real_device_round_trip() {
    let dll = std::env::var("J2534_TEST_DLL").expect("J2534_TEST_DLL names the vendor DLL");
    let mut adapter = J2534Adapter::new(BRIDGE, dll);
    adapter.open(500_000).await.unwrap();
    adapter
        .send_frame(&CanFrame::std(0x7DF, &[0x02, 0x01, 0x00, 0, 0, 0, 0, 0]))
        .await
        .unwrap();
    adapter.close().await.unwrap();
}
