# Telegram for Paseo

Use your Paseo agents from Telegram. Connect an existing chat, or give every
Telegram group and topic its own conversation. The
[Bots plugin](https://github.com/oliexe/paseo-bots) is optional.

![Telegram connection settings](assets/desktop.png)

## Install

Requires Node **22.18+** on the daemon host and plugins enabled in Paseo.
The plugin does not restrict the daemon or connected app by Paseo version.

```sh
paseo plugin add npm:paseo-telegram
```

Open **Telegram** in the Paseo sidebar. No additional service, public webhook,
model API key, or rebuilt app is needed.

Direct Git installation is also supported:

```sh
paseo plugin add github:Daaaaave/paseo-telegram
```

Git preparation installs the shrinkwrap's production dependencies with npm,
without running dependency lifecycle scripts. npm installations use their
normal dependency acquisition.

## Connect a bot

A brand-new, otherwise empty BotFather bot works. You do not need to write bot
code or run a separate Telegram service. You do need a working model provider
or subscription in Paseo: this connector uses your Paseo agents to answer.

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather).
2. In Paseo → Telegram, enter a connection name and its bot token.
3. Create the private setup link, open it with your Telegram account and press
   **Start**. This pairs the owner; the link expires after 30 minutes.
4. Choose an existing Paseo chat, or a workspace with a provider/model or optional
   Bots profile. Choose an access policy and select **Save settings**.
5. Message the bot privately, or select **Add to group** in Paseo or the owner
   confirmation message. Choose a group and confirm administrator access in
   Telegram. The invitation requests only `manage_chat`, without moderation rights.

Connecting a token starts setup; it does not enable agent replies on its own.
**Confirm owner** and **Choose destination** show the remaining steps. The
connection becomes **Ready** after the owner is paired, a destination is saved
and the receiver is running, with message access verified for admitted groups.
This does not test the model's login or subscription;
the selected agent/provider must already work in Paseo. Unsaved destination
edits do not change where Telegram messages go. `/start` and `/status` explain
when the current Telegram conversation still needs a saved destination.

**Group setup** checks Telegram's privacy setting and the bot's membership on
startup and periodically while the receiver runs. An existing group that hides
ordinary mentions shows **Group setup needed**, with a **Fix group access** link.
Choose the affected group and confirm administrator access; BotFather changes
are unnecessary. **Check group access** refreshes the diagnosis immediately.
The plugin cannot grant itself administrator rights; Telegram requires a group
administrator's confirmation. Admission and request policies still apply.

If you prefer a regular member bot, disable **Group Privacy** in BotFather before
adding it. If privacy changed after joining, remove and re-add the bot; Telegram's
global privacy flag cannot prove that an existing membership was refreshed.
With privacy enabled, `/ask@your_bot question` and replies to the bot still work.
Inline Mode is unnecessary. An existing webhook is left intact; disconnect the bot's
other integration before enabling polling here. Only one integration should poll
a Telegram bot at a time.

One installation supports up to 20 bot connections, with separate tokens,
owners, queues, receipts and conversation mappings.

## Choose where messages go

| Destination               | Behavior                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Existing Paseo chat       | Uses that exact agent and history. Keeps its model, instructions and permissions.                                     |
| Workspace                 | Creates an ordinary agent for each Telegram chat/topic, with separate history.                                        |
| Workspace + Bots profile  | Creates separate chats associated with the chosen Bots profile, using its model, prompt, memory and configured tools. |
| Workspace + Git worktrees | Creates a separate branch/workspace per conversation in the selected workspace's existing project.                    |

Set a default destination, then optionally override it for individual groups or
topics discovered by the bot. A group override applies to its topics unless a
topic has its own override. Changing a destination keeps the old chats and
worktrees. Profile settings apply when creating new agents; existing agents
keep their own settings.

You can leave the default empty and save only individual overrides. In that
case the connection shows **Ready for selected chats**; other conversations
cannot request agent replies until they have a destination.

Sharing an existing Paseo chat across multiple Telegram conversations requires
the explicit **Share this history** setting. Otherwise a second conversation is
rejected, including across separate bot connections. All authorized participants
inside the same Telegram group/topic use its same agent.

