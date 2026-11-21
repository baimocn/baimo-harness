/**
 * 白墨 Harness 示例插件（M-15 插件目录）：plugin_echo 回声工具。
 *
 * 形态即 Pi 扩展：默认导出工厂函数，加载时由 Pi 调用并注入扩展 API。
 * 本文件零外部 import（参数用手写 JSON Schema，与 TypeBox 产物同形），
 * 放在任何目录都能被 Pi 直接加载，不依赖本仓库的模块解析。
 *
 * 效果：给模型注册一个 Pi 本体没有的工具 plugin_echo —— 把输入文本
 * 转大写并加 PLUGIN-ECHO 前缀返回。E2E 据此断言「插件效果真实发生」：
 * 装了它，工具调用成功且结果带标记；没装，同一调用是未知工具错误。
 */
export default function (pi) {
  pi.registerTool({
    name: "plugin_echo",
    label: "插件回声",
    description:
      "示例插件工具：把给定文本转成大写并加 PLUGIN-ECHO 前缀返回（证明插件已加载生效）。",
    promptSnippet: "plugin_echo: 示例插件的回声工具（大写 + PLUGIN-ECHO 前缀）",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要回声的文本" },
      },
      required: ["text"],
    },
    async execute(_toolCallId, params) {
      const text = typeof params?.text === "string" ? params.text : "";
      return {
        content: [{ type: "text", text: `PLUGIN-ECHO: ${text.toUpperCase()}` }],
        details: { plugin: "echo-plugin" },
      };
    },
  });
}
