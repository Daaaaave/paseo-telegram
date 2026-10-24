import { createHash, randomBytes } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { Connection } from "../shared/config.ts";
import type { TelegramMessage, TelegramUpdate } from "../shared/telegram.ts";
import type { Job, Store } from "./store.ts";
import type { AgentQueue } from "./routing.ts";
import { publicProgress } from "./progress.ts";
import { TelegramError, type Telegram } from "./telegram.ts";

type Agent = ReturnType<PaseoApi["agents"]["ref"]>;
type Snapshot = NonNullable<Awaited<ReturnType<Agent["refresh"]>>>;
export type Permission = NonNullable<
  Snapshot["agent"]["pendingPermissions"]
>[number];
type Response = Parameters<Agent["respondToPermission"]>[0]["response"];
type Callback = NonNullable<TelegramUpdate["callback_query"]>;
type Action = "once" | "remember" | "deny" | "full" | `a${number}_${number}`;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function permissionFingerprint(request: Permission): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          id: request.id,
          name: request.name,
          provider: request.provider,
          kind: request.kind,
          input: request.input,
          actions: request.actions,
          suggestions: request.suggestions,
        }),
      ),
    )
    .digest("hex");
}

/** Use the provider's own remembered grants, scoped to these exact tools. */
export function rememberedPermissions(request: Permission) {
  if (request.kind !== "tool" || !/^[\w.:-]+$/.test(request.name)) return [];
  return (request.suggestions ?? []).flatMap((suggestion) => {
    if (
      suggestion.type !== "addRules" ||
      suggestion.behavior !== "allow" ||
      !["localSettings", "session"].includes(String(suggestion.destination)) ||
      !Array.isArray(suggestion.rules) ||
      !suggestion.rules.length
    )
      return [];
    if (
      !suggestion.rules.every(
        (rule) =>
          rule &&
          typeof rule === "object" &&
          "toolName" in rule &&
          rule.toolName === request.name &&
          Object.keys(rule).every((key) =>
            ["toolName", "ruleContent"].includes(key),
          ) &&
          (!("ruleContent" in rule) || typeof rule.ruleContent === "string"),
      )
    )
      return [];
    return [
      {
        type: "addRules",
        behavior: "allow",
        destination: suggestion.destination,
        rules: suggestion.rules,
      },
    ];
  });
}

function responseFor(
  request: Permission,
  behavior: "allow" | "deny",
): Response | undefined {
  if (request.actions?.length) {
    const choices = request.actions.filter(
      (action) => action.behavior === behavior,
    );
    if (choices.length !== 1) return;
    return { behavior, selectedActionId: choices[0].id } as Response;
  }
  if (request.kind !== "tool" && behavior === "allow") return;
  return behavior === "deny" ? { behavior, interrupt: false } : { behavior };
}

export function fullAccessMode(snapshot: Snapshot): string | undefined {
  const known = ["bypassPermissions", "full-access"];
  return snapshot.agent.availableModes?.find((mode) => known.includes(mode.id))
    ?.id;
}

interface Options {
  telegram: Telegram;
  store: Store;
  api: PaseoApi;
  queue: AgentQueue;
  connection(): Connection;
  authorized(message: TelegramMessage): Promise<boolean>;
  signal: AbortSignal;
  setMode?: (agentId: string, modeId: string) => Promise<unknown>;
}

