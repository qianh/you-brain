import { conversationKey } from "@you-brain/protocol";

import { type SessionSource } from "../domain/session.js";

import { YouBrainError } from "../domain/errors.js";
import type { DrivePort } from "../drive/drive-port.js";
import { readPortraitFile } from "../http/portrait-files.js";
import { createStoreReaders } from "../http/queries.js";
import type { SqliteStore } from "../store/index.js";
import type {
  ActionResponse,
  SearchRequest,
  SearchResponse,
  StatusResponse,
  TopicMutationBody,
  TopicMutationResponse,
  UploadActionInput,
  UploadActionResult,
  ZoneSettings,
} from "../http/types.js";
import { callDaemon, DaemonCallError } from "./daemon-api.js";
import type { McpServices, SessionContent, UpdateTopicInput } from "./server.js";

export interface LocalSearchInput {
  query: string;
  limit: number;
  sources?: string[];
  since?: string;
  until?: string;
}

export interface LocalSearch {
  search(input: LocalSearchInput): Promise<SearchResponse>;
  /**
   * Read the local index only. search_sessions prefers this so a tool call
   * does not start a Drive sync (技术方案 13.1).
   */
  query?(input: LocalSearchInput): Promise<SearchResponse>;
  status?():
    | { ready: boolean; documents: number }
    | Promise<{ ready: boolean; documents: number }>;
}

export interface LocalMcpOptions {
  store: SqliteStore;
  search: LocalSearch;
  drive: DrivePort;
  portraitDir: string;
  dataDir: string;
  zone: ZoneSettings;
  fetch?: typeof fetch;
  status?: () => StatusResponse | Promise<StatusResponse>;
}

type Call = <T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
) => Promise<T>;

export function createLocalMcpServices(options: LocalMcpOptions): McpServices {
  const readers = createStoreReaders(options.store, options.zone);
  const call: Call = (method, path, body) =>
    callDaemon({
      dataDir: options.dataDir,
      method,
      path,
      ...(body !== undefined ? { body } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

  return {
    searchSessions(input: SearchRequest) {
      const run = options.search.query ?? options.search.search;
      return run.call(options.search, {
        query: input.query,
        limit: input.limit ?? 10,
        ...(input.sources ? { sources: input.sources } : {}),
        ...(input.from ? { since: input.from } : {}),
        ...(input.to ? { until: input.to } : {}),
      });
    },
    getSession(input) {
      return readInboxSession(options.drive, input);
    },
    async getPortrait(input) {
      const variant = input.variant ?? "full";
      const portrait = await readPortraitFile(options.portraitDir, variant);
      if (!portrait) {
        throw new YouBrainError("SOURCE_UNAVAILABLE", `数字分身 ${variant} 不存在`);
      }
      return {
        variant: portrait.variant,
        portrait: portrait.content,
        warnings: [],
      };
    },
    async hubStatus() {
      if (options.status) return options.status();
      const search = options.search.status
        ? await options.search.status()
        : { ready: false, documents: 0 };
      return {
        drive: { reachable: null },
        inbox: {},
        warnings: [],
        devices: options.store.listDevices(),
        topics: options.store
          .listTopics()
          .filter((topic) => topic.mergedInto === null).length,
        search,
      };
    },
    uploadSessions(input: UploadActionInput) {
      return call<UploadActionResult>("POST", "/api/actions/upload", input);
    },
    getToday: () => readers.today(),
    getTopics: (query) => readers.topics(query),
    async getTopic(topicId) {
      const topic = await readers.topic(topicId);
      if (!topic) throw new DaemonCallError("NOT_FOUND", "话题不存在");
      return topic;
    },
    updateTopic(input) {
      return forwardUpdate(call, input);
    },
    getReminders: () => readers.reminders(false),
  };
}

function forwardUpdate(
  call: Call,
  input: UpdateTopicInput,
): Promise<TopicMutationResponse | ActionResponse> {
  if (input.action === "todo") {
    return call<ActionResponse>("POST", "/api/actions/todo", {
      todoId: input.todo_id,
      status: input.status,
    });
  }
  if (input.action === "conclusion") {
    return call<ActionResponse>("POST", "/api/actions/conclusion", {
      topicId: input.topic_id,
      text: input.text,
      sessionKey: input.session_key,
    });
  }
  const path = `/api/topics/${encodeURIComponent(input.topic_id)}`;
  if (input.action === "status") {
    return call<TopicMutationResponse>("POST", path, {
      op: "status",
      status: input.status,
    });
  }
  if (input.action === "rename") {
    const body: TopicMutationBody = {
      op: "rename",
      name: input.name,
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
    };
    return call<TopicMutationResponse>("POST", path, body);
  }
  if (input.action === "merge") {
    return call<TopicMutationResponse>("POST", path, {
      op: "merge",
      intoTopicId: input.into_topic_id,
    });
  }
  const assignTopicId = input.assign_topic_id;
  const createName = input.create_name;
  if ((assignTopicId === undefined) === (createName === undefined)) {
    throw new DaemonCallError(
      "INVALID_INPUT",
      "拆分需要指定已有话题或新话题名称，不能同时指定",
    );
  }
  const target =
    assignTopicId !== undefined
      ? { action: "assign" as const, topicId: assignTopicId }
      : {
          action: "create" as const,
          name: createName ?? "",
          ...(input.create_aliases !== undefined
            ? { aliases: input.create_aliases }
            : {}),
        };
  return call<TopicMutationResponse>("POST", path, {
    op: "split",
    sessionKey: input.session_key,
    target,
  });
}

export async function readInboxSession(
  drive: DrivePort,
  input: { source: SessionSource; conversationId: string },
): Promise<SessionContent> {
  const key = conversationKey(input.source, input.conversationId);
  const entries = await drive.list({
    prefix: "inbox/",
    appProperty: { key: "brainhubKey", value: key },
  });
  const entry = entries
    .filter(
      (candidate) =>
        candidate.path.startsWith("inbox/") &&
        candidate.mimeType === "text/markdown" &&
        candidate.appProperties.source === input.source &&
        candidate.appProperties.conversationId === input.conversationId,
    )
    .sort(
      (left, right) =>
        (right.appProperties.updatedAt ?? right.modifiedTime).localeCompare(
          left.appProperties.updatedAt ?? left.modifiedTime,
        ) || right.id.localeCompare(left.id),
    )[0];
  if (!entry) {
    throw new YouBrainError(
      "SESSION_NOT_FOUND",
      `找不到会话 ${input.source}/${input.conversationId}`,
    );
  }
  const object = await drive.read(entry.id);
  return {
    source: input.source,
    conversationId: input.conversationId,
    content: object.bytes.toString("utf8"),
    updatedAt: entry.appProperties.updatedAt ?? entry.modifiedTime,
  };
}