The linked agent is visible and usable in Paseo. Telegram-originated requests
and replies appear in both interfaces. Work initiated independently inside Paseo
is not automatically broadcast into Telegram.

## Choose who can use it

Group admission and permission to request work are configured independently for
each bot connection.

| Who can connect groups      | Behavior                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner only                  | The paired owner adds the bot; additions by other people are rejected. This is the default.                                                       |
| Owner and allowed users     | The owner and the configured Telegram user IDs can add the bot.                                                                                   |
| Approve each group in Paseo | Any addition, including one by the owner, waits under **Groups awaiting approval**. Approve or reject it in Paseo. Rejection makes the bot leave. |
| Anyone who can add the bot  | A group is connected immediately when the bot is added. Its request policy still applies.                                                         |

The owner must be paired before any group becomes active. Pending groups cannot
run agent work; `/status@your_bot` explains that approval is needed. Approval
checks that the bot is still a member. You can revoke admitted groups from the
settings screen. Changing admission policy does not revoke groups already
admitted; revoke them explicitly. Pending additions are evaluated under the new
saved policy on the receiver's next poll.

Direct messages default to **owner only**. Group requests default to **owner and
allowed users**. Group requests can instead allow **Group administrators** or
**All group members**. The paired owner is always allowed to request work.
The administrators policy verifies the sender against Telegram's administrator
list before dispatch and rechecks queued work and delivery. Allowed user IDs do
not bypass that policy. Lookup failure blocks unverified requests and reports
the issue in Paseo. Anonymous administrator messages do not identify a user and
are not accepted as user requests.

You can also allow anyone in direct messages. In groups, the default trigger is an `@mention`, an addressed
`/ask@your_bot` command, or a reply to the bot. An optional mode handles every
text message.

Existing installations keep their request permissions and owner-only admission
when upgrading from versions without the admission setting. Updates do not
silently open access, and an older settings payload cannot reset a new admission
choice.

Requests run with the linked agent's ordinary tools, credentials and permissions.
Separate histories and Git branches do not isolate the host's filesystem or
credentials. Choose the Paseo permission mode to match the people allowed to
send requests. Native clarification questions can be answered in Telegram by
replying with an option number or free text.

## Permissions and approvals

