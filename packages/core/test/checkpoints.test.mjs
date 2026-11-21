/*** packages/core 检查点存储单测（M-06） *****
 * 覆盖：快照落盘在数据目录（不污染工作区）、无变化去重、回滚精确恢复
 * （改回/重建/删除新建 + 校验通过）、单文件回滚语义、跳过类文件回滚不碰。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, MAX_FILE_BYTES } from "../dist/index.js";

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setup() {
  const root = makeTmp("baimo-ckpt-store-");
  const ws = makeTmp("baimo-ckpt-ws-");
  const store = new CheckpointStore(root);
  return { root, ws, store };
}

test("快照：内容落数据目录，工作区零新增；无变化时去重不重复落盘", () => {
  const { root, ws, store } = setup();
  try {
    writeFileSync(join(ws, "a.txt"), "v1");
    mkdirSync(join(ws, "sub"));
    writeFileSync(join(ws, "sub", "b.txt"), "hello");
    const before = readdirSync(ws).sort();

    const r1 = store.createSnapshot("s1", ws, { label: "运行开始", trigger: "run_start" });
    assert.equal(r1.created, true);
    assert.equal(r1.checkpoint.files.length, 2);
    assert.deepEqual(readdirSync(ws).sort(), before, "快照不得往工作区写任何东西");
    assert.ok(existsSync(join(root, "s1", r1.checkpoint.id, "manifest.json")));
    assert.ok(existsSync(join(root, "s1", r1.checkpoint.id, "files", "sub", "b.txt")));

    const r2 = store.createSnapshot("s1", ws, { label: "运行完成", trigger: "run_settled" });
    assert.equal(r2.created, false, "内容无变化应去重");
    assert.equal(r2.checkpoint.id, r1.checkpoint.id);
    assert.equal(store.listCheckpoints("s1").length, 1);

    writeFileSync(join(ws, "a.txt"), "v2");
    const r3 = store.createSnapshot("s1", ws, { label: "运行完成", trigger: "run_settled" });
    assert.equal(r3.created, true);
    assert.equal(store.listCheckpoints("s1").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("回滚：改过的文件改回、删掉的重建、新建的删除，校验通过", () => {
  const { root, ws, store } = setup();
  try {
    writeFileSync(join(ws, "keep.txt"), "keep-v1");
    writeFileSync(join(ws, "gone.txt"), "to-be-deleted");
    const snap = store.createSnapshot("s1", ws, { label: "基线", trigger: "manual" }).checkpoint;

    writeFileSync(join(ws, "keep.txt"), "keep-v2");
    rmSync(join(ws, "gone.txt"));
    writeFileSync(join(ws, "new.txt"), "created later");

    const report = store.rollback("s1", ws, snap.id);
    assert.equal(report.verified, true, JSON.stringify(report.mismatches));
    assert.deepEqual(report.restored.sort(), ["gone.txt", "keep.txt"]);
    assert.deepEqual(report.deleted, ["new.txt"]);
    assert.equal(readFileSync(join(ws, "keep.txt"), "utf8"), "keep-v1");
    assert.equal(readFileSync(join(ws, "gone.txt"), "utf8"), "to-be-deleted");
    assert.ok(!existsSync(join(ws, "new.txt")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("单文件回滚：恢复内容 / 快照中不存在则删除 / 已一致不动", () => {
  const { root, ws, store } = setup();
  try {
    writeFileSync(join(ws, "a.txt"), "a-v1");
    const snap = store.createSnapshot("s1", ws, { label: "基线", trigger: "manual" }).checkpoint;
    writeFileSync(join(ws, "a.txt"), "a-v2");
    writeFileSync(join(ws, "b.txt"), "b-new");

    assert.equal(store.rollbackFile("s1", ws, snap.id, "a.txt").action, "restored");
    assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "a-v1");
    assert.equal(store.rollbackFile("s1", ws, snap.id, "a.txt").action, "unchanged");
    assert.equal(store.rollbackFile("s1", ws, snap.id, "b.txt").action, "deleted");
    assert.ok(!existsSync(join(ws, "b.txt")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("跳过类：超大文件不进快照、回滚不碰；.git 与 node_modules 不进快照", () => {
  const { root, ws, store } = setup();
  try {
    writeFileSync(join(ws, "small.txt"), "s");
    writeFileSync(join(ws, "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1, 7));
    mkdirSync(join(ws, ".git"));
    writeFileSync(join(ws, ".git", "HEAD"), "ref");
    mkdirSync(join(ws, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(ws, "node_modules", "pkg", "index.js"), "x");

    const snap = store.createSnapshot("s1", ws, { label: "基线", trigger: "manual" }).checkpoint;
    assert.deepEqual(snap.files.map((f) => f.path), ["small.txt"]);
    assert.ok(snap.skipped.some((s) => s.path === "big.bin"));

    writeFileSync(join(ws, "small.txt"), "s2");
    writeFileSync(join(ws, "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1, 9));
    const report = store.rollback("s1", ws, snap.id);
    assert.equal(report.verified, true);
    assert.ok(report.skippedUntouched.includes("big.bin"));
    // 大文件内容保持回滚前状态（没被快照覆盖、没被删除）
    assert.equal(readFileSync(join(ws, "big.bin"))[0], 9);
    assert.equal(readFileSync(join(ws, "small.txt"), "utf8"), "s");

    // 不存在的检查点大声报错
    assert.throws(
      () => store.rollback("s1", ws, "nope"),
      (err) => err.code === "CHECKPOINT_NOT_FOUND",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
