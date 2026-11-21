/**
 * 会话回放游标（阶段 3 · 会话回放）。
 *
 * 回放的数据源是落盘 events.jsonl 经主进程归一化后的事件序列
 * （与实时流同一形态）；呈现口径与实时完全一致——每一步的画面
 * 都由同一个归约器 applyHostEvent 折叠前缀得到，不存在第二套渲染。
 *
 * 只读保证：游标只读事件数组、只产出 StreamState，不调用任何
 * 桥接/落盘/运行接口；回放不会产生新运行、不改落盘（桌面 E2E
 * 以落盘 eventCount 与桩请求数不变断言这一点）。
 *
 * 性能口径：前进增量折叠（缓存当前状态，只应用新事件）；后退与
 * 跳转到更小下标时从头重折前缀——会话事件量级（千级以内）下足够快，
 * 且保证任意下标的状态与「从头折叠该前缀」严格一致（单测逐点断言）。
 */
import {
  applyHostEvent,
  applyHostEvents,
  initialStreamState,
  type StreamState,
} from "./stream.js";

export class ReplayCursor {
  private currentIndex = 0;
  private currentState: StreamState = initialStreamState;

  constructor(private readonly events: readonly unknown[]) {}

  /** 事件总数。 */
  get total(): number {
    return this.events.length;
  }

  /** 已呈现的事件数（0..total）：画面 = 前 index 个事件的折叠。 */
  get index(): number {
    return this.currentIndex;
  }

  get atStart(): boolean {
    return this.currentIndex === 0;
  }

  get atEnd(): boolean {
    return this.currentIndex === this.events.length;
  }

  /** 当前画面状态（前 index 个事件经归约器折叠的结果）。 */
  state(): StreamState {
    return this.currentState;
  }

  /** 前进一步；已在结尾返回 false。 */
  stepForward(): boolean {
    if (this.atEnd) return false;
    this.currentState = applyHostEvent(
      this.currentState,
      this.events[this.currentIndex],
    );
    this.currentIndex += 1;
    return true;
  }

  /** 后退一步；已在开头返回 false。 */
  stepBack(): boolean {
    if (this.atStart) return false;
    this.seek(this.currentIndex - 1);
    return true;
  }

  /** 跳到任意下标（钳制到 [0, total]）：画面与从头折叠该前缀严格一致。 */
  seek(index: number): void {
    const target = Math.max(0, Math.min(this.events.length, Math.floor(index)));
    if (target === this.currentIndex) return;
    if (target > this.currentIndex) {
      let s = this.currentState;
      for (let i = this.currentIndex; i < target; i++) {
        s = applyHostEvent(s, this.events[i]);
      }
      this.currentState = s;
    } else {
      this.currentState = applyHostEvents(
        initialStreamState,
        this.events.slice(0, target),
      );
    }
    this.currentIndex = target;
  }

  /** 回到开头（空白画面）。 */
  reset(): void {
    this.seek(0);
  }
}
