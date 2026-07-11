import { createHmac, timingSafeEqual } from "node:crypto";
import { Octokit } from "@octokit/rest";
import {
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  Message,
  parseMarkdown,
  type RawMessage,
  stringifyMarkdown,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import type { BotThreadContext } from "@/lib/bots/context";
import { getRepoToken } from "@/lib/knowledge/github";

export interface GitHubThreadId {
  owner: string;
  repo: string;
  issueNumber: number;
}

export interface UnifiedGitHubAdapterConfig {
  webhookSecret: string;
  userName: string;
  replyToNewIssues?: boolean;
}

type GitHubRawMessage = {
  type: "issue" | "issue_comment";
  id: number;
  body: string;
  user: { login: string; type: string };
  created_at: string;
};

type GitHubComment = {
  id: number;
  body: string;
  user: {
    id: number;
    login: string;
    avatar_url: string;
    type: string;
  };
  created_at: string;
};

type GitHubIssueCommentPayload = {
  action: "created" | "edited" | "deleted";
  issue: {
    number: number;
  };
  comment: GitHubComment;
  repository: {
    name: string;
    owner: { login: string };
  };
};

type GitHubIssuesPayload = {
  action: string;
  issue: {
    id: number;
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    created_at: string;
  };
  repository: {
    name: string;
    owner: { login: string };
  };
};

export class UnifiedGitHubAdapter
  implements Adapter<GitHubThreadId, GitHubRawMessage>
{
  readonly name = "github";
  readonly userName: string;

  private static readonly EMOJI_MAP: Record<string, string> = {
    thumbs_up: "+1",
    thumbs_down: "-1",
  };

  private readonly webhookSecret: string;
  private readonly replyToNewIssues: boolean;
  private chat: ChatInstance | null = null;
  private octokitCache = new Map<
    string,
    { octokit: Octokit; expiresAt: number }
  >();

  constructor(config: UnifiedGitHubAdapterConfig) {
    this.userName = config.userName;
    this.webhookSecret = config.webhookSecret;
    this.replyToNewIssues = config.replyToNewIssues ?? false;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  private resolveEmoji(emojiInput: EmojiValue | string): string {
    const name = typeof emojiInput === "string" ? emojiInput : emojiInput.name;
    return UnifiedGitHubAdapter.EMOJI_MAP[name] ?? name;
  }

  private async getOctokit(owner: string, repo: string): Promise<Octokit> {
    const cacheKey = `${owner}/${repo}`;
    const cached = this.octokitCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.octokit;
    }

    const token = await getRepoToken(cacheKey);
    if (!token) {
      throw new Error(`GitHub credentials are unavailable for ${cacheKey}`);
    }

    const octokit = new Octokit({ auth: token });
    this.octokitCache.set(cacheKey, {
      octokit,
      expiresAt: Date.now() + 50 * 60 * 1000,
    });
    return octokit;
  }

  private verifySignature(body: string, signature: string | null): boolean {
    if (!(signature && this.webhookSecret)) {
      return false;
    }

    const expected = `sha256=${createHmac("sha256", this.webhookSecret).update(body).digest("hex")}`;
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  async handleWebhook(
    request: Request,
    options?: WebhookOptions
  ): Promise<Response> {
    const body = await request.text();
    const signature = request.headers.get("X-Hub-Signature-256");
    const eventType = request.headers.get("X-GitHub-Event");

    if (!this.verifySignature(body, signature)) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    if (eventType === "ping") {
      return new Response(JSON.stringify({ ok: true, message: "pong" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (eventType === "issue_comment") {
      const payload = JSON.parse(body) as GitHubIssueCommentPayload;
      if (payload.action !== "created") {
        return Response.json({ ok: true });
      }

      const botUserName = `${this.userName}[bot]`;
      if (
        payload.comment.user.login === this.userName ||
        payload.comment.user.login === botUserName
      ) {
        return Response.json({ ok: true });
      }

      const threadId = this.encodeThreadId({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issueNumber: payload.issue.number,
      });

      const message = this.parseMessage({
        type: "issue_comment",
        id: payload.comment.id,
        body: payload.comment.body,
        user: payload.comment.user,
        created_at: payload.comment.created_at,
      });

      this.chat?.processMessage(this, threadId, message, options);
      return Response.json({ ok: true });
    }

    if (eventType === "issues") {
      const payload = JSON.parse(body) as GitHubIssuesPayload;
      if (payload.action !== "opened") {
        return Response.json({ ok: true });
      }

      const botUserName = `${this.userName}[bot]`;
      if (
        payload.issue.user.login === this.userName ||
        payload.issue.user.login === botUserName
      ) {
        return Response.json({ ok: true });
      }

      const issueText = `${payload.issue.title}\n\n${payload.issue.body || ""}`;
      const hasMention = issueText.includes(`@${this.userName}`);
      if (!(this.replyToNewIssues || hasMention)) {
        return Response.json({ ok: true });
      }

      const threadId = this.encodeThreadId({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issueNumber: payload.issue.number,
      });

      const message = this.parseMessage({
        type: "issue",
        id: payload.issue.id,
        body: issueText,
        user: { ...payload.issue.user, type: "User" },
        created_at: payload.issue.created_at,
      });
      message.isMention = true;

      this.chat?.processMessage(this, threadId, message, options);
      return Response.json({ ok: true });
    }

    return Response.json({ ok: true });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<GitHubRawMessage>> {
    const { owner, repo, issueNumber } = this.decodeThreadId(threadId);
    const octokit = await this.getOctokit(owner, repo);
    const body =
      typeof message === "string"
        ? message
        : (message as { markdown?: string }).markdown || String(message);

    const { data } = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });

    return {
      id: String(data.id),
      threadId,
      raw: {
        type: "issue_comment",
        id: data.id,
        body: data.body || "",
        user: { login: data.user?.login || "", type: data.user?.type || "" },
        created_at: data.created_at,
      },
    };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<GitHubRawMessage>> {
    const { owner, repo } = this.decodeThreadId(threadId);
    const octokit = await this.getOctokit(owner, repo);
    const body =
      typeof message === "string"
        ? message
        : (message as { markdown?: string }).markdown || String(message);

    const { data } = await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: Number(messageId),
      body,
    });

    return {
      id: String(data.id),
      threadId,
      raw: {
        type: "issue_comment",
        id: data.id,
        body: data.body || "",
        user: { login: data.user?.login || "", type: data.user?.type || "" },
        created_at: data.created_at,
      },
    };
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const { owner, repo } = this.decodeThreadId(threadId);
    const octokit = await this.getOctokit(owner, repo);

    await octokit.issues.deleteComment({
      owner,
      repo,
      comment_id: Number(messageId),
    });
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    const { owner, repo, issueNumber } = this.decodeThreadId(threadId);
    const octokit = await this.getOctokit(owner, repo);
    const content = this.resolveEmoji(emoji) as
      | "+1"
      | "-1"
      | "laugh"
      | "confused"
      | "heart"
      | "hooray"
      | "rocket"
      | "eyes";

    if (messageId.startsWith("issue:")) {
      await octokit.reactions.createForIssue({
        owner,
        repo,
        issue_number: issueNumber,
        content,
      });
      return;
    }

    await octokit.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: Number(messageId),
      content,
    });
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    const { owner, repo, issueNumber } = this.decodeThreadId(threadId);
    const octokit = await this.getOctokit(owner, repo);
    const resolvedEmoji = this.resolveEmoji(emoji);
    const botUserName = `${this.userName}[bot]`;

    if (messageId.startsWith("issue:")) {
      const { data: reactions } = await octokit.reactions.listForIssue({
        owner,
        repo,
        issue_number: issueNumber,
      });

      const ourReaction = reactions.find(
        (reaction) =>
          reaction.content === resolvedEmoji &&
          (reaction.user?.login === this.userName ||
            reaction.user?.login === botUserName)
      );
      if (!ourReaction) {
        return;
      }

      await octokit.reactions.deleteForIssue({
        owner,
        repo,
        issue_number: issueNumber,
        reaction_id: ourReaction.id,
      });
      return;
    }

    const { data: reactions } = await octokit.reactions.listForIssueComment({
      owner,
      repo,
      comment_id: Number(messageId),
    });

    const ourReaction = reactions.find(
      (reaction) =>
        reaction.content === resolvedEmoji &&
        (reaction.user?.login === this.userName ||
          reaction.user?.login === botUserName)
    );
    if (!ourReaction) {
      return;
    }

    await octokit.reactions.deleteForIssueComment({
      owner,
      repo,
      comment_id: Number(messageId),
      reaction_id: ourReaction.id,
    });
  }

  async startTyping(_threadId: string): Promise<void> {}

  async fetchMessages(
    threadId: string,
    options?: FetchOptions
  ): Promise<FetchResult<GitHubRawMessage>> {
    const { owner, repo, issueNumber } = this.decodeThreadId(threadId);
    const octokit = await this.getOctokit(owner, repo);
    const perPage = options?.limit || 30;

    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: perPage,
      ...(options?.cursor ? { since: options.cursor } : {}),
    });

    return {
      messages: comments.map((comment) =>
        this.parseMessage({
          type: "issue_comment",
          id: comment.id,
          body: comment.body || "",
          user: {
            login: comment.user?.login || "",
            type: comment.user?.type || "",
          },
          created_at: comment.created_at,
        })
      ),
    };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { owner, repo, issueNumber } = this.decodeThreadId(threadId);
    const octokit = await this.getOctokit(owner, repo);

    const { data: issue } = await octokit.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    return {
      id: threadId,
      channelId: `${owner}/${repo}`,
      channelName: `${owner}/${repo}#${issueNumber}`,
      metadata: {
        title: issue.title,
        state: issue.state,
        labels: issue.labels.map((label) =>
          typeof label === "string" ? label : label.name || ""
        ),
      },
    };
  }

  channelIdFromThreadId(threadId: string): string {
    const { owner, repo } = this.decodeThreadId(threadId);
    return `github:${owner}/${repo}`;
  }

  encodeThreadId(data: GitHubThreadId): string {
    return `github:${data.owner}/${data.repo}:issue:${data.issueNumber}`;
  }

  decodeThreadId(threadId: string): GitHubThreadId {
    const match = threadId.match(/^github:([^/]+)\/([^:]+):issue:(\d+)$/);
    if (!(match?.[1] && match[2] && match[3])) {
      throw new Error("Invalid GitHub thread ID");
    }

    return {
      owner: match[1],
      repo: match[2],
      issueNumber: Number.parseInt(match[3], 10),
    };
  }

  parseMessage(raw: GitHubRawMessage): Message<GitHubRawMessage> {
    const botUserName = `${this.userName}[bot]`;
    const isBot =
      raw.user.type === "Bot" ||
      raw.user.login === this.userName ||
      raw.user.login === botUserName;
    const isMention = !isBot && raw.body.includes(`@${this.userName}`);

    return new Message<GitHubRawMessage>({
      id: raw.type === "issue" ? `issue:${raw.id}` : String(raw.id),
      threadId: "",
      text: raw.body,
      formatted: parseMarkdown(raw.body),
      raw,
      author: {
        userId: raw.user.login,
        userName: raw.user.login,
        fullName: raw.user.login,
        isBot,
        isMe: isBot,
      },
      metadata: {
        dateSent: new Date(raw.created_at),
        edited: false,
      },
      attachments: [],
      isMention,
    });
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  async fetchThreadContext(threadId: string): Promise<BotThreadContext> {
    const { owner, repo, issueNumber } = this.decodeThreadId(threadId);
    const octokit = await this.getOctokit(owner, repo);

    const [{ data: issue }, { data: comments }] = await Promise.all([
      octokit.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      }),
      octokit.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 10,
        direction: "desc",
      }),
    ]);

    return {
      platform: "github",
      number: issue.number,
      title: issue.title,
      body: issue.body || "",
      labels: issue.labels.map((label) =>
        typeof label === "string" ? label : label.name || ""
      ),
      state: issue.state,
      source: `${owner}/${repo}`,
      previousComments: comments.reverse().map((comment) => ({
        author: comment.user?.login || "unknown",
        body: comment.body || "",
        isBot: comment.user?.type === "Bot",
      })),
    };
  }
}
