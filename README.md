# RGB Studio

A small local web UI for [OpenRGB](https://openrgb.org). It lists every RGB device and zone that the OpenRGB SDK server reports, and lets you apply each device's built-in hardware effects with their colors, speed, brightness and direction. You can also set a solid color, turn devices off, or save an effect to the device. Everything runs on Node with no dependencies.

## Run

1. Start OpenRGB with the SDK server enabled (default `127.0.0.1:6742`).
2. `node server.mjs`
3. Open http://localhost:7420

## Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `7420` | Web UI port (binds to 127.0.0.1 only) |
| `OPENRGB_HOST` | `127.0.0.1` | OpenRGB SDK server host |
| `OPENRGB_PORT` | `6742` | OpenRGB SDK server port |
| `AGENT_PID_FILE` | `D:\claude\Projects\openrgb-agent\fire.pid` | PID file of an external software effect. The app stops that process before it applies anything, so the effect doesn't overwrite your change. |

## API

- `GET /api/devices`: lists devices, zones, modes and LED preview colors
- `POST /api/mode` `{device, mode, colors?, speed?, brightness?, direction?, random?}`
- `POST /api/mode-all` `{name, ...}`: applies the mode by name to every device that has it
- `POST /api/color` `{device|"all", color}`, `POST /api/off` `{device|"all"}`, `POST /api/save` `{device}`
