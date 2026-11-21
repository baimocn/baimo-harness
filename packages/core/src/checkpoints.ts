/**
 * 工作区检查点（M-06）：关键步骤给工作区留可回滚的快照点。
 *
 * 存放方式（不污染用户仓库）：快照全部落在宿主数据目录
 *   <rootDir>/<sessionId>/<checkpointId>/manifest.json + files/<相对路径>
 * 与用户工作区、是否为 git 仓库完全无关，用户仓库里不新增任何文件/引用。
 *
 * 扫描规则（快照与回滚共用，保证口径一致）：
 * - 递归收集普通文件，记录相对路径 + sha256 + size；跳过 .git、node_modules 目录；
 * - 符号链接、超大文件（> MAX_FILE_BYTES）不进快照，记入 skipped 并显形——
 *   回滚时这类文件一律不碰（不删除、不覆盖），避免「回滚顺手删掉大文件」。
 *
 * 回滚语义：把工作区文件集精确恢复到快照时刻——内容不同的恢复、被删的
 * 重建、快照后新建的删除；完成后重新扫描逐文件比对哈希做校验，报告显形。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export type CheckpointTrigger =
  | "run_start"
  | "run_settled"
  | "manual"
  | "pre_rollback"
  | "yolo_start";

export interface CheckpointFileEntry {
  /** 相对工作区的路径（POSIX 分隔符）。 */
  path: string;
  sha256: string;
  size: number;
}

export interface CheckpointSkipped {
  path: string;
  reason: string;
}

export interface CheckpointManifest {
  id: string;
  sessionId: string;
  createdAt: string;
  label: string;
  trigger: CheckpointTrigger;
  files: CheckpointFileEntry[];
  /** 快照时刻存在的目录（含空目录），回滚时据此恢复目录结构。 */
  dirs: string[];
  skipped: CheckpointSkipped[];
}

export interface CreateSnapshotResult {
  checkpoint: CheckpointManifest;
  /** false = 与最近一个检查点内容完全一致，未重复落盘（返回的仍是最近检查点）。 */
  created: boolean;
}

export interface RollbackReport {
  checkpointId: string;
  /** 内容被恢复（含重建）的文件相对路径。 */
  restored: string[];
  /** 快照后新建、回滚时删除的文件相对路径。 */
  deleted: string[];
  /** 与快照一致、未动的文件数。 */
  unchanged: number;
  /** 回滚后跳过类文件（未触碰）相对路径。 */
  skippedUntouched: string[];
  /** 校验结果：回滚后逐文件哈希与清单一致为 true；不一致项列入 mismatches。 */
  verified: boolean;
  mismatches: string[];
}

export class CheckpointError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}

/** 单文件进快照的体积上限：超限记 skipped，回滚不碰。 */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const SKIP_DIRS = new Set([".git", "node_modules"]);

