# Comma Review Studio 外部测试指南

## 环境要求

- macOS 优先。DOCX 中的 TIFF 图片会优先用 macOS 自带 `sips` 转成 PNG；其它平台或单图转换失败时会自动降级为图注占位，导入不会因此中断。
- Python 3.10+。
- Node.js 和 npm。
- 在仓库根目录运行一次 `npm install`。
- Codex CLI 或 Claude CLI 已安装并登录。两者都没有时，AI 功能不可用，编辑、导入、批注仍可用。

## 三步启动

1. 进入仓库根目录：
   ```bash
   cd comma-editor-kit
   ```
2. 安装依赖：
   ```bash
   npm install
   ```
3. 启动 Review Studio：
   ```bash
   ./start-review-studio.sh
   ```

启动脚本会先运行 doctor，检查 Python、Node、npm 依赖和 Codex/Claude CLI 状态；通过后会启动本机服务并打开浏览器。

## 5 分钟上手路径

1. 从页头文件名菜单切到 Attention 示例：`arxiv-1706.03762v7/converted/attention-is-all-you-need-source.md`。
2. 在正文里选一段文字，点选区工具条里的快速解释。
3. 点页头的 `AI Review`，跑一次评审。
4. 查看右侧批注和待处理流，尝试接受或保留建议。
5. 点 `导入`，导入自己的 Word 或 Markdown 主稿；导入成功后可以从文件名菜单切回原文稿。

## 已知限制

- PDF 参考资料不做 OCR；扫描件或图片型 PDF 只会显示文本不可用。
- Web 检索关闭；AI 只基于本机文稿、批注、参考资料和当前提示工作。
- 当前版本是单机单用户工作台，不处理多人实时协作。
- 数据全部保存在本机 `apps/review-studio/data/` 目录。

## 数据承诺

所有文稿与 AI 痕迹只在本机 `apps/review-studio/data/` 目录，不上传任何服务器。

## 反馈渠道

- GitHub Issues: https://github.com/mengsj08/comma-editor-kit/issues
- 或直接微信/飞书告诉 June。