For workspace routes, **Permissions** configures newly created agents. Select
**Full access** (Claude `bypassPermissions`, or the provider's equivalent) if
these chats should run without routine tool prompts. Existing chats retain their
own permission mode and history when the profile changes.

When an agent needs approval, the original request stays attached. A single
English **Approval required** card lists its pending actions and updates as they
change. The paired owner and users listed in **Approval Telegram user IDs** can:

- **Allow all once**: answer only the requests listed on this card.
- **Always allow these tools**: use the provider's offered remembered grants for
  these exact tools, when supported. These grants use local project or session
  settings, not a plugin-wide auto-approval rule.
- **Deny all**: reject the listed requests.
- **Grant full access**: switch this existing chat to its supported full-access
  mode while preserving history, then release its unambiguous waiting tool calls.
  Providers can apply mode changes from the next turn; remaining native choices
  stay on the card. This does not change the bot's profile for future chats.
- Choose individual native actions when the provider offers multiple choices.

Reply to the exact card with `/approve` (or `/approve_all`), `/always_allow`,
`/deny`, or `/full_access` to use the same controls without pressing a button.
Unrelated text such as "allow it" is not interpreted as approval.

Approval authority is separate from permission to ask questions or Telegram
administrator status. Cards are bound to their bot, chat, topic, message, agent
and exact native request. Changed, completed and copied cards cannot approve
other work. Native requests are rechecked before responding. An unconfirmed
permission RPC is not replayed automatically, including after reload.

Decisions in Paseo also resume the original request. After all required choices
are resolved, the final answer returns to its original Telegram conversation;
the model prompt is not sent again. Native questions still require their actual
answers, even in a full-access chat. All connector-owned messages use English.

## While an agent works

- One editable message shows elapsed time, public progress and activity.
- The final answer replaces the progress message; long answers continue in
  additional messages.
- Bold, italic, code, links, quotes and lists use Telegram's native entities.
  Tables become labeled records that fit narrow screens.
- Requests are serialized per conversation and shared agent. Different agents
  can work concurrently.
- Pending requests survive reloads. Recovery follows the existing agent and
  checks dispatch receipts before sending anything again.
- Replies to questions are matched to the exact chat, topic and original form.
  They reach the native question form immediately, without waiting behind the
  task they are meant to unblock. If that task is still running, the reply gets
  an acknowledgement and the task's original progress message receives the final
  answer. Replies to questions from completed tasks wait for their new result.
- Questions already outstanding before a new request are not reposted under it.
  Their original Telegram messages remain replyable; a repeated answer does not
  create another agent prompt.
- Telegram write pacing and `retry_after` backoff apply across a chat's topics.

Private reasoning and tool arguments/output are excluded from progress updates.
All connector-generated service messages are English, including setup, progress,
clarification instructions and errors. User messages, agent commentary, question
content and final answers keep their original language.
This first release accepts text messages. Media input, voice transcription,
channel posts and Telegram Business connections are not implemented. Images in
agent Markdown remain links; diagrams and formulas are not rendered to images.

## Optional Git synchronization

Choose the remote and upstream branch. Before a new request, the connector
fetches upstream and checks the conversation's own branch while its agent is
idle. Clean branches fast-forward. Divergent committed work merges without
rewriting history. Staged, unstaged, untracked and ignored files are preserved.
Conflicts or local changes are handed to the agent for deliberate reconciliation;
an unresolved synchronization is marked in the reply.

The connector never automatically stashes, resets, rebases or force-pushes.
Clarification replies and resumed requests continue their original task without
fetching or changing Git mid-turn. It does not modify global Git identity or
Codex trust settings.

## Operation and updates

Reception starts with the daemon and works with the app closed. **Receive
Telegram messages** pauses reception/delivery while keeping chats and pending
requests. It does not stop running agents. Disconnecting removes the saved token
and connection configuration; it keeps chat history and worktrees.

Saved chats that are not currently loaded resume automatically before readiness
and Git checks. You do not need to open the Paseo chat first after a daemon
restart. Archived chats remain unavailable; running tasks and permission requests
keep their normal queue and attention behavior.

```sh
paseo plugin update telegram
```

Updates use Paseo's normal plugin manager. This repository has no host-specific
deployment, server timers or automatic changes to installed daemons.

Maintainers publish stable `v*` tags through GitHub Actions. npm trusts this
repository's `publish.yml` workflow through OIDC; no npm publishing token is
stored in GitHub. Publishing a release does not update anyone's daemon.

Connection data lives under `$PASEO_HOME/plugin-data/telegram` (or
`~/.paseo/plugin-data/telegram`). Tokens are in separate server-only files;
private files use mode `0600` and directories `0700` on Unix. Owner pairing stores
only a hash of the one-time nonce. Never publish this data directory or paste a
bot token into an issue.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run check:package
npm run pack
```

The browser check renders the actual cross-platform screen with fixture RPCs
and host UI adapters. It checks saving both routing modes, independent group policies,
approval/rejection, optional Bots, token
masking, React errors and overflow at desktop/phone widths. It requires Chromium
or Chrome:

```sh
CHROME_BIN=google-chrome npm run check:browser
```

With the Paseo CLI installed, `npm run check:daemon` launches a disposable daemon
with a simulated Telegram API and proves reception before any app/RPC connects.
It verifies headless reception, pending-group denial and native approval/rejection RPCs.
It never uses an existing daemon, bot token, model subscription or customer chat.

Pass an installation source and optional Git revision to verify a clean managed
installation. For example:

```sh
npm run check:daemon -- github:Daaaaave/paseo-telegram v0.2.0
npm run check:daemon -- npm:paseo-telegram@0.2.0
```

`npm run pack` writes the npm tarball to `.artifacts/`, omitting the Git-only
preparation command. Stable-tag releases publish that artifact through the
existing OIDC workflow.

Paseo 0.11 exposes the server API only from RPC/lifecycle callbacks. The small
`server/daemon.ts` adapter uses the matching, pinned SDK's local connection
transport and instance credential for headless startup. It accepts only local
IPC/loopback endpoints and leaves daemon configuration unchanged. See
[the architecture](docs/architecture.md) for boundaries and release details.

Licensed under MIT.