export class Approvals {
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
  }

  private actorAllowed(
    user: { id: number; is_bot?: boolean },
    job: Job,
  ): boolean {
    const { store, connection, signal } = this.options,
      config = connection();
    return (
      !signal.aborted &&
      config.enabled &&
      store.state.ownerId !== null &&
      !user.is_bot &&
      (user.id === store.state.ownerId ||
        config.policy.approvers.includes(user.id)) &&
      !!job.destination &&
      (job.destination.chatId > 0 ||
        !!store.state.groups[String(job.destination.chatId)])
    );
  }
  private scope(job: Job, message: TelegramMessage): boolean {
    return (
      !!job.destination &&
      job.destination.chatId === message.chat.id &&
      job.destination.topicId === (message.message_thread_id ?? 0) &&
      message.from?.id === this.options.connection().botId
    );
  }
  private locked<T>(job: Job, operation: () => Promise<T>): Promise<T> {
    return this.options.queue.run(
      `permission-control:${job.agentId}`,
      operation,
    );
  }

  async show(job: Job, pending: Permission[]): Promise<void> {
    await this.locked(job, () => this.render(job, pending));
  }
  private async render(
    job: Job,
    pending: Permission[],
    force = false,
  ): Promise<void> {
    if (!pending.some((request) => request.kind !== "question")) {
      await this.close(job);
      return;
    }
    if (
      !job.message ||
      !job.agentId ||
      !job.destination ||
      !(await this.options.authorized(job.message))
    )
      return;
    const snapshot = await this.options.api.agents.ref(job.agentId).refresh();
    if (!snapshot || snapshot.agent.archivedAt)
      throw new Error("The linked chat could not be checked.");
    const requests = (snapshot.agent.pendingPermissions ?? [])
      .filter((request) => request.kind !== "question")
      .slice(0, 100);
    if (!requests.length) {
      await this.close(job);
      return;
    }
    const saved = requests.map((request) => ({
      id: request.id,
      fingerprint: permissionFingerprint(request),
    }));
    const same =
      !job.approval?.closed &&
      job.approval?.agentId === job.agentId &&
      JSON.stringify(job.approval?.requests) === JSON.stringify(saved);
    if (!same)
      job.approval = {
        agentId: job.agentId,
        token: randomBytes(16).toString("hex"),
        requests: saved,
        messageId: job.approval?.messageId,
        attempted: !!job.approval?.messageId,
        text: "",
        closed: false,
      };
    const card = job.approval!;
    const full = snapshot && fullAccessMode(snapshot);
    const attempted = requests.some(
      (request) => job.approvalAttempts?.[request.id]?.agentId === job.agentId,
    );
    const labels = requests.slice(0, 8).map((request, i) => {
      const name = publicProgress(request.name).slice(0, 100) || "Agent action";
      const input = publicProgress(JSON.stringify(request.input ?? {})).slice(
        0,
        180,
      );
      return `${i + 1}. ${name}${input && input !== "{}" ? `\n   ${input}` : "\n   Input preview omitted."}`;
    });
    const text = `Approval required · ${requests.length} ${requests.length === 1 ? "action" : "actions"}\n\n${labels.join("\n\n")}${requests.length > 8 ? `\n\nAnd ${requests.length - 8} more actions.` : ""}\n\nOnly the bot owner and designated approvers can decide. Reply /approve to allow once, /always_allow to remember tool grants, /deny to reject, or /full_access to grant full access to this chat.${attempted ? "\n\nA response was already sent or could not be confirmed. It will not be replayed automatically; waiting for Paseo to update." : ""}`;
    const button = (label: string, action: Action) => ({
      text: label,
      callback_data: `pa:${card.token}:${action}`,
    });
    const keyboard: { text: string; callback_data: string }[][] = [];
    if (!attempted) {
      if (requests.every((request) => responseFor(request, "allow")))
        keyboard.push([
          button(
            requests.length === 1 ? "Allow once" : "Allow all once",
            "once",
          ),
        ]);
      if (
        requests.every(
          (request) =>
            responseFor(request, "allow") &&
            rememberedPermissions(request).length,
        )
      )
        keyboard.push([button("Always allow these tools", "remember")]);
      if (requests.every((request) => responseFor(request, "deny")))
        keyboard.push([button("Deny all", "deny")]);
      for (const [index, request] of requests.slice(0, 8).entries())
        for (const [choice, action] of (request.actions ?? [])
          .slice(0, 10)
          .entries())
          keyboard.push([
            button(
              `${index + 1}: ${publicProgress(action.label).slice(0, 50) || action.behavior}`,
              `a${index}_${choice}`,
            ),
          ]);
    }
    if (full && this.options.setMode)
      keyboard.push([button("Grant full access", "full")]);
    if (same && card.text === text && !force) return;
    card.text = text;
    await this.options.store.save();
    const payload = {
      chat_id: job.destination.chatId,
      text,
      reply_markup: { inline_keyboard: keyboard },
      ...(job.destination.topicId
        ? { message_thread_id: job.destination.topicId }
        : {}),
    };
    try {
      if (card.messageId)
        await this.options.telegram.call(
          "editMessageText",
          { ...payload, message_id: card.messageId },
          this.options.signal,
        );
      else if (!card.attempted) {
        card.attempted = true;
        await this.options.store.save();
        const sent = await this.options.telegram.call<{ message_id: number }>(
          "sendMessage",
          {
            ...payload,
            reply_parameters: {
              message_id: job.message.message_id,
              allow_sending_without_reply: true,
            },
          },
          this.options.signal,
        );
        card.messageId = sent.message_id;
        await this.options.store.save();
      }
    } catch (error) {
      if (
        !(error instanceof TelegramError) ||
        error.reason !== "not_modified"
      ) {
        // Retry only an idempotent edit. An uncertain initial send needs its callback
        // to prove the message ID, rather than posting duplicate approval cards.
        card.text = "";
        await this.options.store.save();
        throw new Error(
          "The approval card could not be confirmed by Telegram; the task is still waiting.",
        );
      }
    }
  }

  async close(job: Job): Promise<void> {
    const card = job.approval;
    if (!card || card.closed) return;
    card.closed = true;
    await this.options.store.save();
    if (card.messageId && job.destination) {
      try {
        await this.options.telegram.call(
          "editMessageText",
          {
            chat_id: job.destination.chatId,
            message_id: card.messageId,
            text: "Approval resolved. The agent is continuing its task.",
            reply_markup: { inline_keyboard: [] },
          },
          this.options.signal,
        );
      } catch {
        /* Old buttons also fail the closed-card check. */
      }
    }
  }

  async callback(query: Callback): Promise<void> {
    const match =
      /^pa:([a-f0-9]{32}):(once|remember|deny|full|a\d{1,2}_\d{1,2})$/.exec(
        query.data ?? "",
      );
    if (!match) return;
    const job = Object.values(this.options.store.state.jobs).find(
      (job) => job.approval?.token === match[1],
    );
    const notify = (text: string) =>
      this.options.telegram.call(
        "answerCallbackQuery",
        { callback_query_id: query.id, text, show_alert: true },
        this.options.signal,
      );
    if (
      !job ||
      !query.message ||
      !this.scope(job, query.message) ||
      (job.approval?.messageId !== undefined &&
        job.approval.messageId !== query.message.message_id)
    ) {
      await notify("This approval card is no longer available.");
      return;
    }
    if (!this.actorAllowed(query.from, job)) {
      await notify(
        "Only the bot owner and designated approvers can approve actions.",
      );
      return;
    }
    if (job.approval!.closed || job.delivery) {
      await notify("This approval has already been resolved.");
      return;
    }
    // Stop Telegram's spinner before performing native RPCs or rate-limited edits.
    await this.options.telegram.call(
      "answerCallbackQuery",
      {
        callback_query_id: query.id,
        text: "Checking this approval…",
        cache_time: 0,
      },
      this.options.signal,
    );
    await this.locked(job, async () => {
      if (
        job.approval?.token !== match[1] ||
        job.approval.closed ||
        job.delivery
      ) {
        await this.reply(
          job,
          "This approval has already been resolved or replaced.",
        );
        return;
      }
      // An authenticated Telegram callback proves an uncertain initial send's ID.
      job.approval!.messageId ??= query.message!.message_id;
      await this.options.store.save();
      const text = await this.apply(
        job,
        match[1],
        match[2] as Action,
        query.from,
      ).catch(
        () =>
          "The approval could not be completed. No automatic retry was made.",
      );
      if (text) await this.reply(job, text);
    });
  }

  async command(message: TelegramMessage): Promise<boolean> {
    const command =
      /^\/(approve|approve_all|always_allow|deny|full_access)(?:@(\w+))?\s*$/i.exec(
        message.text?.trim() ?? "",
      );
    if (
      !command ||
      (command[2] &&
        command[2].toLowerCase() !==
          this.options.connection().username.toLowerCase())
    )
      return false;
    if (!message.from || message.from.is_bot || message.sender_chat)
      return true;
    const job = Object.values(this.options.store.state.jobs).find(
      (job) =>
        job.approval?.messageId !== undefined &&
        job.approval.messageId === message.reply_to_message?.message_id &&
        !!job.destination &&
        job.destination.chatId === message.chat.id &&
        job.destination.topicId === (message.message_thread_id ?? 0) &&
        message.reply_to_message?.from?.id === this.options.connection().botId,
    );
    if (!job || !message.from || !this.actorAllowed(message.from, job)) {
      // An unrecognized command must never become an ordinary model prompt.
      if (
        message.from &&
        this.options.store.state.ownerId !== null &&
        (message.chat.id > 0 ||
          this.options.store.state.groups[String(message.chat.id)])
      )
        await this.options.telegram.call(
          "sendMessage",
          {
            chat_id: message.chat.id,
            ...(message.message_thread_id
              ? { message_thread_id: message.message_thread_id }
              : {}),
            text: job
              ? "Only the bot owner and designated approvers can approve actions."
              : "Reply to the bot's approval card with this command.",
          },
          this.options.signal,
        );
      return true;
    }
    const action = {
      approve: "once",
      approve_all: "once",
      always_allow: "remember",
      deny: "deny",
      full_access: "full",
    }[command[1].toLowerCase()] as Action;
    await this.locked(job, async () => {
      const text = await this.apply(
        job,
        job.approval!.token,
        action,
        message.from!,
      ).catch(
        () =>
          "The approval could not be completed. No automatic retry was made.",
      );
      if (text) await this.reply(job, text);
    });
    return true;
  }

  private async reply(job: Job, text: string): Promise<void> {
    if (!job.destination) return;
    await this.options.telegram.call(
      "sendMessage",
      {
        chat_id: job.destination.chatId,
        text,
        ...(job.destination.topicId
          ? { message_thread_id: job.destination.topicId }
          : {}),
      },
      this.options.signal,
    );
  }

  private async apply(
    job: Job,
    token: string,
    action: Action,
    actor: { id: number; is_bot?: boolean },
  ): Promise<string | undefined> {
    const { api, store, authorized, setMode, signal } = this.options;
    if (
      !this.actorAllowed(actor, job) ||
      !job.message ||
      !(await authorized(job.message))
    )
      return "This conversation is no longer authorized.";
    const card = job.approval;
    if (
      !card ||
      card.token !== token ||
      card.closed ||
      job.delivery ||
      card.agentId !== job.agentId
    )
      return "This approval has already been resolved or replaced.";
    const agentId = card.agentId,
      agent = api.agents.ref(agentId);
    let snapshot = await agent.refresh();
    if (
      !snapshot ||
      snapshot.agent.archivedAt ||
      snapshot.agent.status === "closed"
    )
      return "The linked chat is unavailable.";
    const current = snapshot.agent.pendingPermissions ?? [];
    const selected = card.requests.flatMap((saved) => {
      const request = current.find((request) => request.id === saved.id);
      return request ? [{ request, saved }] : [];
    });
    if (!selected.length) {
      await this.render(job, current, true);
      return "These requests have already been resolved.";
    }
    if (
      selected.some(
        ({ request, saved }) =>
          permissionFingerprint(request) !== saved.fingerprint,
      )
    ) {
      await this.render(job, current, true);
      return "The approval changed. Review the updated card before deciding.";
    }
    let requests = selected.map(({ request }) => request);
    const individual = /^a(\d+)_(\d+)$/.exec(action);
    if (individual) {
      const saved = card.requests[Number(individual[1])];
      const request =
        saved && requests.find((request) => request.id === saved.id);
      if (!request?.actions?.[Number(individual[2])])
        return "This choice is no longer available.";
      requests = [request];
    }
    if (action === "full") {
      const mode = fullAccessMode(snapshot);
      if (!mode || !setMode)
        return "Full access is unavailable for this provider. Use the individual approval choices.";
      job.modeGrant = {
        agentId,
        modeId: mode,
        actor: actor.id,
        at: Date.now(),
        confirmed: false,
      };
      await store.save();
      try {
        if (!(await authorized(job.message)) || !this.actorAllowed(actor, job))
          return "This conversation is no longer authorized.";
        if (job.agentId !== agentId)
          return "The chat continued in a new agent. Review its updated approval card.";
        await setMode(agentId, mode);
        snapshot = await agent.refresh();
        if (snapshot?.agent.currentModeId !== mode)
          throw new Error("Mode not confirmed");
        job.modeGrant.confirmed = true;
        await store.save();
      } catch {
        return "Full access could not be confirmed. The waiting requests were not approved.";
      }
      // Changing mode does not answer permission promises that were already open.
      requests = requests.filter(
        (request) => request.kind === "tool" && responseFor(request, "allow"),
      );
    }
    if (
      action === "remember" &&
      !requests.every(
        (request) =>
          rememberedPermissions(request).length &&
          responseFor(request, "allow"),
      )
    )
      return "This provider did not offer remembered grants for all these tools. Use Allow once instead.";
    if (
      (action === "once" || action === "deny") &&
      !requests.every((request) =>
        responseFor(request, action === "deny" ? "deny" : "allow"),
      )
    )
      return "These requests need an individual choice. Use the buttons for each action.";
    for (const request of requests) {
      if (!this.actorAllowed(actor, job) || !(await authorized(job.message)))
        return "This conversation is no longer authorized.";
      if (job.agentId !== agentId)
        return "The chat continued in a new agent. Review its updated approval card.";
      if (job.approvalAttempts?.[request.id]?.agentId === agentId) continue;
      const fresh = await agent.refresh();
      const live = fresh?.agent.pendingPermissions?.find(
        (value) => value.id === request.id,
      );
      if (!live) continue;
      if (permissionFingerprint(live) !== permissionFingerprint(request))
        return "The request changed. Review the updated approval card.";
      const choice = individual
        ? request.actions![Number(individual[2])]
        : undefined;
      const response = choice
        ? ({
            behavior: choice.behavior,
            selectedActionId: choice.id,
          } as Response)
        : responseFor(request, action === "deny" ? "deny" : "allow")!;
      if (action === "remember" && response.behavior === "allow")
        response.updatedPermissions = rememberedPermissions(request);
      const attempt = {
        agentId,
        fingerprint: permissionFingerprint(request),
        action,
        actor: actor.id,
        at: Date.now(),
        status: "sending" as "sending" | "confirmed" | "uncertain",
      };
      (job.approvalAttempts ??= {})[request.id] = attempt;
      await store.save();
      if (
        !(await authorized(job.message)) ||
        !this.actorAllowed(actor, job) ||
        job.agentId !== agentId
      ) {
        delete job.approvalAttempts![request.id];
        await store.save();
        return "This conversation is no longer authorized.";
      }
      try {
        await agent.respondToPermission({ requestId: request.id, response });
        attempt.status = "confirmed";
      } catch {
        attempt.status = "uncertain";
        await store.save();
        await this.render(
          job,
          (await agent.refresh())?.agent.pendingPermissions ?? current,
          true,
        );
        return "A permission response could not be confirmed. It will not be sent again automatically.";
      }
      await store.save();
    }
    await this.render(
      job,
      (await agent.refresh())?.agent.pendingPermissions ?? current,
      true,
    );
    return action === "full"
      ? `Full access is enabled for this chat. Its history is preserved. ${job.approval?.closed ? "The agent is continuing its task." : "Review any remaining approval choices on the card."}`
      : undefined;
  }
}
