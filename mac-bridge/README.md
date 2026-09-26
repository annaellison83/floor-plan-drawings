# Mac Messages bridge

This is the first-phase, ingest-only bridge for the dedicated Mac session.
It reads the local `~/Library/Messages/chat.db` database in read-only mode,
filters to inbound messages explicitly addressed to `+12134357223`, and emits
normalized envelopes compatible with Master’s `/api/communications/inbound`
route.

It has no outbound-send capability. `--apply` is deliberately opt-in and
requires both a Render ingest URL and token. Without `--apply`, it is a dry-run
and does not advance the checkpoint.

## First run

Install the script under the Anna Mac user, then initialize the checkpoint so
old messages are not replayed:

```sh
python3 fpd_bridge.py --initialize
python3 fpd_bridge.py
```

The first command records the current SQLite `rowid`; it does not read or send
message bodies. The second command reports only counts and bounded metadata.

## Live ingest, later

Only after the Render route and token are configured:

```sh
export FPD_INGEST_URL=https://floor-plan-drawings.onrender.com/api/communications/inbound
export FPD_INGEST_TOKEN='set-locally-only'
python3 fpd_bridge.py --apply
```

The bridge should eventually run from a LaunchAgent in Anna’s logged-in GUI
session. Full Disk Access and Messages automation permissions must be granted
to the exact bridge process before adding any outbound capability.

## Staged LaunchAgent

`run-fpd-bridge.sh` and `com.floorplandrawings.mac-bridge.plist.template` are
provided but should not be loaded until the Render route is deployed and the
ingest token exists. Keep the token in Anna’s local, mode-600 config file:

```sh
mkdir -p "$HOME/.config/floorplandrawings"
chmod 700 "$HOME/.config/floorplandrawings"
cat > "$HOME/.config/floorplandrawings/mac-bridge.env" <<'EOF'
BUSINESS_PHONE_NUMBER=+12134357223
FPD_INGEST_URL=https://floor-plan-drawings.onrender.com/api/communications/inbound
FPD_INGEST_TOKEN=replace-locally
FPD_BRIDGE_ID=fpd-mac-mini
EOF
chmod 600 "$HOME/.config/floorplandrawings/mac-bridge.env"
```

After a live endpoint test, install the wrapper and plist under Anna’s home,
then load it from Anna’s GUI session. Do not put the token in git, the plist,
or chat.
