# Run the MCP service from Termux:Boot

REA can run as a supervised HTTP MCP server inside [Termux](https://termux.dev/)
on Android and start again after the device boots. This guide covers that
deployment. The server listens on `127.0.0.1` and is reachable by apps on the
same device, not from the LAN. See [serving MCP over streamable HTTP](cli.md#serve-mcp-over-streamable-http)
for the transport contract.

## Prerequisites

- Termux and Termux:Boot installed from the same release source. The add-on and
  the main app use matching signing identities; mixing an F-Droid Termux with a
  GitHub Termux:Boot build can fail even when both packages install separately.
- `termux-services`, which provides the runit supervisor used by the service.
- A completed REA build in the Termux home directory.

## Install the service and boot hook

Run these commands in Termux from the REA checkout:

```bash
pkg install termux-services
cd ~/rea
./scripts/termux-quickstart.sh --build-only
./scripts/termux-service.sh
./scripts/termux-boot.sh
```

The quick-start installs the Termux build prerequisites and builds REA. The
service installer writes the `rea-mcp` runit unit, enables it, and starts the
HTTP server. The boot installer writes `~/.termux/boot/rea-mcp.sh` and keeps a
backup of an earlier different file.

Open the Termux:Boot app once after installing it. It has no main screen; opening
it once lets Android deliver the boot event. Then set **Termux** and
**Termux:Boot** to unrestricted battery use in Android settings. On devices with
a vendor autostart control, allow both apps there as well.

## What happens at boot

Termux:Boot runs the scripts in `~/.termux/boot/` in sorted order after Android
starts. Android must be unlocked once after a reboot before the encrypted Termux
data directory is available. `rea-mcp.sh`:

1. sets `PREFIX` and `PATH`;
2. acquires a Termux wake lock;
3. sources the `termux-services` startup script, which starts enabled runit
   units;
4. waits up to 30 seconds for `rea-mcp` to reach the `run` state;
5. appends the result, including a timestamp and any recent service-log lines on
   failure, to `$PREFIX/var/log/rea-mcp-boot.log`.

runit restarts the Node process if it exits. The boot hook does not restart or
override a unit you intentionally disabled with `sv down`; it records that the
unit did not reach the `run` state.

## Operate the service

```bash
sv status rea-mcp
sv restart rea-mcp
sv down rea-mcp
sv-enable rea-mcp
tail -f "$PREFIX/var/log/sv/rea-mcp/current"
cat "$PREFIX/var/log/rea-mcp-boot.log"
```

`sv down rea-mcp` stops the unit and leaves it disabled. `sv-enable rea-mcp`
enables it again and starts it. The service log is the Node server output; the
boot log records whether Termux:Boot reached the service.

Running `~/.termux/boot/rea-mcp.sh` manually is safe: when the service is already
running, the script observes the `run` state and exits without restarting it.
That manual run does not prove that Termux:Boot ran after a reboot.

## Connect a client

The endpoint is:

```text
http://127.0.0.1:8765/mcp
```

A client running on the same Android device can use that URL directly. A client
running on a computer can reach the loopback listener through an ADB forward over
USB debugging:

```bash
adb forward tcp:8765 tcp:8765
```

Then configure a client that supports the MCP streamable-HTTP transport:

```json
{
  "mcpServers": {
    "rea": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

Some clients use `transport` instead of `type`, or accept a bare `url`; use the
client's streamable-HTTP form. Setup-generated REA registrations remain stdio
because they launch the server on the client machine.

Check that the listener answers:

```bash
curl --max-time 5 -sS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:8765/mcp
```

A bare GET normally returns `406`. That is the streamable-HTTP transport
rejecting a request without the required `Accept: application/json,
text/event-stream` header, not a service failure. A full session requires an MCP
`initialize` request from the client.

Remove the forward when it is no longer needed:

```bash
adb forward --remove tcp:8765
```

The listener rejects requests whose `Host` or browser `Origin` is not admitted.
Use the loopback URL above; do not bind the server to `0.0.0.0` to work around a
client connection problem.

## Harden the deployment

- Keep battery optimization disabled for both apps. Android can otherwise stop
  the Termux process while the screen is off.
- Keep the Termux wake lock held. The boot hook acquires it before starting the
  service.
- Use the boot log to distinguish a failed boot hook from a later service crash.
  The log timestamp is UTC.
- Check the service log after a failure. runit restarts a crashed process, so a
  `run` status alone does not establish that the server completed startup.
- Prefer `adb forward` or an SSH tunnel over binding the service to a LAN
  interface. The MCP endpoint has no separate network authentication layer.

## Troubleshooting

| Symptom                                           | Check                                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `rea-mcp-boot.log` entry after a reboot        | Termux:Boot was not opened after installation, is battery-restricted, or was removed. Confirm both Termux packages are installed and open Termux:Boot once.                     |
| Boot log says `did not reach run state`           | Read `$PREFIX/var/log/sv/rea-mcp/current`. A port conflict or missing build output prevents the Node process from staying up.                                                   |
| `sv: command not found`                           | Install `termux-services`, restart Termux, and rerun the service installer.                                                                                                     |
| `HTTP 403`                                        | The client used a hostname or browser `Origin` the listener does not admit. Use `http://127.0.0.1:8765/mcp`.                                                                    |
| `HTTP 406` on a GET                               | Expected for a request that is not an MCP streamable-HTTP session. Test with an MCP client.                                                                                     |
| Service runs after opening Termux but not at boot | Check the boot log timestamp and the Termux wake-lock notification. Opening Termux can start the service through its profile, so status alone does not prove the boot hook ran. |

## Update an existing installation

After pulling a newer checkout, rebuild and reinstall the unit and boot hook:

```bash
cd ~/rea
git pull --ff-only
./scripts/termux-quickstart.sh --build-only
./scripts/termux-service.sh
./scripts/termux-boot.sh
```

The installers are additive and keep backups of files they replace. Restart the
MCP client after the service comes back.
