# Changelog

## 0.2.0

- Configure group admission independently: owner, owner and allowed users,
  approval in Paseo, or anyone who can add the bot.
- Review pending groups in Paseo; approval checks membership and rejection makes
  the bot leave. Pending groups cannot request agent work.
- Add Telegram group administrator request permissions, verified from Telegram
  before dispatch and after queuing. Verification failures deny access.
- Preserve existing access policies and old-client saves during upgrades.
- Use English for all connector service messages. User and agent content retain
  their original language.

## 0.1.4

- Show the remaining owner/destination setup step instead of marking a bot ready
  as soon as its token connects. Unsaved routing edits remain visibly inactive.
- Explain first-time setup in the screen, README and catalog overview: a new
  BotFather bot needs no code, and replies use a working Paseo provider.
- Make Telegram's start/status replies check the current conversation's saved
  destination, including individual group/topic overrides.

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
