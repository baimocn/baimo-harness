/**
 * Steering 队列镜像落盘（M-04，K-05 共用底座）。
 *
 * Pi 进程内的队列（steer / follow_up）随进程消亡而丢失；宿主按会话
 * 维护一份镜像：<dataDir>/steering/<sessionId>.json。入队即落盘，
 * 投递/撤回状态变更即落盘；宿主重启后据此在 resume 时把未投递条目
 * 原样重新入队（Pi 对空闲会话的 steer/follow_up 同样接受排队）。
 *
 * 投递状态的权威依据是 Pi 投递时必发的 message_start（role=user）
 * 事件，SessionHandle 据此对账（不用 queue_update 的队列收缩推断，
 * clear_queue 同样引起收缩、会误判）。文件损坏时抛
 * SessionStoreError 大声报错，不静默丢队列。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStoreError } from "./errors.js";

export type SteeringKind = "steer" | "follow_up";
export type SteeringStatus = "queued" | "delivered" | "withdrawn";

export interface SteeringEntry {
  id: string;
  kind: SteeringKind;
  text: string;
  status: SteeringStatus;
  createdAt: string;
  deliveredAt?: string;
}

export class SteeringStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "steering");
  }

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  /** 读一份会话的队列镜像；无文件返回空数组；损坏抛错显形。 */
  load(sessionId: string): SteeringEntry[] {
    const file = this.file(sessionId);
    if (!existsSync(file)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new SessionStoreError(
        `steering 队列镜像损坏，无法解析: ${file}`,
        { sessionId },
        err,
      );
    }
    const entries = (parsed as { entries?: unknown })?.entries;
    if (!Array.isArray(entries)) {
      throw new SessionStoreError(`steering 队列镜像结构非法: ${file}`, {
        sessionId,
      });
    }
    return entries as SteeringEntry[];
  }

  /** 整表落盘（条目量小，整写简单且不易写坏）。 */
  save(sessionId: string, entries: SteeringEntry[]): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      this.file(sessionId),
      JSON.stringify({ version: 1, entries }, null, 2) + "\n",
      "utf8",
    );
  }
}
