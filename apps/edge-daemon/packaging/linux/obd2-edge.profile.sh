# Points `edge-daemon pair` at the system service's data directory (it also
# finds it without this). Technicians need to be in the obd2-edge group, which
# may write only /var/lib/obd2-edge/pairing.
export EDGE_DATA_DIR=/var/lib/obd2-edge
