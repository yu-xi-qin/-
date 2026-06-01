# 长江雨课堂自动刷课助手 v2.10.0

自动刷视频、AI 智能答题的浏览器脚本工具，适用于 [长江雨课堂](https://changjiang.yuketang.cn/) 平台。

## 核心原则

- **AI 理解题目**：将题目文本和选项发送给 AI（DeepSeek/OpenAI 等），由 AI 推理正确答案
- **正确率优先**：只用高置信度来源作答，不盲目猜测
- **安全提交**：全部答完才提交一次，不反复提交
- **答案缓存**：AI 答过的题自动缓存，无需重复调用

## 功能

- **视频自动播放**：静音播放，支持 1x~3x 倍速
- **AI 智能答题**：调用 DeepSeek/OpenAI/Anthropic 等 API，AI 阅读题目并推理答案
- **8策略选项提取**：多层级 DOM 解析，支持 判断题对/错、全文回退等非标准渲染
- **多层答题策略**：缓存 → 全局状态 → DOM数据 → **AI 推理** → 手动兜底
- **手动答题辅助**：AI 也无法确定的题目高亮标记，暂停等待手动选择
- **答案缓存**：所有正确答案自动缓存
- **自动导航**：完成任务后自动跳转下一章节

## 安装

1. 安装浏览器扩展 **Tampermonkey**
2. 打开管理面板 → **"添加新脚本"**
3. 粘贴 `yuketang-automator.js` 完整内容，保存
4. 访问 https://changjiang.yuketang.cn/

## AI 答题配置

AI 答题是可选功能，需要配置 API 才能使用。推荐使用 **DeepSeek**（国内可直接访问，便宜快速）。

### 快速配置

1. 打开 [DeepSeek 开放平台](https://platform.deepseek.com/)，注册并获取 API Key
2. 在脚本面板中找到 **"🤖 AI 答题设置"**，展开
3. 勾选 **"启用AI"**
4. 填入 API Key（格式：`sk-xxxxxxxx`）
5. API 地址默认：`https://api.deepseek.com/v1/chat/completions`
6. 模型默认：`deepseek-chat`（推荐，10元/百万token）

### 支持的 API

| 服务商 | API 地址 | 模型 |
|--------|---------|------|
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-4o` / `gpt-4o-mini` |
| Anthropic | `https://api.anthropic.com/v1/messages` | 需要适配器 |
| 其他兼容 | 任意 OpenAI 兼容地址 | 任意模型 |


## 使用

### 基本流程

1. 手动登录平台
2. 选择课程进入
3. **配置 AI API Key**（重要！否则 AI 答题不生效）
4. 调整播放倍速
5. 点击 **"开始运行"**
6. 视频自动播放，遇到试题自动处理
7. 能自动确定的直接作答，不能的由 **AI 推理**
8. AI 也无法确定的 → 橙色高亮，手动选择后点 **"✅ 继续运行"**

### 答题策略

| 轮次 | 策略 | 说明 |
|------|------|------|
| 第一轮 | 缓存 → 全局状态 → DOM数据 | 毫秒级，本地完成 |
| 第二轮 | **AI 推理** | 逐题调用 AI API，每道约 1~3 秒 |
| 第三轮 | 手动兜底 | 高亮提示，用户手动选择后缓存 |

## 导出/导入答案缓存

在浏览器控制台（F12）中执行：

```javascript
// 导出
console.log(JSON.stringify(await GM_getValue('answerCache', {})));

// 导入
GM_setValue('answerCache', { /* 粘贴JSON */ });
```

## 注意事项

- **必须配置 AI API Key 才能启用 AI 答题**，否则只能依赖缓存和 DOM 数据
- AI 答题需要网络请求，每题耗时 1~3 秒，10道题大约半分钟
- 首次使用某课程时 AI 答题比例高，用多了缓存命中率越来越高
- 跨域 iframe 中的视频可能无法控制
- 请合理使用

## 故障排查

| 问题 | 解决方案 |
|------|---------|
| AI 不工作 | 检查 API Key 是否正确、API 地址是否可访问 |
| AI 答案错误 | 尝试换模型（如 deepseek-chat → gpt-4o-mini） |
| API 超时 | 检查网络，尝试增加超时时间 |
| 多数题需手动 | 确认 AI 已配置并启用 |
