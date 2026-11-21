/**
 * 会话落盘（K-05 壳层补偿：会话不依赖 Pi 原生存储，由宿主托管）。
 *
 * 布局（产品设计文档第 6 章）：
 *   <dataDir>/sessions/index.json            会话索引（可由目录扫描重建的缓存）
 *   <dataDir>/sessions/<id>/session.json     会话元数据
 *   <dataDir>/sessions/<id>/events.jsonl     append-only 事件日志（每条带自增 seq）
 *
 * 完整性：加载时逐行校验 JSON 与 seq 连续性；尾部损坏（进程被强杀写一半）可检测，
 * 恢复到最后一个完整记录并就地修复文件，恢复动作以 RecoveryInfo 显形返回，不静默。
 * 元数据（session.json）损坏则抛 SessionStoreError 大声报错，不假装恢复。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SessionStoreError } from "./errors.js";

export interface SessionMeta {
  id: string;
  title: string;
  workspaceDir: string;
  /** Pi 侧会话 id（握手后回填），与宿主 id 分离。 */
  piSessionId: string | null;
  /**
   * Pi 原生会话文件路径（握手后回填）：宿主给每个会话分配独立 --session-dir，
   * Pi 的落盘会话文件就在其中；续接（resume）时以 --session 指回此文件。
   * 旧会话（--no-session 时代）无此文件，不可续接（resume 时大声报错）。
   */
  piSessionFile: string | null;
  /** 只记通道与模型，不记任何账号标识（设计文档 6.2）。 */
  modelRef: { provider: string; modelId: string } | null;
  createdAt: string;
  updatedAt: string;
  /** live = 有子进程托管中；closed = 已正常结束；aborted = 异常终止。 */
  status: "live" | "closed" | "aborted";
  eventCount: number;
}

export interface StoredEvent {
  seq: number;
  ts: string;
  kind: string;
  [key: string]: unknown;
}

export interface RecoveryInfo {
  /** 成功恢复的事件条数。 */
  recoveredEvents: number;
  /** 被丢弃的损坏行数（尾部）。 */
  droppedLines: number;
  reason: string;
}

export interface LoadSessionResult {
  meta: SessionMeta;
  events: StoredEvent[];
  recovery: RecoveryInfo | null;
}

const INDEX_VERSION = 1;

export class SessionStore {
  private readonly sessionsDir: string;
  private metas = new Map<string, SessionMeta>();

  constructor(private readonly dataDir: string) {
    this.sessionsDir = join(dataDir, "sessions");
  }

  /** 建目录并从磁盘重建内存索引（宿主重启后据此重新列出历史会话）。 */
  init(): void {
    mkdirSync(this.sessionsDir, { recursive: true });
    this.metas.clear();
    for (const entry of readdirSync(this.sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(this.sessionsDir, entry.name, "session.json");
      if (!existsSync(metaPath)) continue;
      const meta = this.readMeta(entry.name, metaPath);
      // 上次进程若被强杀，live 状态已失真：重启后一律标为 aborted（显形，不假装还活着）。
      if (meta.status === "live") meta.status = "aborted";
      this.metas.set(meta.id, meta);
    }
    this.writeIndex();
  }

  createSession(input: {
    title: string;
    workspaceDir: string;
    modelRef?: { provider: string; modelId: string } | null;
  }): SessionMeta {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: randomUUID(),
      title: input.title,
      workspaceDir: input.workspaceDir,
      piSessionId: null,
      piSessionFile: null,
      modelRef: input.modelRef ?? null,
      createdAt: now,
      updatedAt: now,
      status: "live",
      eventCount: 0,
    };
    mkdirSync(this.sessionDir(meta.id), { recursive: true });
    writeFileSync(this.eventsPath(meta.id), "", "utf8");
    this.metas.set(meta.id, meta);
    this.persistMeta(meta);
    this.writeIndex();
    return meta;
  }

  /** 追加一条事件（append-only，同步落盘）。返回写入的完整记录。 */
  append(sessionId: string, kind: string, payload: Record<string, unknown> = {}): StoredEvent {
    const meta = this.requireMeta(sessionId);
    const record: StoredEvent = {
      ...payload,
      seq: meta.eventCount + 1,
      ts: new Date().toISOString(),
      kind,
    };
    appendFileSync(this.eventsPath(sessionId), JSON.stringify(record) + "\n", "utf8");
    meta.eventCount += 1;
    meta.updatedAt = record.ts;
    this.persistMeta(meta);
    this.writeIndex();
    return record;
  }