interface ScanResult {
  files: CheckpointFileEntry[];
  dirs: string[];
  skipped: CheckpointSkipped[];
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export class CheckpointStore {
  constructor(private readonly rootDir: string) {}

  private sessionDir(sessionId: string): string {
    return join(this.rootDir, sessionId);
  }

  private checkpointDir(sessionId: string, checkpointId: string): string {
    return join(this.sessionDir(sessionId), checkpointId);
  }

  /** 扫描工作区（快照/回滚共用口径）。workspaceDir 必须存在。 */
  private scan(workspaceDir: string): ScanResult {
    const files: CheckpointFileEntry[] = [];
    const dirs: string[] = [];
    const skipped: CheckpointSkipped[] = [];
    const walk = (absDir: string) => {
      for (const entry of readdirSync(absDir, { withFileTypes: true })) {
        const abs = join(absDir, entry.name);
        const rel = toPosix(relative(workspaceDir, abs));
        if (entry.isSymbolicLink()) {
          skipped.push({ path: rel, reason: "符号链接不进快照" });
          continue;
        }
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) {
            skipped.push({ path: rel, reason: `跳过 ${entry.name} 目录` });
            continue;
          }
          dirs.push(rel);
          walk(abs);
          continue;
        }
        if (!entry.isFile()) {
          skipped.push({ path: rel, reason: "非普通文件" });
          continue;
        }
        const st = lstatSync(abs);
        if (st.size > MAX_FILE_BYTES) {
          skipped.push({
            path: rel,
            reason: `文件超过 ${MAX_FILE_BYTES} 字节上限（${st.size}）`,
          });
          continue;
        }
        const content = readFileSync(abs);
        files.push({
          path: rel,
          sha256: createHash("sha256").update(content).digest("hex"),
          size: st.size,
        });
      }
    };
    walk(workspaceDir);
    files.sort((a, b) => a.path.localeCompare(b.path));
    dirs.sort();
    return { files, dirs, skipped };
  }

  private static sameFileSet(
    a: CheckpointFileEntry[],
    b: CheckpointFileEntry[],
  ): boolean {
    if (a.length !== b.length) return false;
    const map = new Map(b.map((f) => [f.path, f.sha256]));
    return a.every((f) => map.get(f.path) === f.sha256);
  }

  /** 列出某会话的全部检查点（按创建时间升序）。 */
  listCheckpoints(sessionId: string): CheckpointManifest[] {
    const dir = this.sessionDir(sessionId);
    if (!existsSync(dir)) return [];
    const out: CheckpointManifest[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(dir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      out.push(JSON.parse(readFileSync(manifestPath, "utf8")) as CheckpointManifest);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  latestCheckpoint(sessionId: string): CheckpointManifest | null {
    const list = this.listCheckpoints(sessionId);
    return list.length ? list[list.length - 1] : null;
  }

  getCheckpoint(sessionId: string, checkpointId: string): CheckpointManifest {
    const found = this.listCheckpoints(sessionId).find((c) => c.id === checkpointId);
    if (!found) {
      throw new CheckpointError(
        "CHECKPOINT_NOT_FOUND",
        `检查点不存在: ${checkpointId}（会话 ${sessionId}）`,
      );
    }
    return found;
  }

  /**
   * 给当前工作区状态打一个检查点。与最近检查点内容完全一致时不重复落盘，
   * 返回 created:false 与最近检查点（避免无改动的运行堆积空检查点）。
   */
  createSnapshot(
    sessionId: string,
    workspaceDir: string,
    opts: { label: string; trigger: CheckpointTrigger },
  ): CreateSnapshotResult {
    if (!existsSync(workspaceDir)) {
      throw new CheckpointError(
        "WORKSPACE_MISSING",
        `工作区目录不存在: ${workspaceDir}`,
      );
    }
    const scan = this.scan(workspaceDir);
    const latest = this.latestCheckpoint(sessionId);
    if (latest && CheckpointStore.sameFileSet(latest.files, scan.files)) {
      return { checkpoint: latest, created: false };
    }
    const manifest: CheckpointManifest = {
      id: randomUUID(),
      sessionId,
      createdAt: new Date().toISOString(),
      label: opts.label,
      trigger: opts.trigger,
      files: scan.files,
      dirs: scan.dirs,
      skipped: scan.skipped,
    };
    const dir = this.checkpointDir(sessionId, manifest.id);
    mkdirSync(dir, { recursive: true });
    for (const f of scan.files) {
      const blobPath = join(dir, "files", f.path);
      mkdirSync(dirname(blobPath), { recursive: true });
      copyFileSync(join(workspaceDir, f.path), blobPath);
    }
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );
    return { checkpoint: manifest, created: true };
  }

  /** 把工作区整体恢复到指定检查点，并逐文件校验。 */
  rollback(
    sessionId: string,
    workspaceDir: string,
    checkpointId: string,
  ): RollbackReport {
    const manifest = this.getCheckpoint(sessionId, checkpointId);
    const before = this.scan(workspaceDir);
    const wanted = new Map(manifest.files.map((f) => [f.path, f]));
    const current = new Map(before.files.map((f) => [f.path, f]));
    const skippedNow = new Set(before.skipped.map((s) => s.path));

    const restored: string[] = [];
    const deleted: string[] = [];
    let unchanged = 0;

    // 恢复/重建清单内文件
    for (const f of manifest.files) {
      const cur = current.get(f.path);
      if (cur && cur.sha256 === f.sha256) {
        unchanged += 1;
        continue;
      }
      const target = join(workspaceDir, f.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(this.checkpointDir(sessionId, checkpointId), "files", f.path), target);
      restored.push(f.path);
    }
    // 删除快照后新建的文件（跳过类文件不碰）
    for (const f of before.files) {
      if (!wanted.has(f.path)) {
        rmSync(join(workspaceDir, f.path), { force: true });
        deleted.push(f.path);
      }
    }
    // 目录结构对齐：补回清单内目录，删掉快照后新建的空目录（深到浅）
    for (const d of manifest.dirs) {
      mkdirSync(join(workspaceDir, d), { recursive: true });
    }
    const extraDirs = before.dirs
      .filter((d) => !manifest.dirs.includes(d))
      .sort((a, b) => b.length - a.length);
    for (const d of extraDirs) {
      const abs = join(workspaceDir, d);
      if (existsSync(abs) && readdirSync(abs).length === 0) {
        rmSync(abs, { recursive: true, force: true });
      }
    }

    // 校验：回滚后扫描与清单逐项比对
    const after = this.scan(workspaceDir);
    const afterMap = new Map(after.files.map((f) => [f.path, f.sha256]));
    const mismatches: string[] = [];
    for (const f of manifest.files) {
      if (afterMap.get(f.path) !== f.sha256) mismatches.push(f.path);
    }
    for (const f of after.files) {
      if (!wanted.has(f.path)) mismatches.push(f.path);
    }
    return {
      checkpointId,
      restored: restored.sort(),
      deleted: deleted.sort(),
      unchanged,
      skippedUntouched: [...skippedNow].sort(),
      verified: mismatches.length === 0,
      mismatches: mismatches.sort(),
    };
  }

  /**
   * 单文件回滚到指定检查点（diff 卡「回滚」用）：清单里有该文件则恢复其内容，
   * 没有则说明快照时刻该文件不存在 → 删除它。跳过类文件拒绝操作（不假装）。
   */
  rollbackFile(
    sessionId: string,
    workspaceDir: string,
    checkpointId: string,
    relPath: string,
  ): { action: "restored" | "deleted" | "unchanged"; path: string } {
    const manifest = this.getCheckpoint(sessionId, checkpointId);
    const posixPath = toPosix(relPath);
    const scan = this.scan(workspaceDir);
    if (scan.skipped.some((s) => s.path === posixPath)) {
      throw new CheckpointError(
        "FILE_NOT_IN_SNAPSHOT_SCOPE",
        `文件 ${posixPath} 不在快照范围内（跳过类），拒绝回滚`,
      );
    }
    const entry = manifest.files.find((f) => f.path === posixPath);
    const target = join(workspaceDir, posixPath);
    if (!entry) {
      if (existsSync(target)) {
        rmSync(target, { force: true });
        return { action: "deleted", path: posixPath };
      }
      return { action: "unchanged", path: posixPath };
    }
    const cur = scan.files.find((f) => f.path === posixPath);
    if (cur && cur.sha256 === entry.sha256) {
      return { action: "unchanged", path: posixPath };
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(
      join(this.checkpointDir(sessionId, checkpointId), "files", entry.path),
      target,
    );
    return { action: "restored", path: posixPath };
  }
}
