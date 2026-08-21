# Support

DSH Codex Bridge is an early-stage open-source project maintained on a best-effort basis.

## Before asking for help

1. Read the [installation manual](docs/installation.md) and [troubleshooting guide](docs/troubleshooting.md).
2. Confirm the supported versions in the [compatibility matrix](docs/compatibility.md).
3. Run:

```bash
pnpm dsh-bridge doctor --config /absolute/path/to/bridge.yaml --json --redacted
```

4. Search existing [GitHub Issues](https://github.com/HazenSun/dsh-codex-bridge/issues).

## Bug reports

Use the repository Bug Report template and include Bridge/DSH/Node/OS versions, mode, Profile ID, expected behavior, actual behavior, reproduction steps, and redacted doctor output.

Do not include API keys, cookies, authorization headers, private source code, raw production logs, or unpublished exploit details.

## Feature requests and design discussions

Use the Feature Request template. Protocol, security, runtime-boundary, new-host, remote-runtime, and direct-write proposals should explain the problem, constraints, rejected alternatives, migration path, and test plan.

## Security issues

Do not open a public Issue. Follow [SECURITY.md](SECURITY.md) and use GitHub private vulnerability reporting.
