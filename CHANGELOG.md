# Changelog

## 0.1.3

- Correct the copied project name in the license notice.
- Derive the developer acceptance check's default source from package metadata
  instead of a particular GitHub repository.
- Runtime behavior and configuration are unchanged from 0.1.2.

## 0.1.2

- Fix Git installation by preparing the locked production dependencies before
  Paseo compiles the plugin.
- Pack npm releases from an isolated staging directory without the Git-only
  preparation command, avoiding a redundant dependency installation.
- Verify both installation sources with the disposable-daemon check.

## 0.1.1

- Document the configured GitHub Actions trusted publisher and verify token-free
  npm publication. Runtime behavior is unchanged from 0.1.0.

## 0.1.0

- Connect multiple Telegram bots from a cross-platform Paseo screen.
- Route DMs, groups and topics to existing chats or per-conversation agents.
- Optionally use Bots profiles and native Git worktrees.
- Pair owners, admit groups, configure callers and revoke access.
- Preserve formatted replies, editable progress, clarification forms and durable
  task recovery.
- Receive messages after daemon startup without opening a client.
