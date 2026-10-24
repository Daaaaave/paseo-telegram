# Changelog

## 0.2.4

- Add an **Add to group** link to settings and owner confirmation, requesting
  administrator message access without moderation rights.
- Check Telegram privacy and group membership automatically. Show **Group setup
  needed** and **Fix group access** when ordinary mentions cannot reach the bot,
  with an immediate manual recheck and `/ask@bot` guidance.
- Keep setup notifications in English and preserve admission, request policies,
  existing conversations and credentials during upgrades.
- Update Zod to 4.6.7 to address its collection-validation memory exhaustion advisory.

## 0.2.3

- Deliver native clarification answers without waiting behind the foreground
  task, keeping ordinary requests serialized. Running tasks retain ownership of
  their final reply; an idle chat's answer still waits for its follow-up result.
- Keep old outstanding forms out of unrelated new requests, including recovered
  tasks. Repeated replies do not become new prompts, and interrupted permission
  responses are not replayed or falsely acknowledged.

## 0.2.2

- Resume dormant saved Paseo chats before Git synchronization, request dispatch,
  or clarification replies. A non-resident `closed` session is no longer mistaken
  for a busy or unavailable agent. Archived chats remain unavailable.

## 0.2.1

- Remove the Paseo version restriction so daemon and app updates do not block
  plugin loading. Package checks enforce the unrestricted manifest.

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