  /** 更新元数据字段并落盘（如握手回填 piSessionId、状态迁移）。 */
  updateMeta(sessionId: string, patch: Partial<SessionMeta>): SessionMeta {
    const meta = this.requireMeta(sessionId);
    Object.assign(meta, patch, { id: meta.id });
    meta.updatedAt = new Date().toISOString();
    this.persistMeta(meta);
    this.writeIndex();
    return meta;
  }

  listSessions(): SessionMeta[] {
    return [...this.metas.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getMeta(sessionId: string): SessionMeta {
    return this.requireMeta(sessionId);
  }

  /**
   * 加载一份会话的全部事件。尾部损坏时恢复到最后一个完整记录、
   * 就地截断修复文件，并通过 recovery 字段显形告知（不静默）。
   */
  loadSession(sessionId: string): LoadSessionResult {
    const meta = this.requireMeta(sessionId);
    const path = this.eventsPath(sessionId);
    const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
    const lines = raw.length === 0 ? [] : raw.split("\n");
    // 文件以 \n 结尾时 split 会多出一个空尾元素，去掉。
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const events: StoredEvent[] = [];
    let corruptedAt = -1;
    let reason = "";
    for (let i = 0; i < lines.length; i++) {
      let parsed: StoredEvent;
      try {
        parsed = JSON.parse(lines[i]) as StoredEvent;
      } catch {
        corruptedAt = i;
        reason = `第 ${i + 1} 行不是合法 JSON（疑似写入中断）`;
        break;
      }
      if (parsed.seq !== i + 1) {
        corruptedAt = i;
        reason = `第 ${i + 1} 行 seq=${String(parsed.seq)}，期望 ${i + 1}（日志不连续）`;
        break;
      }
      events.push(parsed);
    }

    let recovery: RecoveryInfo | null = null;
    if (corruptedAt >= 0) {
      recovery = {
        recoveredEvents: events.length,
        droppedLines: lines.length - corruptedAt,
        reason,
      };
      // 就地修复：截断到最后一个完整记录，保证后续 append 的 seq 连续。
      const good = lines.slice(0, corruptedAt);
      writeFileSync(path, good.length ? good.join("\n") + "\n" : "", "utf8");
      if (meta.eventCount !== events.length) {
        meta.eventCount = events.length;
        this.persistMeta(meta);
        this.writeIndex();
      }
    }
    return { meta, events, recovery };
  }

  private sessionDir(id: string): string {
    return join(this.sessionsDir, id);
  }

  private eventsPath(id: string): string {
    return join(this.sessionDir(id), "events.jsonl");
  }

  private readMeta(id: string, metaPath: string): SessionMeta {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch (err) {
      throw new SessionStoreError(`会话元数据损坏，无法解析: ${metaPath}`, { sessionId: id }, err);
    }
    const meta = parsed as SessionMeta;
    if (!meta || typeof meta.id !== "string" || typeof meta.eventCount !== "number") {
      throw new SessionStoreError(`会话元数据结构非法: ${metaPath}`, { sessionId: id });
    }
    // 旧版元数据没有 piSessionFile 字段：补 null（表示该会话不可续接），不报错。
    if (typeof meta.piSessionFile !== "string") meta.piSessionFile = null;
    return meta;
  }

  private requireMeta(sessionId: string): SessionMeta {
    const meta = this.metas.get(sessionId);
    if (!meta) {
      throw new SessionStoreError(`未知会话: ${sessionId}`, { sessionId });
    }
    return meta;
  }

  private persistMeta(meta: SessionMeta): void {
    writeFileSync(
      join(this.sessionDir(meta.id), "session.json"),
      JSON.stringify(meta, null, 2) + "\n",
      "utf8",
    );
  }

  private writeIndex(): void {
    const index = {
      version: INDEX_VERSION,
      sessions: this.listSessions().map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        eventCount: m.eventCount,
      })),
    };
    writeFileSync(
      join(this.sessionsDir, "index.json"),
      JSON.stringify(index, null, 2) + "\n",
      "utf8",
    );
  }
}
