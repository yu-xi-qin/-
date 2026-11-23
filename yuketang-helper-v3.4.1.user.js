// ==UserScript==
// @name         长江雨课堂自动刷课助手
// @namespace    https://changjiang.yuketang.cn/
// @version      3.4.1
// @description  自动刷视频、做试题，支持倍速播放与AI智能答题（手动提交，未完成题目列表）
// @author       yuketang-helper
// @match        https://changjiang.yuketang.cn/*
// @match        https://*.yuketang.cn/*
// @match        https://changjiang.yuketang.cn/**
// @run-at       document-end
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      api.openai.com
// @connect      api.anthropic.com
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  //  CONFIGURATION
  // ============================================================
  const CONFIG = {
    defaultSpeed: 2.0,
    defaultMuted: true,
    autoNextChapter: true,
    autoCrossCourse: true,     // 完成一门课后自动进入下一门
    answerRetryLimit: 3,
    checkInterval: 1000,       // 主循环间隔 ms
    videoCheckInterval: 500,   // 视频检测间隔 ms
    quizCheckInterval: 800,    // 试题检测间隔 ms
    maxWaitForElement: 30000,  // 等待元素超时 ms
    notifyOnComplete: true,
    logLevel: 'info',          // debug | info | warn | error
    speeds: [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0],
    // AI 答题配置
    ai: {
      enabled: true,
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: '',
      model: 'deepseek-chat',
      timeout: 120000,        // API 超时 ms（思考型模型需要更久，且推理token也占输出额度）
      concurrency: 6,         // 逐题请求的并发数：一题一请求，完成一题应用一题
    },
    // 选择器配置（可根据实际页面结构调整）
    selectors: {
      // 视频相关
      video: 'video',
      videoWrapper: '[class*="video"], [class*="player"], [id*="video"], [id*="player"]',
      videoIframe: 'iframe[src*="video"], iframe[src*="player"], iframe[src*="vod"]',
      // 试题相关
      quizContainer: '[class*="exam"], [class*="quiz"], [class*="question"], [class*="problem"], [class*="test-paper"], [class*="exercise"]',
      questionItem: '[class*="question-item"], [class*="questionItem"], [class*="topic"], [class*="subject"], .que_row, [class*="problem-item"], [class*="question-wrapper"], [class*="question_block"]',
      questionStem: '[class*="question-stem"], [class*="stem"], [class*="title"], [class*="content"], .que_tit, [class*="question-text"]',
      optionItem: 'input[type="radio"], input[type="checkbox"], [class*="option"], [class*="choice"], label[class*="option"]',
      optionGroup: '[class*="options"], [class*="choices"], [class*="option-list"], .que_con, [class*="answer-area"]',
      optionLabel: 'label, [class*="option"], [class*="choice"], li',
      textInput: 'input[type="text"]:not([class*="search"]):not([placeholder*="搜索"])',
      textarea: 'textarea',
      richEditor: '[contenteditable="true"], [class*="editor"], [class*="rich-text"], [class*="richtext"]',
      questionTypeTag: '[class*="type"], [class*="qtype"], [class*="label"], [class*="tag"], [class*="badge"]',
      correctFeedback: '[class*="correct"], [class*="right"], [class*="success"], [class*="pass"], [style*="color:green"]',
      errorFeedback: '[class*="error"], [class*="wrong"], [class*="fail"], [class*="incorrect"], [style*="color:red"]',
      submitBtn: '[class*="submit"], [class*="confirm"], [class*="commit"], button, [role="button"]',
      // 导航相关
      nextBtn: '[class*="next"], [class*="continue"], button, a, [class*="forward"]',
      prevBtn: '[class*="prev"], [class*="back"], button, a',
      chapterList: '[class*="chapter"], [class*="catalog"], [class*="menu"], [class*="sidebar"], [class*="lesson-list"], [class*="courseware"]',
      chapterItem: '[class*="chapter-item"], [class*="lesson-item"], [class*="section-item"], [class*="menu-item"], li[class*="unit"]',
      // 课程列表
      courseList: '[class*="course-list"], [class*="courseList"], [class*="class-list"]',
      courseItem: '[class*="course-item"], [class*="courseItem"], [class*="class-item"]',
      // 弹窗
      modal: '[class*="modal"], [class*="dialog"], [class*="popup"], [class*="overlay"], [class*="mask"]',
      modalClose: '[class*="close"], [class*="modal"] [class*="close"], .modal .close, [class*="cancel"]',
    }
  };

  // ============================================================
  //  LOGGER
  // ============================================================
  const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  const LOG_BUFFER = []; // 最近日志，供 __ytDiagnose() 导出
  class Logger {
    constructor(level) {
      this.level = LOG_LEVELS[level] ?? 1;
    }
    _log(level, tag, ...args) {
      if (LOG_LEVELS[level] >= this.level) {
        const prefix = `[雨课堂助手][${tag}]`;
        switch (level) {
          case 'debug': console.debug(prefix, ...args); break;
          case 'info':  console.log(prefix, ...args);   break;
          case 'warn':  console.warn(prefix, ...args);  break;
          case 'error': console.error(prefix, ...args); break;
        }
        try {
          LOG_BUFFER.push({
            t: Date.now(), level, tag,
            msg: args.map(a => {
              if (typeof a === 'string') return a;
              try { return JSON.stringify(a); } catch (_) { return String(a); }
            }).join(' ').substring(0, 2000),
          });
          if (LOG_BUFFER.length > 500) LOG_BUFFER.shift();
        } catch (_) { /* ignore */ }
      }
    }
    debug(tag, ...args) { this._log('debug', tag, ...args); }
    info(tag, ...args)  { this._log('info', tag, ...args); }
    warn(tag, ...args)  { this._log('warn', tag, ...args); }
    error(tag, ...args) { this._log('error', tag, ...args); }
  }
  const logger = new Logger(CONFIG.logLevel);

  // ============================================================
  //  STORAGE (基于 GM_setValue / GM_getValue)
  // ============================================================
  class Storage {
    static get(key, defaultValue = null) {
      try {
        const val = GM_getValue(key);
        return val !== undefined ? val : defaultValue;
      } catch (e) {
        return defaultValue;
      }
    }
    static set(key, value) {
      try { GM_setValue(key, value); } catch (e) { logger.error('Storage', 'set failed', e); }
    }
    static getAnswerCache() {
      return Storage.get('answerCache', {});
    }
    static setAnswerCache(cache) {
      Storage.set('answerCache', cache);
    }
    static addAnswer(questionKey, answer) {
      const cache = Storage.getAnswerCache();
      cache[questionKey] = { answer, time: Date.now() };
      Storage.setAnswerCache(cache);
    }
    static getAnswer(questionKey) {
      const cache = Storage.getAnswerCache();
      return cache[questionKey] ? cache[questionKey].answer : null;
    }
    static getSettings() {
      return Storage.get('settings', {
        speed: CONFIG.defaultSpeed,
        muted: CONFIG.defaultMuted,
        autoNext: CONFIG.autoNextChapter,
        crossCourse: CONFIG.autoCrossCourse || true,
      });
    }
    static setSettings(settings) {
      Storage.set('settings', { ...Storage.getSettings(), ...settings });
    }
    static getAISettings() {
      const merged = { ...CONFIG.ai, ...Storage.get('aiSettings', {}) };
      // 思考型模型经常思考超过30s，强制至少 120s
      merged.timeout = Math.max(merged.timeout || 0, 120000);
      return merged;
    }
    static setAISettings(ai) {
      Storage.set('aiSettings', { ...Storage.getAISettings(), ...ai });
    }
  }

  // ============================================================
  //  AI PROTOCOL — 同时支持 OpenAI chat/completions 与 Anthropic messages
  // ============================================================
  const AI_SYSTEM_PROMPT = '你是一个知识渊博的答题助手。请严格按照要求的JSON格式输出答案，不要输出任何解释文字。';

  function isAnthropicEndpoint(endpoint) {
    return /\/apps\/anthropic(?:\/|$)|\/anthropic(?:\/|$)/i.test(endpoint || '');
  }

  function anthropicMessagesUrl(endpoint) {
    const base = String(endpoint || '').replace(/\/+$/, '');
    if (/\/v1\/messages$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return base + '/messages';
    return base + '/v1/messages';
  }

  function buildAIRequest(cfg, prompt, maxTokens) {
    const isAnthropic = isAnthropicEndpoint(cfg.endpoint);
    if (isAnthropic) {
      return {
        isAnthropic,
        url: anthropicMessagesUrl(cfg.endpoint),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`,
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        data: JSON.stringify({
          model: cfg.model,
          system: AI_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.0,
          stream: false,
        }),
      };
    }
    return {
      isAnthropic,
      url: cfg.endpoint,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      data: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.0,
        stream: false,
      }),
    };
  }

  function parseAIResponse(json, isAnthropic) {
    if (isAnthropic) {
      const blocks = Array.isArray(json.content) ? json.content : [];
      const content = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
      return { content, finishReason: json.stop_reason || 'none' };
    }
    const choice = json.choices?.[0];
    return {
      content: (choice?.message?.content || '').trim(),
      finishReason: choice?.finish_reason || 'none',
    };
  }

  // ============================================================
  //  AI ANSWERER — 调用 AI API 推理答案
  // ============================================================
  class AIAnswerer {
    constructor() {
      this.settings = Storage.getAISettings();
      this._apiLog = []; // 最近API请求/返回，供诊断导出
    }

    get enabled() { return this.settings.enabled && this.settings.apiKey.length > 0; }

    _recordAPI(kind, tag, text) {
      try {
        this._apiLog.push({ t: Date.now(), kind, tag, text: String(text || '').substring(0, 12000) });
        if (this._apiLog.length > 60) this._apiLog.shift();
      } catch (_) { /* ignore */ }
    }

    updateSettings(settings) {
      this.settings = { ...this.settings, ...settings };
      Storage.setAISettings(this.settings);
    }

    /**
     * 单题 AI 回答（fallback）
     */
    async answer(questionText, options, qtype, fullText = null) {
      if (!this.enabled) return null;
      if (options.length < 2 && !fullText) return null;
      let prompt;
      if (fullText) {
        prompt = `请根据你的知识回答以下题目。只输出一个JSON对象，不要任何其他文字。

以下是题目的完整文本（包含题干和选项，请从中提取并作答）：
${fullText}

输出格式（只输出JSON）：
单选/判断：{"index": 正确答案的选项序号(0起)}
多选：{"indices": [正确选项的序号列表]}
填空题：单空 {"text": "答案内容"}；连续多个空 {"texts": ["第一空答案", "第二空答案"]}
主观题（简答/论述/计算/分析/应用等）：{"text": "请根据题目类型组织答案：简答题应简明扼要列出要点；论述题应结合理论展开分析论证；计算题应给出推导步骤和最终结果；分析题应结合材料和相关理论全面阐述。答案应完整、准确、条理清晰。"}
不确定：{"unknown": true}`;
      } else {
        prompt = this._buildSinglePrompt(questionText, options, qtype);
      }
      try {
        this._recordAPI('single-request', qtype, prompt);
        const content = await this._callAPI(prompt, 8192);
        if (!content) return null;
        this._recordAPI('single-response', qtype, content);
        logger.info('AI', '单题返回:', content.substring(0, 120));
        const result = this._parseSingleAnswer(content, options, qtype);
        if (result) {
          logger.info('AI', '单题解析成功:', JSON.stringify(result));
        } else {
          logger.warn('AI', '单题解析失败，原始返回:', content.substring(0, 200));
        }
        return result;
      } catch (e) {
        this._recordAPI('single-error', qtype, e.message);
        logger.warn('AI', '单题API失败:', e.message);
        return null;
      }
    }

    /**
     * 批量 AI 回答：自动拆分为多个小批次并行处理
     * @param {Array} questions [{ index, stem, options, qtype }]
     * @returns {Object|null} { answers: [{ q, index }] }
     */
    async answerBatch(questions) {
      if (!this.enabled || questions.length === 0) return null;

      const BATCH_SIZE = 5; // 思考型模型每题推理开销大，小批量并行避免整批截断

      // 如果题目少，直接一次调用
      if (questions.length <= BATCH_SIZE) {
        return await this._answerBatchChunk(questions);
      }

      // 拆分为多个chunk并行处理
      const chunks = [];
      for (let i = 0; i < questions.length; i += BATCH_SIZE) {
        chunks.push(questions.slice(i, i + BATCH_SIZE));
      }

      logger.info('AI', `批量答题: ${questions.length}道题 拆分为 ${chunks.length} 批并行处理`);

      const results = await Promise.allSettled(
        chunks.map((chunk, idx) => this._answerBatchChunk(chunk, idx))
      );

      // 合并所有chunk的结果
      const allAnswers = [];
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value?.answers) {
          allAnswers.push(...result.value.answers);
        }
      }

      if (allAnswers.length > 0) {
        logger.info('AI', `批量完成: ${allAnswers.length}/${questions.length} 道`);
        return { answers: allAnswers };
      }
      return null;
    }

    /** 单个批次的答题调用 */
    async _answerBatchChunk(questions, chunkIdx = 0) {
      const prompt = this._buildBatchPrompt(questions);
      const tag = chunkIdx !== undefined ? `批次${chunkIdx}` : '单批';
      logger.info('AI', `${tag}: ${questions.length}道题, prompt长度=${prompt.length}`);
      this._recordAPI('batch-request', tag, prompt);

      // max_tokens按题目数量动态调整: 思考型模型的推理过程也计入额度
      const dynamicMaxTokens = Math.max(4096, Math.min(16384, questions.length * 1600));

      try {
        const content = await this._callAPI(prompt, dynamicMaxTokens);
        if (!content) return null;
        this._recordAPI('batch-response', tag, content);
        logger.info('AI', `${tag}返回:`, content.substring(0, 200));
        return this._parseBatchAnswer(content, questions);
      } catch (e) {
        const errMsg = e.message || String(e);
        this._recordAPI('batch-error', tag, errMsg);
        logger.warn('AI', `${tag}失败:`, errMsg);

        // 如果因为输出截断失败，尝试更小的批次
        if (/finish_reason=length|too long|token/i.test(errMsg) && questions.length > 5) {
          logger.info('AI', `${tag}输出超限，拆分为更小批次...`);
          const half = Math.ceil(questions.length / 2);
          const results = await Promise.allSettled([
            this._answerBatchChunk(questions.slice(0, half), chunkIdx + '_a'),
            this._answerBatchChunk(questions.slice(half), chunkIdx + '_b'),
          ]);
          const answers = [];
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value?.answers) answers.push(...r.value.answers);
          }
          if (answers.length > 0) return { answers };
        }
        return null;
      }
    }

    // ===== 单题 Prompt =====
    _buildSinglePrompt(stem, options, qtype) {
      const opts = options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n');
      const isMulti = qtype === 'multi' || qtype === QTYPE.MULTI;
      const isJudge = qtype === 'judge' || qtype === QTYPE.JUDGE;

      let hint = '';
      if (isMulti) hint = '【多选题——必须选出全部正确选项！】';
      else if (isJudge) hint = '【判断题】';

      let formatInst = '';
      if (isMulti) {
        formatInst = `这是一道多选题，必须选出全部正确选项。\n输出格式：{"indices": [0, 1, 2]}  ← 把所有正确选项的序号都列出来！\n注意：indices数组中的每个数字代表一个正确选项(0=第一个选项A, 1=第二个选项B, 以此类推)\n多选至少包含2个选项，最多可包含全部选项。`;
      } else if (isJudge) {
        formatInst = `输出格式：{"index": 0}  ← index 是正确选项在选项列表中的序号（0=第一个选项，1=第二个选项）；若没有给出选项，0=正确/对，1=错误/错`;
      } else if (qtype === 'fill' || qtype === QTYPE.FILL) {
        formatInst = `输出格式：单空 {"text": "答案内容"}；多空 {"texts": ["第一空答案", "第二空答案", ...]}  ← 填空题按空的顺序给出每个空的答案`;
      } else if (qtype === 'essay' || qtype === QTYPE.ESSAY) {
        formatInst = `输出格式：{"text": "答案内容"}  ← 解答题，给出答案要点`;
      } else {
        formatInst = `输出格式：{"index": 0}  ← 正确答案的序号(0=第一个选项A, 1=第二个选项B, ...)`;
      }

      return `你是一个专业的答题助手。请认真阅读题目，选出正确答案。只输出一个JSON对象，不要任何解释文字。

${hint}
题目：${stem}

选项：
${opts}

${formatInst}

请只输出JSON对象，不要有其他内容。`;
    }

    // ===== 批量 Prompt =====
    _buildBatchPrompt(questions) {
      let prompt = `下面有 ${questions.length} 道题目，编号从0到${questions.length - 1}。请逐一给出正确答案。只输出一个JSON数组，不要任何其他文字。q字段必须使用我指定的编号(0,1,2...)，绝不要使用题干文字中可能出现的题号。

`;
      for (const q of questions) {
        let typeTag = '[单选]';
        if (q.qtype === 'multi' || q.qtype === QTYPE.MULTI) typeTag = '[多选]';
        else if (q.qtype === 'judge' || q.qtype === QTYPE.JUDGE) typeTag = '[判断]';
        else if (q.qtype === 'fill' || q.qtype === QTYPE.FILL) typeTag = '[填空]';
        else if (q.qtype === 'essay' || q.qtype === QTYPE.ESSAY) typeTag = '[解答]';
        // 去掉题干开头的题号(如 "33." "第33题"等)，避免AI混淆
        const cleanStem = (q.stem || '').replace(/^\s*(第?\d+[.、．题]\s*)+/, '');
        prompt += `--- 题目${q.index}(q=${q.index}) ${typeTag} ---\n`;

        if (q.options.length >= 2) {
          // 正常：有独立提取的选项
          prompt += `题干：${cleanStem}\n选项：\n`;
          prompt += q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n') + '\n';
        } else if (q.fullText && q.fullText.length > 10) {
          // 回退：使用全文，让 AI 自行解析题干和选项
          prompt += `以下是题目的完整文本（包含题干和选项，请从中提取并作答）：\n${q.fullText}\n`;
        } else {
          // 只有题干没有选项（填空/解答题）
          prompt += `题干：${cleanStem}\n`;
          if (q.qtype === 'fill' || q.qtype === QTYPE.FILL) {
            prompt += `（这是填空题，请直接给出应填入的文本答案）\n`;
          } else if (q.qtype === 'essay' || q.qtype === QTYPE.ESSAY) {
            // 根据题干关键词匹配合适的答题引导
            const stemLower = (q.stem || '').toLowerCase();
            if (/计算|求解|求值|导数|积分|方程/i.test(stemLower)) {
              prompt += `（这是计算题，请给出完整的推导计算过程和最终结果）\n`;
            } else if (/论述|分析|阐述|评价|讨论|理解|认识|看法|意义|影响/i.test(stemLower)) {
              prompt += `（这是论述/分析题，请结合相关理论进行全面分析和论证，答案应条理清晰、论据充分）\n`;
            } else if (/简答|简述|列举|列出|写出|说明|解释|回答/i.test(stemLower)) {
              prompt += `（这是简答题，请简明扼要地列出要点，条理清晰）\n`;
            } else if (/证明|推导|求证/i.test(stemLower)) {
              prompt += `（这是证明题，请给出完整的推导证明过程）\n`;
            } else if (/设计|编程|代码|实现|编写/i.test(stemLower)) {
              prompt += `（这是设计/编程题，请给出设计方案或代码实现，并附上必要的说明）\n`;
            } else if (/案例|材料|结合/i.test(stemLower)) {
              prompt += `（这是材料/案例分析题，请结合材料内容进行分析，答案应基于材料展开）\n`;
            } else {
              prompt += `（这是主观题，请根据题目要求组织答案，内容应完整、准确、条理清晰）\n`;
            }
          } else {
            prompt += `（选项未提取到，请根据题干判断）\n`;
          }
        }
        prompt += '\n';
      }
      prompt += `请输出JSON数组。q字段必须等于上面指定的编号(就是q=0, q=1, q=2...那几个数字)：

【单选/判断格式】
{"q": 0, "index": 0}  ← index是正确选项的序号(0=第1个选项, 1=第2个...)
【多选格式 - 极其重要！多选题必须用"indices"数组！】
{"q": 1, "indices": [0, 1, 3]}  ← 列出所有正确选项的序号！
错误示例(多选)：{"q": 1, "index": 0} ← 这会被直接拒绝！
【填空/解答格式】
{"q": 2, "text": "答案内容"}  单空
{"q": 3, "texts": ["第一空答案", "第二空答案"]}  多空按顺序

关键规则：
- 标记为[多选]的题目必须用 "indices" 数组，至少包含2个选项
- 标记为[单选]/[判断]的题目用 "index" 数字
- 判断题：index 是正确选项的序号（0=第一个选项，1=第二个选项），严格按上面给出的选项顺序作答
- 无法确定时用 {"q": N, "unknown": true}
只输出JSON数组，不要任何解释。`;
      return prompt;
    }

    // ===== API 调用 =====
    _callAPI(prompt, maxTokens = 2000, isRetry = false) {
      return new Promise((resolve, reject) => {
        const req = buildAIRequest(this.settings, prompt, maxTokens);
        const endpoint = req.url;
        logger.debug('AI', `调用API: ${endpoint} 模型=${this.settings.model} 协议=${req.isAnthropic ? 'anthropic' : 'openai'}`);

        GM_xmlhttpRequest({
          method: 'POST',
          url: endpoint,
          headers: req.headers,
          data: req.data,
          timeout: this.settings.timeout,
          onload: (resp) => {
            try {
              const rawText = resp.responseText || resp.response || '';
              if (resp.status !== 200) {
                let errMsg = `HTTP ${resp.status} (${endpoint})`;
                try {
                  const errJson = JSON.parse(rawText);
                  if (errJson.error?.message) errMsg += ': ' + errJson.error.message;
                } catch (_) {
                  if (rawText) errMsg += ': ' + rawText.substring(0, 100);
                }
                reject(new Error(errMsg));
                return;
              }
              const json = JSON.parse(rawText);
              if (json.error) {
                reject(new Error(json.error.message || 'API error'));
                return;
              }
              const { content, finishReason } = parseAIResponse(json, req.isAnthropic);
              const truncated = finishReason === 'length' || finishReason === 'max_tokens';
              if (content) {
                resolve(content);
              } else if (truncated && !isRetry && maxTokens < 16384) {
                const bigger = Math.min(maxTokens * 2, 16384);
                logger.warn('AI', `输出被max_tokens=${maxTokens}截断，提升到${bigger}重试`);
                resolve(this._callAPI(prompt, bigger, true));
              } else {
                const preview = rawText.substring(0, 300);
                logger.warn('AI', `空响应: finish_reason=${finishReason}`, preview);
                reject(new Error(`Empty response (finish_reason=${finishReason})`));
              }
            } catch (e) {
              const rawText = resp.responseText || resp.response || '';
              reject(new Error('Parse error (' + endpoint + '): ' + rawText.substring(0, 150)));
            }
          },
          onerror: (e) => reject(new Error('Network error: ' + (e?.statusText || e?.status || 'unknown') + ' (' + endpoint + ')')),
          ontimeout: () => reject(new Error('API timeout (' + (this.settings.timeout / 1000) + 's)')),
        });
      });
    }

    // ===== 单题解析 =====
    _parseSingleAnswer(content, options, qtype) {
      return this._extractAnswer(content, options, qtype);
    }

    // ===== 批量解析 =====
    _parseBatchAnswer(content, questions) {
      // 处理 markdown 代码块包裹的 JSON
      let cleanContent = content;
      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        cleanContent = codeBlockMatch[1].trim();
      }

      // 尝试提取 JSON 数组
      const arrMatch = cleanContent.match(/\[[\s\S]*\]/);
      if (!arrMatch) {
        logger.warn('AI', '批量返回无JSON数组，尝试逐行解析');
        // 回退：逐题提取单个JSON对象
        return this._parseBatchFallback(content, questions);
      }
      try {
        const arr = JSON.parse(arrMatch[0]);
        if (!Array.isArray(arr)) {
          // 可能是 {"answers": [...]} 格式
          if (arr.answers && Array.isArray(arr.answers)) {
            return this._extractBatchAnswers(arr.answers, questions);
          }
          return null;
        }
        return this._extractBatchAnswers(arr, questions);
      } catch (e) {
        logger.warn('AI', '批量JSON解析失败:', e.message);
        // 回退
        return this._parseBatchFallback(content, questions);
      }
    }

    /** 从已解析的JSON数组中提取答案 */
    _extractBatchAnswers(arr, questions) {
      const answers = [];
      for (const item of arr) {
        if (item.unknown) continue;
        const qIdx = typeof item.q === 'number' ? item.q : (typeof item.question === 'number' ? item.question : -1);
        if (qIdx < 0) continue;

        const bq = questions.find(b => b.index === qIdx);
        if (!bq) continue;

        const isMultiQ = bq.qtype === 'multi' || bq.qtype === QTYPE.MULTI;

        // 多选题：必须用 indices 数组
        if (item.indices && Array.isArray(item.indices) && item.indices.length > 0) {
          const maxOpts = bq.options.length > 0 ? bq.options.length : 10;
          const valid = item.indices.filter(i => typeof i === 'number' && i >= 0 && i < maxOpts);
          if (valid.length > 0) {
            answers.push({ q: qIdx, indices: valid });
            if (isMultiQ && valid.length === 1) {
              logger.warn('AI', `多选q=${qIdx}返回indices但只含1个选项，可能不完整`);
            }
          }
          continue;
        }

        // 单选/判断：用 index
        if (typeof item.index === 'number' && item.index >= 0) {
          // 关键检查：多选题目只返回index → 拒绝，留给后续重试
          if (isMultiQ) {
            logger.warn('AI', `多选q=${qIdx}被AI当作单选(index=${item.index})，拒绝该答案将重试`);
            continue;
          }
          const maxIdx = bq.options.length > 0 ? bq.options.length : 10;
          if (item.index < maxIdx) {
            answers.push({ q: qIdx, index: item.index });
            continue;
          }
        }
        // 字母答案
        if (typeof item.index === 'string' && /^[A-Ha-h]$/.test(item.index)) {
          const map = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7 };
          const idx = map[item.index.toUpperCase()];
          if (idx !== undefined) {
            if (isMultiQ) {
              logger.warn('AI', `多选q=${qIdx}被AI返回为字母答案，拒绝`);
              continue;
            }
            answers.push({ q: qIdx, index: idx });
            continue;
          }
        }
        // 数字字符串索引: {"index": "0"}
        if (typeof item.index === 'string' && /^\d+$/.test(item.index.trim())) {
          const n = parseInt(item.index.trim(), 10);
          const maxIdx = bq.options.length > 0 ? bq.options.length : 10;
          if (!isMultiQ && n >= 0 && n < maxIdx) {
            answers.push({ q: qIdx, index: n });
            continue;
          }
        }
        // 布尔判断答案: {"correct": true}
        if (typeof item.correct === 'boolean') {
          answers.push({ q: qIdx, text: item.correct ? '正确' : '错误' });
          continue;
        }
        // answer 字段数字: {"answer": 1}
        if (!isMultiQ && typeof item.answer === 'number' && item.answer >= 0) {
          const maxIdx = bq.options.length > 0 ? bq.options.length : 10;
          if (item.answer < maxIdx) {
            answers.push({ q: qIdx, index: item.answer });
            continue;
          }
        }
        // answer 字段字母: {"answer": "B"}
        if (!isMultiQ && typeof item.answer === 'string' && /^[A-Ha-h]$/.test(item.answer.trim())) {
          const n = item.answer.trim().toUpperCase().charCodeAt(0) - 65;
          if (n >= 0) { answers.push({ q: qIdx, index: n }); continue; }
        }
        // 多空填空题：按顺序的答案数组
        if (Array.isArray(item.texts) && item.texts.length > 0) {
          answers.push({ q: qIdx, texts: item.texts.map(v => String(v)) });
          continue;
        }
        // 文本答案
        if (item.text || item.answer) {
          answers.push({ q: qIdx, text: item.text || item.answer });
        }
      }
      return { answers };
    }

    /** 逐行解析回退 */
    _parseBatchFallback(content, questions) {
      const answers = [];
      // 尝试匹配 "题目X: A" 或 "Q1: B" 模式
      const lines = content.split(/\n/);
      for (const line of lines) {
        const match = line.match(/(?:题目|题|Q|q)\s*(\d+)\s*[：:]\s*([A-Ha-h])/i);
        if (match) {
          const qIdx = parseInt(match[1]) - 1; // 题目编号从1开始
          const letter = match[2].toUpperCase();
          const idx = letter.charCodeAt(0) - 65;
          const bq = questions.find(b => b.index === qIdx);
          if (bq && idx >= 0 && idx < Math.max(bq.options.length, 10)) {
            answers.push({ q: qIdx, index: idx });
          }
        }
        // 匹配 "Q1: 0" 或 "题目1 索引0"
        const numMatch = line.match(/(?:题目|题|Q|q)\s*(\d+).*?(?:索引|index|选)\s*(\d+)/i);
        if (numMatch) {
          const qIdx = parseInt(numMatch[1]) - 1;
          const index = parseInt(numMatch[2]);
          const bq = questions.find(b => b.index === qIdx);
          if (bq && index >= 0) {
            answers.push({ q: qIdx, index });
          }
        }
      }
      if (answers.length > 0) {
        logger.info('AI', `逐行解析成功: ${answers.length}道`);
        return { answers };
      }
      return null;
    }

    /** 通用：从文本中提取答案 */
    _extractAnswer(content, options, qtype) {
      const maxIdx = options.length > 0 ? options.length : 10;
      const contentLower = content.toLowerCase();

      // 0. 处理 markdown 代码块包裹的 JSON
      let cleanContent = content;
      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        cleanContent = codeBlockMatch[1].trim();
      }

      // 1. JSON 对象
      const jsonMatch = cleanContent.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          const p = JSON.parse(jsonMatch[0]);
          if (p.unknown) return null;
          const isFillQ = qtype === 'fill' || qtype === QTYPE.FILL;
          const isMultiQ = qtype === 'multi' || qtype === QTYPE.MULTI;
          // 多选连续字母: {"answer": "AB"}
          if (isMultiQ && typeof p.answer === 'string' && /^[A-Ha-h]{2,}$/.test(p.answer.trim())) {
            const v = [...new Set(p.answer.trim().toUpperCase().split('').map(l => l.charCodeAt(0) - 65))]
              .filter(i => i >= 0 && i < maxIdx);
            if (v.length > 0) return { indices: v };
          }
          if (p.indices && Array.isArray(p.indices)) {
            const v = p.indices.map(i => typeof i === 'string' ? parseInt(i, 10) : i)
              .filter(i => typeof i === 'number' && i >= 0 && i < maxIdx);
            if (v.length > 0) return { indices: v };
          }
          if (Array.isArray(p.texts) && p.texts.length > 0) {
            return { texts: p.texts.map(v => String(v)) };
          }
          if (Array.isArray(p.answers) && p.answers.length > 0 && isFillQ) {
            return { texts: p.answers.map(v => String(v)) };
          }
          if (typeof p.correct === 'boolean') {
            return { text: p.correct ? '正确' : '错误' };
          }
          // 索引：兼容 index / answer 字段的数字、数字字符串、字母
          const rawIdx = p.index !== undefined ? p.index : p.answer;
          if (!isFillQ) {
            const asNum = typeof rawIdx === 'number' ? rawIdx
              : (typeof rawIdx === 'string' && /^\d+$/.test(rawIdx.trim()) ? parseInt(rawIdx.trim(), 10) : NaN);
            if (!Number.isNaN(asNum) && asNum >= 0 && asNum < maxIdx) return { index: asNum };
            if (typeof rawIdx === 'string' && /^[A-Ha-h]$/.test(rawIdx.trim())) {
              const n = rawIdx.trim().toUpperCase().charCodeAt(0) - 65;
              if (n >= 0 && n < maxIdx) return { index: n };
            }
          }
          // 填空题的纯数字答案
          if (isFillQ && (typeof p.text === 'number' || typeof p.answer === 'number')) {
            return { text: String(p.text !== undefined ? p.text : p.answer) };
          }
          // 文本答案（填空/判断/解答等）
          const textAnswer = p.text || p.answer || p.value;
          if (typeof textAnswer === 'string' && textAnswer.length > 0 && textAnswer.length < 200) {
            return { text: textAnswer };
          }
          if (Array.isArray(p.text) && p.text.length > 0) {
            return { texts: p.text.map(v => String(v)) };
          }
        } catch (e) {}
      }

      // 2. 独立字母 (单选/判断) - 多种格式
      if (qtype !== 'multi' && qtype !== QTYPE.MULTI) {
        const letterPatterns = [
          /(?:答案|正确选项|选)\s*[：:是为]\s*([A-Ha-h])/i,
          /^[（(]?\s*([A-Ha-h])\s*[）)]?$/im,
          /(?:^|\n)\s*([A-H])\s*[\n.]/,
          /\b([A-H])\s*[.、．)]/,
          /(?:正确.*?(?:是|为|选项?))\s*([A-Ha-h])/i,
          /"index"\s*:\s*(\d+)/,
        ];
        for (const pat of letterPatterns) {
          const m = cleanContent.match(pat);
          if (m) {
            const letterOrNum = m[1];
            if (/^\d+$/.test(letterOrNum)) {
              const idx = parseInt(letterOrNum);
              if (idx >= 0 && idx < maxIdx) return { index: idx };
            } else {
              const idx = letterOrNum.toUpperCase().charCodeAt(0) - 65;
              if (idx >= 0 && idx < maxIdx) return { index: idx };
            }
          }
        }
        // 判断题特殊处理：按选项极性定位索引
        if (qtype === QTYPE.JUDGE || qtype === 'judge') {
          const pol = judgePolarity(cleanContent.substring(0, 30));
          if (pol !== -1) {
            for (let i = 0; i < options.length; i++) {
              if (judgePolarity(options[i]) === pol) return { index: i };
            }
            return { index: pol === 1 ? 0 : 1 };
          }
        }
      }

      // 3. 多选字母
      if (qtype === 'multi' || qtype === QTYPE.MULTI) {
        // 先尝试 "ABC" 连续字母模式
        const multiLetterMatch = cleanContent.match(/(?:答案|正确|选)[^\n]*?([A-Ha-h]{2,})/i);
        if (multiLetterMatch) {
          const indices = [...new Set(multiLetterMatch[1].toUpperCase().split('').map(l => l.charCodeAt(0) - 65).filter(i => i >= 0 && i < maxIdx))];
          if (indices.length > 0) return { indices };
        }
        // 逗号分隔的字母
        const commaSepMatch = cleanContent.match(/([A-Ha-h](?:\s*[,，、]\s*[A-Ha-h])+)/i);
        if (commaSepMatch) {
          const letters = commaSepMatch[1].match(/[A-Ha-h]/gi) || [];
          const indices = [...new Set(letters.map(l => l.toUpperCase().charCodeAt(0) - 65).filter(i => i >= 0 && i < maxIdx))];
          if (indices.length > 0) return { indices };
        }
        // 回退到单字母匹配
        const letters = cleanContent.match(/[A-H]/gi);
        if (letters && letters.length >= 1) {
          const indices = [...new Set(letters.map(l => l.toUpperCase().charCodeAt(0) - 65).filter(i => i >= 0 && i < maxIdx))];
          if (indices.length > 0) return { indices };
        }
      }

      // 4. 填空题/解答题：直接返回文本
      if (qtype === QTYPE.FILL || qtype === QTYPE.ESSAY || qtype === 'fill' || qtype === 'essay') {
        // 尝试提取引号中的内容或冒号后的内容
        const textMatch = cleanContent.match(/(?:答案|填空|填|答|答案要点|解题过程|结果|解答|解)[：:]\s*(.+)/i) ||
                          cleanContent.match(/"text"\s*:\s*"([^"]+)"/) ||
                          cleanContent.match(/'text'\s*:\s*'([^']+)'/);
        if (textMatch) return { text: textMatch[1].trim() };
        // 返回整个去噪后的内容作为答案
        const cleaned = cleanContent
          .replace(/^[^{]*\{/, '')  // 去掉JSON前的文字
          .replace(/\}[^}]*$/, '')  // 去掉JSON后的文字
          .replace(/```/g, '')
          .trim();
        const maxSubjLen = (qtype === QTYPE.ESSAY || qtype === 'essay') ? 5000 : 200;
        if (cleaned && cleaned.length >= 1 && cleaned.length < maxSubjLen) {
          return { text: cleaned };
        }
      }

      logger.warn('AI', '无法解析:', content.substring(0, 150));
      return null;
    }
  }

  // ============================================================
  //  DOM UTILITIES
  // ============================================================
  class DOM {
    static waitFor(selector, timeout = CONFIG.maxWaitForElement, parent = document) {
      return new Promise((resolve) => {
        const el = parent.querySelector(selector);
        if (el) return resolve(el);
        const observer = new MutationObserver(() => {
          const el = parent.querySelector(selector);
          if (el) { observer.disconnect(); resolve(el); }
        });
        observer.observe(parent, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
      });
    }

    static waitForAny(selectors, timeout = CONFIG.maxWaitForElement, parent = document) {
      return new Promise((resolve) => {
        for (const sel of selectors) {
          const el = parent.querySelector(sel);
          if (el) return resolve({ el, selector: sel });
        }
        const observer = new MutationObserver(() => {
          for (const sel of selectors) {
            const el = parent.querySelector(sel);
            if (el) { observer.disconnect(); resolve({ el, selector: sel }); return; }
          }
        });
        observer.observe(parent, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
      });
    }

    static sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    static safeClick(el) {
      if (!el) return false;
      try {
        // Dispatch mousedown/mouseup/click sequence for Vue/React frameworks
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        el.click();
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        // Also try pointer events (some mobile-first frameworks use these)
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        return true;
      } catch (e) {
        return false;
      }
    }

    /**
     * 单次点击激活。label 内的原生 checkbox 每收到一次 click 就切换一次选中状态，
     * 双重触发（click() + dispatchEvent('click')）会点了又取消，多选必须用这个。
     */
    static safeClickOnce(el) {
      if (!el) return false;
      try {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        el.click();
        return true;
      } catch (e) {
        return false;
      }
    }

    static safeSetValue(el, value) {
      if (!el) return false;
      try {
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      } catch (e) {
        return false;
      }
    }

    static getText(el) {
      if (!el) return '';
      return (el.textContent || el.innerText || '').trim();
    }

    static normalizeText(text) {
      return text.replace(/[\s\n\r\t]+/g, ' ').replace(/([A-Z])[.、．]\s*/g, '$1. ').trim();
    }

    static findByText(selector, text, parent = document) {
      const els = parent.querySelectorAll(selector);
      for (const el of els) {
        if (DOM.getText(el).includes(text)) return el;
      }
      return null;
    }

    static findAllByText(selector, text, parent = document) {
      const result = [];
      const els = parent.querySelectorAll(selector);
      for (const el of els) {
        if (DOM.getText(el).includes(text)) result.push(el);
      }
      return result;
    }

    static findButtonByText(text, parent = document) {
      const buttons = parent.querySelectorAll('button, a, [role="button"], [class*="btn"], span[class*="btn"]');
      for (const btn of buttons) {
        if (DOM.getText(btn).includes(text)) return btn;
      }
      return null;
    }

    // 安全 querySelectorAll，处理 jQuery :contains() 伪选择器
    static queryAll(selectorList, parent = document) {
      const results = [];
      const parts = selectorList.split(',').map(s => s.trim()).filter(Boolean);
      for (const sel of parts) {
        const m = sel.match(/^(.+?):contains\(["'](.+?)["']\)$/);
        if (m) {
          const base = m[1].trim() || '*';
          const text = m[2];
          const els = parent.querySelectorAll(base);
          for (const el of els) {
            if (DOM.getText(el).includes(text)) results.push(el);
          }
        } else {
          try {
            const els = parent.querySelectorAll(sel);
            for (const el of els) results.push(el);
          } catch (_) { /* skip invalid selectors */ }
        }
      }
      return results;
    }

    // 安全 querySelector，返回第一个匹配
    static queryFirst(selectorList, parent = document) {
      const results = DOM.queryAll(selectorList, parent);
      return results.length > 0 ? results[0] : null;
    }

    static hasClass(el, className) {
      if (!el || !el.className) return false;
      return el.className.includes
        ? el.className.includes(className)
        : el.classList.contains(className);
    }
  }

  // ============================================================
  //  UI PANEL
  // ============================================================
  class UIPanel {
    constructor() {
      this.container = null;
      this.statusText = null;
      this.logContainer = null;
      this.isRunning = false;
      this.manualWait = false;
      this.callbacks = {};
      this.logLines = [];
    }

    on(event, cb) { this.callbacks[event] = cb; }
    emit(event, data) { if (this.callbacks[event]) this.callbacks[event](data); }

    create() {
      if (document.getElementById('yuketang-helper-panel')) return;

      // 注入样式
      GM_addStyle(`
        #yuketang-helper-panel {
          position: fixed; top: 80px; right: 16px; z-index: 99999;
          width: 320px; max-height: 80vh;
          background: #fff; border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0,0,0,.18);
          font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
          font-size: 13px; color: #333;
          display: flex; flex-direction: column;
          overflow: hidden;
          user-select: none;
        }
        #yuketang-helper-panel.dragging { opacity: 0.9; }
        #ykh-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 14px; background: linear-gradient(135deg, #1a73e8, #0d5bbd);
          color: #fff; font-weight: 600; font-size: 14px;
          cursor: move; flex-shrink: 0;
        }
        #ykh-header .ykh-logo { display: flex; align-items: center; gap: 6px; }
        #ykh-header .ykh-badge {
          font-size: 11px; background: rgba(255,255,255,.25);
          padding: 2px 8px; border-radius: 10px;
        }
        #ykh-body {
          padding: 12px 14px; overflow-y: auto; flex: 1;
          display: flex; flex-direction: column; gap: 10px;
        }
        .ykh-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .ykh-row label { font-size: 12px; color: #666; min-width: 52px; }
        .ykh-row select, .ykh-row input {
          flex: 1; padding: 6px 8px; border: 1px solid #ddd;
          border-radius: 6px; font-size: 12px; outline: none;
        }
        .ykh-row select:focus, .ykh-row input:focus { border-color: #1a73e8; }
        .ykh-btn {
          padding: 8px 16px; border: none; border-radius: 6px;
          font-size: 13px; font-weight: 500; cursor: pointer;
          transition: all .2s;
        }
        .ykh-btn-primary {
          background: #1a73e8; color: #fff; flex: 1;
        }
        .ykh-btn-primary:hover { background: #1557b0; }
        .ykh-btn-primary.running {
          background: #e74c3c;
        }
        .ykh-btn-primary.running:hover { background: #c0392b; }
        .ykh-btn-primary.manual-wait {
          background: #ff9800; color: #fff;
        }
        .ykh-btn-primary.manual-wait:hover { background: #f57c00; }
        .ykh-btn-secondary {
          background: #f1f3f4; color: #333;
        }
        .ykh-btn-secondary:hover { background: #e0e0e0; }
        #ykh-confirm-mask {
          position: absolute; inset: 0; z-index: 10;
          background: rgba(0,0,0,.35);
          display: none; align-items: center; justify-content: center;
        }
        #ykh-confirm-mask.show { display: flex; }
        .ykh-confirm-box {
          width: 250px; background: #fff; border-radius: 10px;
          padding: 16px; box-shadow: 0 6px 24px rgba(0,0,0,.25);
        }
        .ykh-confirm-text { font-size: 13px; color: #333; line-height: 1.6; margin-bottom: 14px; }
        .ykh-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
        .ykh-confirm-actions .ykh-btn { flex: 0 0 auto; padding: 6px 14px; }
        #ykh-status {
          padding: 8px 12px; border-radius: 6px;
          font-size: 12px; text-align: center;
          background: #e8f5e9; color: #2e7d32;
          min-height: 20px;
        }
        #ykh-status.warning { background: #fff3e0; color: #e65100; }
        #ykh-status.error { background: #ffebee; color: #c62828; }
        #ykh-status.info { background: #e3f2fd; color: #1565c0; }
        #ykh-log {
          max-height: 160px; overflow-y: auto;
          background: #f8f9fa; border-radius: 6px;
          padding: 6px 8px; font-size: 11px;
          color: #555; line-height: 1.5;
          font-family: 'Consolas','Monaco',monospace;
        }
        #ykh-log .log-line { word-break: break-all; }
        #ykh-log .log-line.log-warn { color: #e65100; }
        #ykh-log .log-line.log-error { color: #c62828; }
        #ykh-progress { margin-top: 4px; }
        #ykh-progress-bar {
          height: 4px; background: #e0e0e0; border-radius: 2px;
          overflow: hidden;
        }
        #ykh-progress-fill {
          height: 100%; background: #1a73e8;
          width: 0%; transition: width .5s;
        }
        #ykh-progress-text { font-size: 11px; color: #999; margin-top: 2px; text-align: center; }
        .ykh-toggle { position: relative; display: inline-block; width: 40px; height: 22px; }
        .ykh-toggle input { opacity: 0; width: 0; height: 0; }
        .ykh-slider {
          position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
          background: #ccc; border-radius: 22px; transition: .3s;
        }
        .ykh-slider::before {
          content: ""; position: absolute; height: 16px; width: 16px;
          left: 3px; bottom: 3px; background: #fff;
          border-radius: 50%; transition: .3s;
        }
        .ykh-toggle input:checked + .ykh-slider { background: #1a73e8; }
        .ykh-toggle input:checked + .ykh-slider::before { transform: translateX(18px); }
        #ykh-minimize {
          cursor: pointer; font-size: 18px; line-height: 1;
          opacity: 0.8; padding: 0 4px;
        }
        #ykh-minimize:hover { opacity: 1; }
        #ykh-body.ykh-collapsed { display: none; }
        #ykh-ai-section { border-top: 1px solid #eee; padding-top: 6px; margin-top: 2px; }
        #ykh-ai-header { user-select: none; }
        #ykh-ai-body .ykh-row label { min-width: 44px; }
        #ykh-ai-body .ykh-row input { font-size: 11px; padding: 4px 6px; }
        #ykh-missing { display: none; background: #fff8e1; border: 1px solid #ffe0a3; border-radius: 6px; padding: 6px 8px; }
        #ykh-missing .ykh-missing-title { font-size: 12px; color: #e65100; font-weight: 600; margin-bottom: 4px; }
        #ykh-missing .ykh-missing-list { max-height: 140px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
        #ykh-missing .ykh-missing-item {
          font-size: 11px; color: #333; background: #fff; border: 1px solid #ffe0a3;
          border-radius: 4px; padding: 4px 6px; cursor: pointer;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        #ykh-missing .ykh-missing-item:hover { background: #ffecb3; border-color: #ffb74d; }
        #ykh-answered { display: none; background: #eef7ee; border: 1px solid #cde8cd; border-radius: 6px; padding: 6px 8px; }
        #ykh-answered .ykh-answered-title { font-size: 12px; color: #2e7d32; font-weight: 600; margin-bottom: 4px; }
        #ykh-answered .ykh-answered-list { max-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
        #ykh-answered .ykh-answered-item { display: flex; align-items: center; gap: 4px; background: #fff; border: 1px solid #cde8cd; border-radius: 4px; padding: 3px 4px 3px 6px; }
        #ykh-answered .ykh-answered-text { flex: 1; font-size: 11px; color: #333; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #ykh-answered .ykh-answered-text:hover { color: #1a73e8; }
        #ykh-answered .ykh-reanswer-btn { flex: none; font-size: 11px; line-height: 1; cursor: pointer; border: 1px solid #81c784; background: #f1f8e9; color: #2e7d32; border-radius: 4px; padding: 3px 5px; }
        #ykh-answered .ykh-reanswer-btn:hover { background: #c8e6c9; }
        .ykh-flash-question { animation: ykh-flash-anim 1.1s ease 2; }
        @keyframes ykh-flash-anim {
          0%, 100% { box-shadow: 0 0 0 0 rgba(26,115,232,0); }
          50% { box-shadow: 0 0 0 6px rgba(26,115,232,.55); }
        }
      `);

      // 创建面板 DOM
      const panel = document.createElement('div');
      panel.id = 'yuketang-helper-panel';
      panel.innerHTML = `
        <div id="ykh-header">
          <div class="ykh-logo">
            <span>🎓 雨课堂助手</span>
            <span class="ykh-badge">v${(typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '3.2.2'}</span>
          </div>
          <span id="ykh-minimize" title="最小化">−</span>
        </div>
        <div id="ykh-body">
          <div class="ykh-row">
            <label>播放倍速</label>
            <select id="ykh-speed">
              ${CONFIG.speeds.map(s => `<option value="${s}" ${s === Storage.getSettings().speed ? 'selected' : ''}>${s}x</option>`).join('')}
            </select>
          </div>
          <div class="ykh-row">
            <label>静音播放</label>
            <label class="ykh-toggle">
              <input type="checkbox" id="ykh-muted" ${Storage.getSettings().muted ? 'checked' : ''}>
              <span class="ykh-slider"></span>
            </label>
            <span style="font-size:11px;color:#999;margin-left:4px;">默认开启</span>
          </div>
          <div class="ykh-row">
            <label>自动下一章</label>
            <label class="ykh-toggle">
              <input type="checkbox" id="ykh-auto-next" ${Storage.getSettings().autoNext ? 'checked' : ''}>
              <span class="ykh-slider"></span>
            </label>
          </div>
          <div class="ykh-row">
            <label>跨课程模式</label>
            <label class="ykh-toggle">
              <input type="checkbox" id="ykh-cross-course" ${Storage.getSettings().crossCourse ? 'checked' : ''}>
              <span class="ykh-slider"></span>
            </label>
            <span style="font-size:11px;color:#999;margin-left:4px;">完成后自动换课</span>
          </div>
          <div id="ykh-video-progress" style="display:none; padding:6px 10px; background:#f0f7ff; border-radius:6px; font-size:11px; color:#1a73e8;">
            <div style="display:flex;justify-content:space-between;">
              <span>📺 视频进度</span>
              <span id="ykh-video-progress-text">--</span>
            </div>
          </div>
          <div id="ykh-ai-section">
            <div id="ykh-ai-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:4px 0;">
              <span style="font-size:12px;color:#999;">🤖 AI 答题设置</span>
              <span id="ykh-ai-toggle-icon" style="font-size:12px;color:#999;">▼</span>
            </div>
            <div id="ykh-ai-body" style="display:flex;flex-direction:column;gap:6px;">
              <div class="ykh-row">
                <label>启用AI</label>
                <label class="ykh-toggle">
                  <input type="checkbox" id="ykh-ai-enabled" ${Storage.getAISettings().enabled ? 'checked' : ''}>
                  <span class="ykh-slider"></span>
                </label>
              </div>
              <div class="ykh-row">
                <label>API地址</label>
                <div style="display:flex;gap:4px;flex:1;">
                  <input type="text" id="ykh-ai-endpoint" value="${Storage.getAISettings().endpoint}" placeholder="API endpoint" style="flex:1;">
                  <button id="ykh-ai-reset-endpoint" title="重置为DeepSeek默认地址" style="font-size:11px;cursor:pointer;border:1px solid #ddd;background:#f5f5f5;border-radius:4px;padding:0 6px;white-space:nowrap;">重置</button>
                </div>
              </div>
              <div class="ykh-row">
                <label>API Key</label>
                <input type="password" id="ykh-ai-key" value="${Storage.getAISettings().apiKey}" placeholder="sk-...">
              </div>
              <div class="ykh-row">
                <label>模型</label>
                <div style="display:flex;gap:4px;flex:1;">
                  <input type="text" id="ykh-ai-model" value="${Storage.getAISettings().model}" placeholder="deepseek-chat" style="flex:1;">
                  <button id="ykh-ai-test" title="发送测试请求验证API配置" style="font-size:11px;cursor:pointer;border:1px solid #ddd;background:#f5f5f5;border-radius:4px;padding:0 6px;white-space:nowrap;">测试</button>
                </div>
              </div>
            </div>
          </div>
          <div class="ykh-row" style="gap:6px;">
            <button id="ykh-btn-start" class="ykh-btn ykh-btn-primary">▶ 开始运行</button>
            <button id="ykh-btn-rescan" class="ykh-btn ykh-btn-secondary" title="重新扫描课程">🔄</button>
            <button id="ykh-btn-clear-page" class="ykh-btn ykh-btn-secondary" title="扫描并清除页面上的全部答案（单选/判断/多选/填空），不重新作答">🧹</button>
            <button id="ykh-btn-extract" class="ykh-btn ykh-btn-secondary" title="提取试题：把当前试卷的全部题目和答案导出为 Word 文档">📄</button>
          </div>
          <div id="ykh-status">就绪 - 请打开课程页面</div>
          <div id="ykh-missing">
            <div class="ykh-missing-title">⚠️ 未完成题目（点击定位）</div>
            <div class="ykh-missing-list"></div>
          </div>
          <div id="ykh-answered">
            <div class="ykh-answered-title">📋 已作答题目（点 ↻ 重新 AI 作答）</div>
            <div class="ykh-answered-list"></div>
          </div>
          <div id="ykh-progress" style="display:none;">
            <div id="ykh-progress-bar"><div id="ykh-progress-fill"></div></div>
            <div id="ykh-progress-text"></div>
          </div>
          <div id="ykh-log"></div>
        </div>
        <div id="ykh-confirm-mask">
          <div class="ykh-confirm-box">
            <div class="ykh-confirm-text">是否提取当前试卷的全部题目和答案，并保存为 Word 文档？</div>
            <div class="ykh-confirm-actions">
              <button id="ykh-confirm-cancel" class="ykh-btn ykh-btn-secondary">取消</button>
              <button id="ykh-confirm-ok" class="ykh-btn ykh-btn-primary">确认提取</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(panel);

      // 绑定元素
      this.container = panel;
      this.statusText = document.getElementById('ykh-status');
      this.logContainer = document.getElementById('ykh-log');
      this.bodyEl = document.getElementById('ykh-body');

      // 拖拽
      this._makeDraggable(document.getElementById('ykh-header'), panel);

      // 最小化
      document.getElementById('ykh-minimize').addEventListener('click', () => {
        const body = document.getElementById('ykh-body');
        body.classList.toggle('ykh-collapsed');
        document.getElementById('ykh-minimize').textContent =
          body.classList.contains('ykh-collapsed') ? '+' : '−';
      });

      // 事件绑定
      document.getElementById('ykh-btn-start').addEventListener('click', () => {
        if (this.isRunning && !this.manualWait) {
          this.emit('stop');
        } else {
          this.emit('start');
        }
      });

      document.getElementById('ykh-btn-rescan').addEventListener('click', () => {
        this.emit('rescan');
      });

      document.getElementById('ykh-btn-clear-page').addEventListener('click', () => {
        this.emit('clearPageAnswers');
      });

      // 提取试题：先弹确认框，点"确认提取"后在同一手势内打开保存对话框
      const confirmMask = document.getElementById('ykh-confirm-mask');
      document.getElementById('ykh-btn-extract').addEventListener('click', () => {
        confirmMask.classList.add('show');
      });
      document.getElementById('ykh-confirm-cancel').addEventListener('click', () => {
        confirmMask.classList.remove('show');
      });
      document.getElementById('ykh-confirm-ok').addEventListener('click', () => {
        confirmMask.classList.remove('show');
        this.emit('extractExam');
      });

      document.getElementById('ykh-speed').addEventListener('change', (e) => {
        Storage.setSettings({ speed: parseFloat(e.target.value) });
        this.emit('speedChange', parseFloat(e.target.value));
      });

      document.getElementById('ykh-muted').addEventListener('change', (e) => {
        Storage.setSettings({ muted: e.target.checked });
        this.emit('mutedChange', e.target.checked);
      });

      document.getElementById('ykh-auto-next').addEventListener('change', (e) => {
        Storage.setSettings({ autoNext: e.target.checked });
      });

      document.getElementById('ykh-cross-course').addEventListener('change', (e) => {
        Storage.setSettings({ crossCourse: e.target.checked });
        this.emit('crossCourseChange', e.target.checked);
      });

      // AI 设置折叠
      document.getElementById('ykh-ai-header').addEventListener('click', () => {
        const body = document.getElementById('ykh-ai-body');
        const icon = document.getElementById('ykh-ai-toggle-icon');
        const collapsed = body.style.display === 'none';
        body.style.display = collapsed ? '' : 'none';
        icon.textContent = collapsed ? '▼' : '▶';
      });

      // AI 设置变更 → emit AI 配置
      const emitAISettings = () => {
        const settings = {
          enabled: document.getElementById('ykh-ai-enabled').checked,
          endpoint: document.getElementById('ykh-ai-endpoint').value.trim(),
          apiKey: document.getElementById('ykh-ai-key').value.trim(),
          model: document.getElementById('ykh-ai-model').value.trim(),
        };
        Storage.setAISettings(settings);
        this.emit('aiSettingsChange', settings);
      };

      document.getElementById('ykh-ai-enabled').addEventListener('change', emitAISettings);
      document.getElementById('ykh-ai-endpoint').addEventListener('change', emitAISettings);
      document.getElementById('ykh-ai-key').addEventListener('change', emitAISettings);
      document.getElementById('ykh-ai-model').addEventListener('change', emitAISettings);

      // 重置 API 地址为 DeepSeek 默认
      document.getElementById('ykh-ai-reset-endpoint').addEventListener('click', () => {
        const defaultEndpoint = 'https://api.deepseek.com/v1/chat/completions';
        document.getElementById('ykh-ai-endpoint').value = defaultEndpoint;
        emitAISettings();
        this.log('API地址已重置为: ' + defaultEndpoint);
      });

      // 测试 API 连接
      document.getElementById('ykh-ai-test').addEventListener('click', async () => {
        const endpoint = document.getElementById('ykh-ai-endpoint').value.trim();
        const apiKey = document.getElementById('ykh-ai-key').value.trim();
        const model = document.getElementById('ykh-ai-model').value.trim();
        if (!apiKey) { this.log('请先填写 API Key', 'warn'); return; }
        if (!endpoint) { this.log('请先填写 API 地址', 'warn'); return; }
        const req = buildAIRequest({ endpoint, apiKey, model }, '你好，请回复"连接成功"两个字，不要其他内容。', 64);
        this.log(`🔍 测试连接: ${req.url} (${req.isAnthropic ? 'Anthropic' : 'OpenAI'} 协议) ...`);
        try {
          const result = await new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
              method: 'POST', url: req.url, timeout: 30000,
              headers: req.headers,
              data: req.data,
              onload: (resp) => {
                const rawText = resp.responseText || resp.response || '';
                if (resp.status !== 200) {
                  let err = `HTTP ${resp.status}`;
                  try {
                    const j = JSON.parse(rawText);
                    if (j.error?.message) err += ': ' + j.error.message;
                  } catch (_) {}
                  reject(new Error(err));
                  return;
                }
                try {
                  const content = parseAIResponse(JSON.parse(rawText), req.isAnthropic).content;
                  resolve(content || 'HTTP 200（连接正常，思考型模型未输出正文）');
                } catch (e) { reject(new Error('Parse error')); }
              },
              onerror: (e) => reject(new Error('Network error: ' + (e?.statusText || 'unknown'))),
              ontimeout: () => reject(new Error('Timeout (30s)')),
            });
          });
          this.log(`✅ 连接成功! 模型=${model}, 回复="${result}"`, 'info');
        } catch (e) {
          this.log(`❌ 连接失败: ${e.message}`, 'error');
        }
      });

      // 检查 API Key 是否存在 → 无 key 时默认折叠
      if (!Storage.getAISettings().apiKey) {
        document.getElementById('ykh-ai-body').style.display = 'none';
        document.getElementById('ykh-ai-toggle-icon').textContent = '▶';
      }
    }

    setRunning(running) {
      this.isRunning = running;
      const btn = document.getElementById('ykh-btn-start');
      if (running) {
        btn.textContent = '⏸ 停止运行';
        btn.classList.add('running');
        btn.classList.remove('manual-wait');
      } else {
        btn.textContent = '▶ 开始运行';
        btn.classList.remove('running');
        btn.classList.remove('manual-wait');
      }
    }

    setManualWaitMode(active) {
      this.manualWait = active;
      const btn = document.getElementById('ykh-btn-start');
      if (active) {
        btn.textContent = '✅ 继续运行';
        btn.classList.remove('running');
        btn.classList.add('manual-wait');
      } else {
        btn.classList.remove('manual-wait');
        if (this.isRunning) {
          btn.textContent = '⏸ 停止运行';
          btn.classList.add('running');
        } else {
          btn.textContent = '▶ 开始运行';
          btn.classList.remove('running');
        }
      }
    }

    setStatus(text, type = '') {
      if (this.statusText) {
        this.statusText.textContent = text;
        this.statusText.className = type || '';
      }
    }

    log(text, level = '') {
      this.logLines.push({ text, level, time: new Date() });
      if (this.logLines.length > 100) this.logLines.shift();
      if (this.logContainer) {
        const div = document.createElement('div');
        div.className = 'log-line' + (level ? ' log-' + level : '');
        const time = new Date().toLocaleTimeString();
        div.textContent = `[${time}] ${text}`;
        this.logContainer.appendChild(div);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
      }
    }

    setProgress(current, total) {
      const progressEl = document.getElementById('ykh-progress');
      const fillEl = document.getElementById('ykh-progress-fill');
      const textEl = document.getElementById('ykh-progress-text');
      if (total > 0) {
        progressEl.style.display = 'block';
        const pct = Math.round((current / total) * 100);
        fillEl.style.width = pct + '%';
        textEl.textContent = `${current} / ${total} (${pct}%)`;
      } else {
        progressEl.style.display = 'none';
      }
    }

    getSpeed() {
      const sel = document.getElementById('ykh-speed');
      return sel ? parseFloat(sel.value) : CONFIG.defaultSpeed;
    }

    isMuted() {
      const chk = document.getElementById('ykh-muted');
      return chk ? chk.checked : CONFIG.defaultMuted;
    }

    isAutoNext() {
      const chk = document.getElementById('ykh-auto-next');
      return chk ? chk.checked : CONFIG.autoNextChapter;
    }

    isCrossCourse() {
      const chk = document.getElementById('ykh-cross-course');
      return chk ? chk.checked : true;
    }

    /** 更新未完成题目列表；点击条目滚动到对应题目并闪烁高亮 */
    setMissingQuestions(items) {
      const wrap = document.getElementById('ykh-missing');
      const list = wrap?.querySelector('.ykh-missing-list');
      if (!wrap || !list) return;
      list.innerHTML = '';
      if (!items || items.length === 0) {
        wrap.style.display = 'none';
        return;
      }
      wrap.style.display = 'block';
      const title = wrap.querySelector('.ykh-missing-title');
      if (title) title.textContent = `⚠️ 未完成题目 ${items.length} 道（点击定位）`;
      for (const it of items) {
        const div = document.createElement('div');
        div.className = 'ykh-missing-item';
        div.textContent = it.text;
        div.title = it.text;
        div.addEventListener('click', () => {
          const el = typeof it.el === 'function' ? it.el() : it.el;
          if (!el || !el.isConnected) return;
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('ykh-flash-question');
          setTimeout(() => el.classList.remove('ykh-flash-question'), 2500);
        });
        list.appendChild(div);
      }
    }

    /** 更新已作答题目列表；点条目定位，点 ↻ 触发单题重答（emit stemKey） */
    setAnsweredQuestions(items) {
      const wrap = document.getElementById('ykh-answered');
      const list = wrap?.querySelector('.ykh-answered-list');
      if (!wrap || !list) return;
      list.innerHTML = '';
      if (!items || items.length === 0) {
        wrap.style.display = 'none';
        return;
      }
      wrap.style.display = 'block';
      const title = wrap.querySelector('.ykh-answered-title');
      if (title) title.textContent = `📋 已作答 ${items.length} 道（点 ↻ 重新 AI 作答）`;
      for (const it of items) {
        const row = document.createElement('div');
        row.className = 'ykh-answered-item';
        const txt = document.createElement('span');
        txt.className = 'ykh-answered-text';
        txt.textContent = it.text;
        txt.title = it.text;
        txt.addEventListener('click', () => {
          const el = typeof it.el === 'function' ? it.el() : it.el;
          if (!el || !el.isConnected) return;
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('ykh-flash-question');
          setTimeout(() => el.classList.remove('ykh-flash-question'), 2500);
        });
        const btn = document.createElement('button');
        btn.className = 'ykh-reanswer-btn';
        btn.textContent = '↻';
        btn.title = '忽略缓存，重新用 AI 作答这一题';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.emit('reanswerQuestion', it.stemKey);
        });
        row.appendChild(txt);
        row.appendChild(btn);
        list.appendChild(row);
      }
    }

    updateVideoProgress(info) {
      const el = document.getElementById('ykh-video-progress');
      const textEl = document.getElementById('ykh-video-progress-text');
      if (!el || !textEl) return;
      if (info && (info.progressText || info.duration > 0)) {
        el.style.display = 'block';
        if (info.progressText) {
          textEl.textContent = info.progressText;
        } else if (info.duration > 0) {
          const pct = Math.round((info.currentTime / info.duration) * 100);
          const fmt = (t) => {
            const m = Math.floor(t / 60);
            const s = Math.floor(t % 60);
            return `${m}:${String(s).padStart(2, '0')}`;
          };
          textEl.textContent = `${pct}% (${fmt(info.currentTime)}/${fmt(info.duration)})`;
        }
      } else {
        el.style.display = 'none';
      }
    }

    _makeDraggable(header, panel) {
      let offsetX = 0, offsetY = 0, startX = 0, startY = 0, dragging = false;

      header.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
        dragging = true;
        panel.classList.add('dragging');
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        offsetX = startX - rect.left;
        offsetY = startY - rect.top;
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const x = e.clientX - offsetX;
        const y = e.clientY - offsetY;
        const maxX = window.innerWidth - panel.offsetWidth;
        const maxY = window.innerHeight - panel.offsetHeight;
        panel.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
        panel.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
        panel.style.right = 'auto';
      });

      document.addEventListener('mouseup', () => {
        if (dragging) {
          dragging = false;
          panel.classList.remove('dragging');
        }
      });
    }

    destroy() {
      if (this.container) {
        this.container.remove();
        this.container = null;
      }
    }

    show() {
      if (this.container) this.container.style.display = '';
    }

    hide() {
      if (this.container) this.container.style.display = 'none';
    }
  }

  // ============================================================
  //  VIDEO HANDLER (optimized with platform-specific selectors)
  // ============================================================
  class VideoHandler {
    constructor(ui) {
      this.ui = ui;
      this.currentVideo = null;
      this.observer = null;
      this.isHandling = false;
      this.watchInterval = null;
      this.muteGuardInterval = null;
      this.lastVideoSrc = '';
      this.videoStartTime = 0;
      this.maxVideoWaitMs = 40 * 60 * 1000;
      this._playAttempts = 0;
      this._lastProgress = '';
      this._progressStuckCount = 0;
      this._lastPlayAttemptAt = 0;
      this._pauseRetryTimer = null;
    }

    start() {
      this.isHandling = true;
      this._playAttempts = 0;
      this._lastProgress = '';
      this._progressStuckCount = 0;
      this._lastPlayAttemptAt = 0;
      if (!this._onVisibilityChange) {
        this._onVisibilityChange = () => {
          if (!this.isHandling || document.hidden) return;
          if (this.currentVideo && this.currentVideo.paused && !this.currentVideo.ended) {
            logger.info('Video', '页面恢复可见，尝试恢复播放');
            this._tryPlay(true);
          }
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);
      }
      this.scanAndHandle();
      this.observeVideoChanges();
      this.watchInterval = setInterval(() => this.scanAndHandle(), CONFIG.videoCheckInterval);
      this._startMuteGuardian();
    }

    stop() {
      this.isHandling = false;
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
      if (this.watchInterval) { clearInterval(this.watchInterval); this.watchInterval = null; }
      if (this.muteGuardInterval) { clearInterval(this.muteGuardInterval); this.muteGuardInterval = null; }
      if (this._pauseRetryTimer) { clearTimeout(this._pauseRetryTimer); this._pauseRetryTimer = null; }
      if (this._onVisibilityChange) {
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        this._onVisibilityChange = null;
      }
      this.currentVideo = null;
      this._playAttempts = 0;
      this._progressStuckCount = 0;
    }

    // 静音守护：每500ms检查一次（前2分钟），之后每3秒检查
    _startMuteGuardian() {
      if (this.muteGuardInterval) clearInterval(this.muteGuardInterval);
      let fastTicks = 0;
      const MAX_FAST = 240;

      this.muteGuardInterval = setInterval(() => {
        if (!this.isHandling) return;
        fastTicks++;

        // 平台专用静音按钮 (长江雨课堂 .xt_video_player_volume)
        const muteIcon = document.querySelector('.xt_video_player_volume .xt_video_player_common_icon');
        if (muteIcon) {
          const isMuted = muteIcon.classList.contains('xt_video_player_common_icon_muted');
          if (!isMuted && this.ui.isMuted()) {
            logger.debug('Video', '平台静音按钮未静音，点击静音');
            muteIcon.click();
          }
        }

        // 同时设置原生 video 属性
        if (this.ui.isMuted()) {
          document.querySelectorAll('video').forEach(v => { v.muted = true; v.volume = 0; });
        }

        if (fastTicks >= MAX_FAST) {
          clearInterval(this.muteGuardInterval);
          this.muteGuardInterval = setInterval(() => {
            if (!this.isHandling) return;
            const mi = document.querySelector('.xt_video_player_volume .xt_video_player_common_icon');
            if (mi && !mi.classList.contains('xt_video_player_common_icon_muted') && this.ui.isMuted()) {
              mi.click();
            }
            if (this.ui.isMuted()) {
              document.querySelectorAll('video').forEach(v => { v.muted = true; v.volume = 0; });
            }
          }, 3000);
          logger.debug('Video', '静音守护转入低频模式(3s)');
        }
      }, 500);
    }

    observeVideoChanges() {
      this.observer = new MutationObserver(() => {
        if (!this.isHandling) return;
        this.scanAndHandle();
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
    }

    scanAndHandle() {
      if (!this.isHandling) return;

      let video = document.querySelector('video');
      if (!video) {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (iframeDoc) {
              video = iframeDoc.querySelector('video');
              if (video) break;
            }
          } catch (e) { /* cross-origin */ }
        }
      }

      if (video && video !== this.currentVideo) {
        this.currentVideo = video;
        this._playAttempts = 0;
        this._progressStuckCount = 0;
        this._lastProgress = '';
        this.setupVideo(video);
      }

      if (this.currentVideo) {
        this.ensurePlaying();
        this._checkProgressStuck();
      }
    }

    setupVideo(video) {
      logger.info('Video', '发现视频元素', video.src || '(无src)');
      this.lastVideoSrc = video.src || '';
      this.videoStartTime = Date.now();

      const speed = this.ui.getSpeed();
      const muted = this.ui.isMuted();

      this._muteViaPlatform();
      video.muted = muted;
      video.volume = muted ? 0 : 1;
      video.playbackRate = speed;

      if (!video._ykhEventsBound) {
        video._ykhEventsBound = true;
        video.addEventListener('ended', () => this._onVideoEnded());
        video.addEventListener('pause', () => this._onVideoPause());
        video.addEventListener('play', () => {
          this.videoStartTime = Date.now();
          this._playAttempts = 0;
        });
        video.addEventListener('seeked', () => {
          if (this.isHandling) {
            video.muted = this.ui.isMuted();
            video.playbackRate = this.ui.getSpeed();
          }
        });
      }

      this._smartPlay(video);

      const progressText = this._getProgressText();
      this.ui.log(`🎬 视频 | 倍速${speed}x | 静音${muted ? '✅' : '❌'} | 进度${progressText || '未知'}`);
    }

    // 平台专用静音按钮
    _muteViaPlatform() {
      if (!this.ui.isMuted()) return;
      const muteIcon = document.querySelector('.xt_video_player_volume .xt_video_player_common_icon');
      if (muteIcon && !muteIcon.classList.contains('xt_video_player_common_icon_muted')) {
        muteIcon.click();
      }
    }

    // 智能播放：先点击平台播放按钮，再调用 video.play()
    _smartPlay(video) {
      if (!video) return;
      // 防抖：避免与平台的暂停检测反复抢播放导致快速抖动
      const now = Date.now();
      if (now - this._lastPlayAttemptAt < 800) return;
      this._lastPlayAttemptAt = now;

      const playBtnSelectors = [
        '.xt_video_player_play_btn',
        '.xt_video_player_play',
        '.vjs-big-play-button',
        '[class*="play-btn"]',
        '[class*="play_btn"]',
        '[class*="playButton"]',
        '.xgplayer-start',
        '[class*="video-play"]',
      ];
      for (const sel of playBtnSelectors) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          DOM.safeClick(btn);
          break;
        }
      }

      video.muted = this.ui.isMuted();
      video.playbackRate = this.ui.getSpeed();

      if (video.paused) {
        const playPromise = video.play();
        if (playPromise) {
          playPromise.catch((err) => {
            logger.warn('Video', '播放失败:', err.message);
            setTimeout(() => {
              if (this.isHandling && video.paused && !video.ended) {
                video.muted = true;
                video.playbackRate = this.ui.getSpeed();
                video.play().catch(() => {});
              }
            }, 1000);
          });
        }
      }
    }

    ensurePlaying() {
      if (!this.currentVideo) return;
      const video = this.currentVideo;
      const speed = this.ui.getSpeed();
      const muted = this.ui.isMuted();

      if (video.muted !== muted) {
        video.muted = muted;
        if (muted) this._muteViaPlatform();
      }
      if (video.playbackRate !== speed) video.playbackRate = speed;

      // 页面在后台时不去抢播放（平台切屏检测会反复暂停，容易形成快速暂停抖动）
      if (video.paused && !video.ended && this.isHandling && !document.hidden) {
        this._playAttempts++;
        if (this._playAttempts % 8 === 0) {
          this._smartPlay(video);
        } else {
          this._tryPlay();
        }
      }
    }

    /** 节流后的 play()：1.5 秒内最多尝试一次，避免暂停/播放抖动 */
    _tryPlay(force = false) {
      const video = this.currentVideo;
      if (!video || video.ended) return;
      const now = Date.now();
      if (!force && now - this._lastPlayAttemptAt < 1500) return;
      this._lastPlayAttemptAt = now;
      video.muted = this.ui.isMuted();
      video.playbackRate = this.ui.getSpeed();
      video.play().catch(() => {});
    }

    // 平台进度文本: .progress-wrap .text
    _getProgressText() {
      const progressEl = document.querySelector('.progress-wrap .text');
      if (progressEl) return progressEl.textContent.trim();

      const altSelectors = [
        '.xt_video_progress_text',
        '[class*="progress"] [class*="text"]',
        '[class*="current-time"]',
        '.xgplayer-progress-tip',
        '[class*="video-time"]',
      ];
      for (const sel of altSelectors) {
        const el = document.querySelector(sel);
        if (el) return el.textContent.trim();
      }
      return '';
    }

    // 综合判断视频是否完成（多信号）
    isVideoFinished() {
      // 信号1: 原生 video.ended
      if (this.currentVideo && this.currentVideo.ended) return true;

      // 信号2: 进度文本显示100%
      const progressText = this._getProgressText();
      if (progressText && progressText.includes('100%')) return true;

      // 信号3: 页面出现 .finish 完成标记
      if (document.querySelector('.finish')) return true;

      // 信号4: 播放到接近结尾（剩余<0.5秒）
      if (this.currentVideo && this.currentVideo.duration > 0) {
        if (this.currentVideo.duration - this.currentVideo.currentTime < 0.5) return true;
      }

      // 信号5: 超时保护
      if (this.videoStartTime > 0 && (Date.now() - this.videoStartTime) > this.maxVideoWaitMs) {
        logger.warn('Video', '视频超时，视为完成');
        return true;
      }

      return false;
    }

    // 检测进度是否卡住
    _checkProgressStuck() {
      const progressText = this._getProgressText();
      if (progressText && progressText === this._lastProgress) {
        this._progressStuckCount++;
        if (this._progressStuckCount >= 10 && this.currentVideo && this.currentVideo.paused) {
          logger.warn('Video', '进度卡住，强制重新播放');
          this._smartPlay(this.currentVideo);
          this._progressStuckCount = 0;
        }
      } else {
        this._lastProgress = progressText;
        this._progressStuckCount = 0;
      }
    }

    _onVideoEnded() {
      logger.info('Video', '视频播放完毕');
      this.ui.log('✅ 当前视频播放完成');
      this.currentVideo = null;
      if (this._onVideoEndedCallback) {
        this._onVideoEndedCallback();
      }
    }

    _onVideoPause() {
      if (!this.isHandling || !this.currentVideo) return;
      const video = this.currentVideo;
      if (this.isVideoFinished()) {
        if (!video.ended) {
          logger.info('Video', '通过进度判断为完成');
          this._onVideoEnded();
        }
        return;
      }
      if (!video.paused || video.ended) return;
      // 切到后台/最小化时平台常会主动暂停，此时不在后台反复抢播放（会引发连续快速暂停）
      if (document.hidden) {
        logger.debug('Video', '页面不可见，暂停自动恢复，待可见后继续');
        return;
      }
      clearTimeout(this._pauseRetryTimer);
      this._pauseRetryTimer = setTimeout(() => {
        if (this.isHandling && video.paused && !video.ended && !document.hidden) {
          this._tryPlay();
        }
      }, 1200);
    }

    hasActiveVideo() {
      if (this.isVideoFinished()) {
        if (this.currentVideo && !this.currentVideo.ended) {
          this._onVideoEnded();
        }
        return false;
      }

      // 元数据未加载（duration=0/NaN）时也视为活跃，避免主循环误判"无内容"提前跳走
      if (this.currentVideo && !this.currentVideo.ended && !(this.currentVideo.duration > 0)) {
        return true;
      }

      if (this.currentVideo && !this.currentVideo.ended &&
          this.currentVideo.duration > 0 &&
          this.currentVideo.currentTime < this.currentVideo.duration - 0.5) {
        return true;
      }

      const videos = document.querySelectorAll('video');
      for (const v of videos) {
        if (!v.ended && v.duration > 0 && v.currentTime < v.duration - 0.5) {
          if (v !== this.currentVideo) {
            this.currentVideo = v;
            this.setupVideo(v);
          }
          return true;
        }
      }

      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (doc) {
            const iframeVideos = doc.querySelectorAll('video');
            for (const v of iframeVideos) {
              if (!v.ended && v.duration > 0 && v.currentTime < v.duration - 0.5) {
                if (v !== this.currentVideo) {
                  this.currentVideo = v;
                  this.setupVideo(v);
                }
                return true;
              }
            }
          }
        } catch (e) { /* cross-origin */ }
      }

      return false;
    }

    updateSpeed(speed) {
      if (this.currentVideo) this.currentVideo.playbackRate = speed;
      document.querySelectorAll('video').forEach(v => { v.playbackRate = speed; });
      try {
        document.querySelectorAll('iframe').forEach(iframe => {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (doc) doc.querySelectorAll('video').forEach(v => { v.playbackRate = speed; });
          } catch (e) {}
        });
      } catch (e) {}
    }

    updateMuted(muted) {
      if (muted) this._muteViaPlatform();
      if (this.currentVideo) {
        this.currentVideo.muted = muted;
        this.currentVideo.volume = muted ? 0 : 1;
      }
      document.querySelectorAll('video').forEach(v => { v.muted = muted; v.volume = muted ? 0 : 1; });
      try {
        document.querySelectorAll('iframe').forEach(iframe => {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (doc) doc.querySelectorAll('video').forEach(v => { v.muted = muted; v.volume = muted ? 0 : 1; });
          } catch (e) {}
        });
      } catch (e) {}
    }

    getProgressInfo() {
      const progressText = this._getProgressText();
      const video = this.currentVideo;
      let currentTime = 0, duration = 0;
      if (video && video.duration > 0) {
        currentTime = video.currentTime;
        duration = video.duration;
      }
      return {
        progressText,
        currentTime,
        duration,
        isPaused: video ? video.paused : true,
        isFinished: this.isVideoFinished(),
      };
    }
  }

  // ============================================================
  //  QUIZ HANDLER
  // ============================================================
  // ============================================================
  //  QUESTION TYPES
  // ============================================================
  const QTYPE = {
    SINGLE: 'single',
    MULTI:  'multi',
    JUDGE:  'judge',
    FILL:   'fill',
    ESSAY:  'essay',
    UNKNOWN:'unknown',
  };

  /** 判断题文本极性: 1=正确/对, 0=错误/错, -1=无法判断 */
  function judgePolarity(text) {
    const t = String(text || '').trim().replace(/^[A-Ha-h][.、．)\s]+/, '');
    if (!t || t.length > 30) return -1;
    if (/错误|不正确|不对|错|否|×|✗|false|wrong|^no$|^n$|^f$/i.test(t)) return 0;
    if (/正确|对|是|√|✓|true|right|^yes$|^y$|^t$/i.test(t)) return 1;
    return -1;
  }

  // ============================================================
  //  QUIZ HANDLER (accuracy-first, no blind submission)
  // ============================================================
  class QuizHandler {
    constructor(ui, aiAnswerer) {
      this.ui = ui;
      this.ai = aiAnswerer;        // AI 答题器引用
      this.isHandling = false;
      this.observer = null;
      this.answeredInPage = new Set();
      this.quizCache = Storage.getAnswerCache();
      this._scanTimeout = null;
      this._completedContainers = new WeakSet(); // 已全部作答的容器，不再重复处理
      this._manualPoll = null;                    // 等待手动作答时的轮询定时器
      this._pageDone = false;                     // 当前页试卷是否已全部作答

      // 当前页面的题目处理状态
      this.pageQuestions = [];        // { el, stem, stemKey, qtype, answered, answer }
      this.awaitingManual = false;   // 是否在等待用户手动答题
      this.pageContainer = null;     // 当前试题容器引用
      this._handlingQuiz = false;    // 防止并发处理
    }

    start() {
      this.isHandling = true;
      this.answeredInPage = new Set();
      this.pageQuestions = [];
      this.awaitingManual = false;
      this._pageDone = false;
      this.ui.setAnsweredQuestions([]);
      this.observeQuizChanges();
      this.scanQuizzes();
    }

    stop() {
      this.isHandling = false;
      this.awaitingManual = false;
      this._stopManualPoll();
      this._clearHighlights();
      this.ui.setMissingQuestions([]);
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
    }

    observeQuizChanges() {
      if (this.observer) this.observer.disconnect();
      this.observer = new MutationObserver(() => {
        if (!this.isHandling) return;
        clearTimeout(this._scanTimeout);
        this._scanTimeout = setTimeout(() => this.scanQuizzes(), 800);
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
    }

    // ========== 题目扫描 ==========
    scanQuizzes() {
      if (!this.isHandling || this.awaitingManual) return false;

      // 当前试卷已全部作答：容器还在就不要再扫描（避免重复处理/重复弹窗）；
      // 容器已被替换（换页或交卷）则重置状态，以便识别新的试卷
      if (this._pageDone) {
        if (this.pageContainer && document.contains(this.pageContainer)) return false;
        this._pageDone = false;
        this.pageQuestions = [];
        this.pageContainer = null;
      }

      const quizSelectors = [
        '[class*="exam"]', '[class*="quiz"]', '[class*="question"]',
        '[class*="problem"]', '[class*="test-paper"]', '[class*="exercise"]',
        '[class*="topic-wrapper"]', '[class*="subject-wrapper"]',
        '[class*="exam-answer"]', '[class*="paper-container"]',
        '[class*="question-list"]', '[class*="questionList"]',
        '.que_row', '.que_wrap', '.que-wrap', '[class*="answer_sheet"]'
      ];

      let foundQuiz = false;
      for (const sel of quizSelectors) {
        const containers = document.querySelectorAll(sel);
        for (const container of containers) {
          if (this._completedContainers.has(container)) continue;
          if (this._isResultPage(container)) continue;
          if (this.hasQuestions(container)) {
            foundQuiz = true;
            this.handleQuizContainer(container);
            return foundQuiz; // 只处理第一个找到的容器
          }
        }
      }

      // 弹窗试题
      const modalSelectors = ['[class*="modal"]', '[class*="dialog"]', '[class*="popup"]', '[class*="overlay"]', '[class*="toast"]'];
      for (const sel of modalSelectors) {
        const modals = document.querySelectorAll(sel);
        for (const modal of modals) {
          if (modal.offsetParent !== null && !this._completedContainers.has(modal) && !this._isResultPage(modal) && this.hasQuestions(modal)) {
            foundQuiz = true;
            this.handleQuizContainer(modal);
            return foundQuiz;
          }
        }
      }
      return foundQuiz;
    }

    /** 判断是否是已交卷/成绩回顾页面（交卷后不要再动它） */
    _isResultPage(container) {
      const text = DOM.getText(container).substring(0, 3000);
      if (/已提交|提交成功|交卷成功|参考答案|答案解析|本次得分|我的成绩/.test(text)) return true;
      const inputs = container.querySelectorAll('input[type="radio"], input[type="checkbox"], textarea, input[type="text"]');
      if (inputs.length > 0) {
        const locked = Array.from(inputs).filter(i => i.disabled || i.readOnly).length;
        // 仅当全部输入不可用且没有可点击选项（label/自定义单选）时才认定为回顾页
        if (locked === inputs.length && !container.querySelector('label, [class*="option"], [class*="choice"], [role="radio"], [role="checkbox"]')) {
          return true;
        }
      }
      return false;
    }

    hasQuestions(container) {
      const indicators = [
        'input[type="radio"]', 'input[type="checkbox"]',
        'textarea', 'input[type="text"]:not([class*="search"])',
        '[contenteditable="true"]', '.w-e-text', '.ql-editor',
        '[class*="option"]', '[class*="choice"]', '[class*="question-item"]',
        '.que_row', '[class*="topic"]'
      ];
      for (const sel of indicators) {
        if (container.querySelector(sel)) return true;
      }
      // 同域 iframe 内的编辑器（部分平台的简答题用 iframe）
      for (const f of container.querySelectorAll('iframe')) {
        try {
          const doc = f.contentDocument || f.contentWindow?.document;
          if (doc && doc.querySelector('textarea, [contenteditable="true"]')) return true;
        } catch (e) { /* cross-origin */ }
      }
      return false;
    }

    // ========== 整页试题处理（核心流程） ==========
    async handleQuizContainer(container) {
      // 防止并发处理
      if (this._handlingQuiz) return;

      // 已全部作答的容器不再重复处理
      if (this._completedContainers.has(container)) return;

      this._handlingQuiz = true;

      try {
      const containerIsNew = this.pageContainer !== container;
      this.pageContainer = container;

      // 找到所有题目
      const items = this.findQuestionItems(container);
      if (items.length === 0) return;

      // 逐个识别题型，允许重新处理已有题目
      const existingMap = new Map(); // stemKey → question object
      for (const q of this.pageQuestions) {
        existingMap.set(q.stemKey, q);
      }

      let newCount = 0;
      let updateCount = 0;
      for (const item of items) {
        const stem = this.getQuestionStem(item);
        const stemKey = DOM.normalizeText(stem).substring(0, 150);
        if (!stemKey) continue;

        // 检查是否已存在
        if (existingMap.has(stemKey)) {
          const existing = existingMap.get(stemKey);
          const hasSelection = this._hasActiveSelection(item);
          if (existing.answered && existing.answerSource === 'ai' && !hasSelection) {
            // AI答过但DOM无选择 → 可能是页面刷新，重新标记为未答
            existing.answered = false;
            existing.answer = null;
            existing.answerSource = null;
            existing.el = item;
            updateCount++;
          } else if (!existing.answered && !hasSelection) {
            // 还没答过，更新DOM引用
            existing.el = item;
            updateCount++;
          } else if (!existing.answered && hasSelection) {
            // DOM有选择但未记录 → 读取并记录
            const userAns = this.readUserSelection({ el: item, stem: existing.stem, stemKey: existing.stemKey, qtype: existing.qtype });
            if (userAns !== null) {
              existing.answer = userAns;
              existing.answered = true;
              existing.answerSource = 'manual';
              existing.el = item;
              Storage.addAnswer(existing.stemKey, userAns);
              this.quizCache = Storage.getAnswerCache();
              updateCount++;
            }
          }
          // 如果已有选择且answered，保持不变
          continue;
        }

        const qtype = this.detectQuestionType(item);
        this.pageQuestions.push({ el: item, stem, stemKey, qtype, answered: false, answer: null, answerSource: null });
        existingMap.set(stemKey, this.pageQuestions[this.pageQuestions.length - 1]);
        newCount++;
      }

      if (newCount === 0 && updateCount === 0) return;

      if (newCount > 0 || updateCount > 0) {
        // 统计题型
        const typeCount = {};
        for (const q of this.pageQuestions) {
          typeCount[q.qtype] = (typeCount[q.qtype] || 0) + 1;
        }
        const parts = [];
        if (typeCount.single) parts.push(`${typeCount.single}道单选`);
        if (typeCount.multi)  parts.push(`${typeCount.multi}道多选`);
        if (typeCount.judge)  parts.push(`${typeCount.judge}道判断`);
        if (typeCount.fill)   parts.push(`${typeCount.fill}道填空`);
        if (typeCount.essay)  parts.push(`${typeCount.essay}道解答`);

        if (newCount > 0) {
          this.ui.log(`📋 检测到 ${this.pageQuestions.length} 道试题 (${parts.join('、')})`);
          // 输出前5道题的 DOM 诊断信息到面板
          this._dumpPageDiagnostics(items);
        }
      }

      // ========== 作答：本地缓存 → AI逐题并发 → 单题兜底 ==========
      const unanswered = this.pageQuestions.filter(q => !q.answered);
      if (unanswered.length > 0) {
        this.ui.log(`📋 开始作答: ${unanswered.length} 道 (${this.pageQuestions.length}题中)`);
      }

      let cacheHits = 0;
      let aiHits = 0;
      let fails = 0;

      // 1) 本地快速作答（缓存 / 全局状态 / DOM 显式答案）
      const needAI = [];
      for (let qi = 0; qi < this.pageQuestions.length; qi++) {
        if (!this.isHandling) return;
        const q = this.pageQuestions[qi];
        if (q.answered) continue;
        if (q.qtype === QTYPE.ESSAY) { needAI.push(qi); continue; }
        const localAnswer = await this.tryAutoAnswer(q);
        if (localAnswer) this._followQuestion(q.el);
        if (localAnswer && await this.applyAnswer(q.el, localAnswer, q.qtype)) {
          q.answer = localAnswer;
          q.answered = true;
          q.answerSource = 'local';
          cacheHits++;
        } else {
          needAI.push(qi);
        }
      }

      // 2) AI 逐题作答：每题一个独立请求，有限并发，完成一题立即应用一题
      const aiTargets = needAI.filter(qi => this.pageQuestions[qi].qtype !== QTYPE.ESSAY);
      if (aiTargets.length > 0 && this.ai && this.ai.enabled) {
        const total = aiTargets.length;
        const concurrency = Math.min(CONFIG.ai.concurrency || 6, total);
        this.ui.log(`🤖 AI逐题作答 ${total} 道（${concurrency} 路并发）...`);
        this.ui.setStatus(`🤖 AI作答中 0/${total}`, 'info');

        const queue = aiTargets.slice();
        let done = 0;
        const worker = async () => {
          while (queue.length > 0) {
            if (!this.isHandling) return;
            const qi = queue.shift();
            const q = this.pageQuestions[qi];
            if (!q || q.answered) {
              done++;
              this.ui.setStatus(`🤖 AI作答中 ${done}/${total}（已答${aiHits}）`, 'info');
              continue;
            }
            const typeLabel = { single: '单选', multi: '多选', judge: '判断', fill: '填空' }[q.qtype] || q.qtype;
            const answer = await this._requestAIAnswer(q);
            if (answer) this._followQuestion(q.el);
            if (answer && await this.applyAnswer(q.el, answer, q.qtype)) {
              q.answer = answer;
              q.answered = true;
              q.answerSource = 'ai';
              aiHits++;
              Storage.addAnswer(q.stemKey, answer);
              this.quizCache = Storage.getAnswerCache();
              logger.info('Quiz', `第${qi + 1}题(${typeLabel}) AI作答成功`);
            } else if (answer) {
              logger.warn('Quiz', `第${qi + 1}题(${typeLabel}) AI有答案但应用失败`);
            }
            done++;
            this.ui.setStatus(`🤖 AI作答中 ${done}/${total}（已答${aiHits}）`, 'info');
          }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));
        this.ui.log(`✅ AI逐题完成: 已作答 ${aiHits} 道，${total - aiHits} 道待兜底`);
      }

      // 3) 单题兜底：逐题请求仍无答案的题目（含主观题）
      for (let qi = 0; qi < this.pageQuestions.length; qi++) {
        if (!this.isHandling) return;
        const q = this.pageQuestions[qi];
        if (q.answered) continue;

        const qLabel = `[${qi + 1}/${this.pageQuestions.length}]`;
        const typeLabel = { single: '单选', multi: '多选', judge: '判断', fill: '填空', essay: '主观' }[q.qtype] || q.qtype;
        if (!this.ai || !this.ai.enabled) { fails++; continue; }

        const answer = await this._requestAIAnswer(q);

        if (answer) this._followQuestion(q.el);
        if (answer && await this.applyAnswer(q.el, answer, q.qtype)) {
          q.answer = answer;
          q.answered = true;
          q.answerSource = 'ai';
          aiHits++;
          Storage.addAnswer(q.stemKey, answer);
          this.quizCache = Storage.getAnswerCache();
          this.ui.setStatus(`${qLabel} ${typeLabel} ✅`, 'info');
        } else if (answer) {
          fails++;
          logger.warn('Quiz', `${qLabel} 答案应用失败: ${JSON.stringify(answer).substring(0, 100)}`);
          this.ui.log(`${qLabel} ${typeLabel} ❌ AI有答案但页面应用失败`);
          if (q.qtype === QTYPE.JUDGE) {
            logger.warn('Quiz', `${qLabel} 判断题应用失败，选项:`, this._getAllOptionTexts(q.el));
          }
          this.ui.setStatus(`${qLabel} ${typeLabel} ❌ 应用失败`, 'warning');
          // 多选特殊处理：再试一次，用文本匹配兜底
          if (q.qtype === QTYPE.MULTI && answer.indices) {
            logger.info('Quiz', `${qLabel} 多选重试文本匹配...`);
            this._followQuestion(q.el);
            const opts = this._getAllOptionTexts(q.el);
            let retryOk = false;
            for (const idx of answer.indices) {
              if (idx < opts.length) {
                this._clickByText(q.el, opts[idx]);
                await DOM.sleep(300);
              }
            }
            // 验证所有选项确实已点亮（旧逻辑只数选项个数，等于没验证）
            const retryEls = this._getOptionElements(q.el);
            if (retryEls.length >= 2) {
              retryOk = answer.indices.every(i => i < retryEls.length && this._isOptionSelected(retryEls[i]));
            } else {
              retryOk = opts.length >= answer.indices.length;
            }
            if (retryOk) {
              q.answer = answer;
              q.answered = true;
              q.answerSource = 'ai';
              aiHits++;
              fails--;
              Storage.addAnswer(q.stemKey, answer);
              this.quizCache = Storage.getAnswerCache();
              this._followQuestion(q.el);
              this.ui.setStatus(`${qLabel} ${typeLabel} ✅(重试)`, 'info');
            }
          }
        } else {
          fails++;
          this.ui.setStatus(`${qLabel} ${typeLabel} ❓ 无法作答`, 'warning');
          this.ui.log(`${qLabel} ${typeLabel} ❓ AI未返回可用的答案（超时/接口报错/回答unknown）`);
        }

        await DOM.sleep(100); // 题间短暂停顿
      }

      if (cacheHits > 0 || aiHits > 0) {
        const parts = [];
        if (cacheHits > 0) parts.push(`缓存${cacheHits}道`);
        if (aiHits > 0) parts.push(`AI ${aiHits}道`);
        this.ui.log(`✅ 作答完成: ${parts.join(' + ')}${fails > 0 ? `, ${fails}道失败` : ''}`);
      }

      // ---------- 未完成处理：高亮 + 面板列表 + 自动检测手动作答 ----------
      this._updateAnsweredUI();
      let remaining = this.pageQuestions.filter(q => !q.answered);
      if (remaining.length === 0) {
        this._onAllAnswered(container);
        return;
      }

      this.ui.log(`⚠️ 仍有 ${remaining.length} 道需要处理`, 'warn');
      this.ui.setStatus(`⚠️ ${remaining.length} 道题待作答`, 'warning');
      this._highlightQuestions(remaining);
      this._updateMissingUI(remaining);
      this._notifyManualNeeded(remaining);
      this.awaitingManual = true;
      this._onManualDone = () => this._releaseManualWait(true);
      this._startManualPoll();
      } finally {
        this._handlingQuiz = false;
      }
    }

    /** 用户点击"继续运行"时调用 */
    onManualContinue() {
      this._releaseManualWait(true);
    }

    isWaitingForManual() {
      return this.awaitingManual;
    }

    /** 全部作答完成：只提示手动提交，绝不自动提交 */
    _onAllAnswered(container) {
      this._stopManualPoll();
      this._pageDone = true;
      if (container) this._completedContainers.add(container);
      this.pageQuestions.forEach(q => this.answeredInPage.add(q.stemKey));
      this._clearHighlights();
      this.ui.setMissingQuestions([]);
      this._updateAnsweredUI();
      this.ui.log(`✅ 全部 ${this.pageQuestions.length} 道作答完成，请手动提交试卷（脚本不会自动提交）`);
      this.ui.setStatus('✅ 已全部作答，请手动提交试卷', 'info');
      // 保持等待状态：用户交卷前不自动跳转
      this.awaitingManual = true;
      this._onManualDone = () => this._releaseManualWait(true);
      // 仅用于监测页面是否已切换（手动交卷后自动解除等待）
      this._startManualPoll();
    }

    /** 解除手动等待，让主循环继续 */
    _releaseManualWait(log) {
      this.awaitingManual = false;
      this._onManualDone = null;
      this._stopManualPoll();
      this._clearHighlights();
      this.ui.setMissingQuestions([]);
      if (log) this.ui.log('▶️ 已解除等待，继续运行');
    }

    /** 轮询检测用户手动填写/选择的答案，自动更新未完成列表 */
    _startManualPoll() {
      this._stopManualPoll();
      this._manualPoll = setInterval(() => {
        if (!this.isHandling || !this.awaitingManual) return;
        // 页面已切换（可能已手动交卷），解除等待
        if (!this.pageContainer || !document.contains(this.pageContainer)) {
          this._releaseManualWait(true);
          return;
        }
        let changed = 0;
        for (const q of this.pageQuestions) {
          if (q.answered) continue;
          if (!document.contains(q.el)) continue;
          const userAns = this.readUserSelection(q);
          if (userAns !== null) {
            q.answer = userAns;
            q.answered = true;
            q.answerSource = 'manual';
            Storage.addAnswer(q.stemKey, userAns);
            this.quizCache = Storage.getAnswerCache();
            changed++;
          }
        }
        if (changed > 0) {
          this.ui.log(`📝 已检测到 ${changed} 道手动作答`);
          const stillMissing = this.pageQuestions.filter(q => !q.answered);
          this._highlightQuestions(stillMissing);
          this._updateMissingUI(stillMissing);
          this._updateAnsweredUI();
          if (stillMissing.length === 0) {
            this._onAllAnswered(this.pageContainer);
          }
        }
      }, 1500);
    }

    _stopManualPoll() {
      if (this._manualPoll) {
        clearInterval(this._manualPoll);
        this._manualPoll = null;
      }
    }

    /** 刷新面板中的未完成题目列表 */
    _updateMissingUI(remaining) {
      const typeLabel = { single: '单选', multi: '多选', judge: '判断', fill: '填空', essay: '简答' };
      const items = (remaining || []).map(q => {
        const idx = this.pageQuestions.indexOf(q) + 1;
        const type = typeLabel[q.qtype] || '题目';
        const stem = (q.stem || '').substring(0, 24);
        return { text: `第${idx}题 · ${type} · ${stem}`, el: q.el };
      });
      this.ui.setMissingQuestions(items);
    }

    /** 刷新面板中的已作答题目列表（可单题重答） */
    _updateAnsweredUI() {
      const typeLabel = { single: '单选', multi: '多选', judge: '判断', fill: '填空', essay: '简答' };
      const items = this.pageQuestions
        .filter(q => q.answered && document.contains(q.el))
        .map(q => {
          const idx = this.pageQuestions.indexOf(q) + 1;
          const type = typeLabel[q.qtype] || '题目';
          const stem = (q.stem || '').substring(0, 20);
          return { text: `第${idx}题 · ${type} · ${stem}`, el: () => q.el, stemKey: q.stemKey };
        });
      this.ui.setAnsweredQuestions(items);
    }

    /** 收集页面上的题目元素（已跟踪的题目 + 页面上其他题目） */
    _collectQuestionItemsOnPage() {
      const out = [];
      const overlaps = (el) => out.some(x => x === el || x.contains(el) || el.contains(x));
      const push = (el) => {
        if (!el || !document.contains(el) || overlaps(el)) return;
        out.push(el);
      };
      for (const q of this.pageQuestions) push(q.el);
      for (const sel of ['[class*="exercise-item"]', '[class*="question-item"]', '[class*="exam-question"]', '[class*="test-question"]', '.que_row', '[class*="problem-item"]']) {
        for (const el of document.querySelectorAll(sel)) {
          if (this._isResultPage(el)) continue;
          if (this._isRealQuestion(el)) push(el);
        }
      }
      if (out.length === 0) {
        for (const sel of ['[class*="exam"]', '[class*="quiz"]', '[class*="test-paper"]', '[class*="paper-container"]', '[class*="question-list"]']) {
          for (const c of document.querySelectorAll(sel)) {
            if (this._isResultPage(c) || !this.hasQuestions(c)) continue;
            for (const el of this.findQuestionItems(c)) push(el);
          }
        }
      }
      return out;
    }

    /** 扫描页面上已作答的客观题（单选/判断/多选/填空） */
    scanAnsweredQuestions() {
      const answered = [];
      for (const el of this._collectQuestionItemsOnPage()) {
        const qtype = this.detectQuestionType(el);
        if (qtype !== QTYPE.SINGLE && qtype !== QTYPE.MULTI && qtype !== QTYPE.JUDGE && qtype !== QTYPE.FILL) continue;
        if (this._hasAnswerOnPage(el, qtype)) answered.push({ el, qtype });
      }
      return answered;
    }

    /** 题目当前是否已有作答内容 */
    _hasAnswerOnPage(questionEl, qtype) {
      if (qtype === QTYPE.FILL) {
        return this._getFillInputs(questionEl).some(inp => (inp.value || '').trim() !== '');
      }
      if (questionEl.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked')) return true;
      if (questionEl.querySelector('.el-radio.is-checked, .el-checkbox.is-checked, .el-radio__input.is-checked, .el-checkbox__input.is-checked')) return true;
      if (questionEl.querySelector('[role="radio"][aria-checked="true"], [role="checkbox"][aria-checked="true"]')) return true;
      return !!questionEl.querySelector('[class*="is-selected"], [class*="option-checked"], [class*="option-selected"]');
    }

    /** 清除选择题/判断题的界面选择状态（含 Element UI 的 v-model） */
    _clearChoiceAnswers(questionEl) {
      const isElUiChoice = (inp) => !!inp.closest('label.el-radio, label.el-checkbox');
      questionEl.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked').forEach(inp => {
        inp.checked = false;
        if (!isElUiChoice(inp)) inp.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // Element UI：原生 radio 无法取消选中，必须清组件自身的 v-model
      const elChoices = questionEl.querySelectorAll('label.el-radio, label.el-checkbox');
      if (elChoices.length > 0) {
        const groups = new Set();
        for (const label of elChoices) {
          const vm = label.__vue__;
          if (!vm) continue;
          const isCb = label.classList.contains('el-checkbox');
          // ElRadio/ElCheckbox 计算 isGroup 时会写入 _radioGroup/_checkboxGroup
          try { void vm.isGroup; } catch (e) { /* ignore */ }
          let group = vm._radioGroup || vm._checkboxGroup || null;
          if (!group) {
            for (let p = vm.$parent, depth = 0; p && depth < 8; p = p.$parent, depth++) {
              const name = String((p.$options && (p.$options.name || p.$options.componentName)) || '');
              if (/radio-?group|checkbox-?group/i.test(name)) { group = p; break; }
            }
          }
          if (group) {
            if (groups.has(group)) continue;
            groups.add(group);
            const name = String((group.$options && (group.$options.name || group.$options.componentName)) || '');
            const isCheckboxGroup = /checkbox/i.test(name);
            try { group.$emit('input', isCheckboxGroup ? [] : undefined); } catch (e) { /* ignore */ }
            try { group.$emit('change', isCheckboxGroup ? [] : undefined); } catch (e) { /* ignore */ }
            continue;
          }
          // 独立 radio/checkbox（没有 group 组件）：清组件自身的 v-model 数据，
          // 只删 is-checked 样式的话 Vue 数据还在，答题卡仍显示已作答、重跑会跳过该题
          try { vm.$emit('input', isCb ? false : undefined); } catch (e) { /* ignore */ }
          try { vm.$emit('change', isCb ? false : undefined); } catch (e) { /* ignore */ }
        }
      }
      // 兜底：清掉视觉选中态（组件实例拿不到时至少界面显示已清空）
      questionEl.querySelectorAll('.el-radio.is-checked, .el-checkbox.is-checked').forEach(el => {
        el.classList.remove('is-checked');
        if (el.hasAttribute('aria-checked')) el.setAttribute('aria-checked', 'false');
      });
      questionEl.querySelectorAll('.el-radio__input.is-checked, .el-checkbox__input.is-checked').forEach(el => {
        el.classList.remove('is-checked');
      });
      // 其他自定义组件的选中态
      questionEl.querySelectorAll('[class*="is-selected"], [class*="option-checked"], [class*="option-selected"]').forEach(el => {
        try {
          el.click();
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } catch (e) { /* ignore */ }
      });
    }

    /** 扫描并清除页面上的已答内容（不改答案缓存、不重新作答） */
    async scanAndClearPageAnswers() {
      if (this._handlingQuiz) {
        this.ui.log('⚠️ 正在自动答题中，请等作答结束或先停止运行再清除', 'warn');
        return 0;
      }
      const answered = this.scanAnsweredQuestions();
      if (answered.length === 0) {
        this.ui.log('🔍 扫描完成：页面上没有已作答的单选题/判断题/多选题/填空题');
        return 0;
      }
      const typeLabel = { single: '单选', multi: '多选', judge: '判断', fill: '填空' };
      const counts = {};
      this.ui.log(`🔍 扫描到 ${answered.length} 道已作答题目：`);
      for (const { el, qtype } of answered) {
        counts[qtype] = (counts[qtype] || 0) + 1;
        const num = this._questionNumberLabel(el);
        const stem = (this.getQuestionStem(el) || '').replace(/\s+/g, ' ').substring(0, 20);
        this.ui.log(`   ${num}${typeLabel[qtype]} · ${stem}`);
      }
      this.ui.log(`🧹 开始清除：${Object.keys(counts).map(t => `${typeLabel[t]}${counts[t]}道`).join('、')}`);

      const clearAll = async (list) => {
        for (const { el, qtype } of list) {
          try {
            if (qtype === QTYPE.FILL) {
              await this._clearFillBlanks(el);
            } else {
              this._clearChoiceAnswers(el);
              await DOM.sleep(40);
            }
          } catch (e) { /* 单题失败不影响其他题 */ }
        }
      };

      await clearAll(answered);
      await DOM.sleep(350);
      let remaining = this.scanAnsweredQuestions();
      if (remaining.length > 0) {
        await clearAll(remaining);
        await DOM.sleep(350);
        remaining = this.scanAnsweredQuestions();
      }

      if (remaining.length > 0) {
        this.ui.log(`⚠️ 已清除 ${answered.length - remaining.length} 道，还有 ${remaining.length} 道没清干净，可以再点一次 🧹`, 'warn');
      } else {
        this.ui.log(`✅ 已清除 ${answered.length} 道题的界面答案（答案缓存未改动）`);
      }

      // 同步脚本内部状态：被清空的题视为未作答，并解除整页"已完成"标记，
      // 否则重新运行时会跳过整个试卷容器，填空题永远不会被重新填上
      const liveByStem = new Map();
      for (const el of this._collectQuestionItemsOnPage()) {
        const key = DOM.normalizeText(this.getQuestionStem(el)).substring(0, 150);
        if (key && !liveByStem.has(key)) liveByStem.set(key, el);
      }
      for (const q of this.pageQuestions) {
        const liveEl = liveByStem.get(q.stemKey);
        if (liveEl) q.el = liveEl;
        if (!this._hasAnswerOnPage(q.el, q.qtype)) {
          q.answered = false;
          q.answer = null;
          q.answerSource = null;
        }
      }
      this.answeredInPage = new Set(this.pageQuestions.filter(q => q.answered).map(q => q.stemKey));
      this._pageDone = false;
      if (this.pageContainer) this._completedContainers.delete(this.pageContainer);
      this._updateAnsweredUI();
      if (this.awaitingManual) {
        this._updateMissingUI(this.pageQuestions.filter(q => !q.answered));
        this.ui.log('▶ 重新开始运行或点"✅ 继续运行"即可让脚本重新作答');
      }

      return answered.length - remaining.length;
    }

    /** 单题重答：忽略缓存，重新请求 AI 并覆盖该题 */
    async reanswerQuestion(q) {
      if (!q) return false;
      if (this._handlingQuiz) {
        this.ui.log('⚠️ 正在自动答题中，请等作答结束再点 ↻', 'warn');
        return false;
      }
      if (!this.ai || !this.ai.enabled) {
        this.ui.log('⚠️ 未启用 AI（需要 API Key），无法重答', 'warn');
        return false;
      }
      this._handlingQuiz = true;
      try {
        // 页面重渲染后旧引用可能失效，按题干重新定位
        let liveEl = document.contains(q.el) ? q.el : null;
        if (!liveEl) {
          for (const el of this._collectQuestionItemsOnPage()) {
            if (DOM.normalizeText(this.getQuestionStem(el)).substring(0, 150) === q.stemKey) { liveEl = el; break; }
          }
        }
        if (!liveEl) {
          this.ui.log('⚠️ 页面上找不到这道题了，请重新扫描后再试', 'warn');
          return false;
        }
        q.el = liveEl;
        this.ui.log(`↻ 重新作答：${(q.stem || '').substring(0, 24)}`);
        this.ui.setStatus('↻ AI 重答中...', 'info');
        const answer = await this._requestAIAnswer(q);
        if (!answer) {
          this.ui.log('❌ AI 未返回可用答案，原答案保持不变', 'warn');
          this.ui.setStatus('❌ 重答失败', 'warning');
          return false;
        }
        // 多选先清掉旧选择，避免新答案与旧答案叠加
        if (q.qtype === QTYPE.MULTI) {
          this._clearChoiceAnswers(q.el);
          await DOM.sleep(120);
        }
        this._followQuestion(q.el);
        const ok = await this.applyAnswer(q.el, answer, q.qtype);
        if (!ok) {
          this.ui.log('❌ AI 有答案但应用到页面失败', 'warn');
          this.ui.setStatus('❌ 重答失败', 'warning');
          return false;
        }
        q.answer = answer;
        q.answered = true;
        q.answerSource = 'ai';
        this.answeredInPage.add(q.stemKey);
        Storage.addAnswer(q.stemKey, answer);
        this.quizCache = Storage.getAnswerCache();
        this.ui.log('✅ 重答完成，已覆盖并更新缓存');
        this.ui.setStatus('✅ 重答完成', 'info');
        this._updateMissingUI(this.pageQuestions.filter(x => !x.answered));
        this._updateAnsweredUI();
        return true;
      } catch (e) {
        this.ui.log(`❌ 重答出错: ${e.message || e}`, 'warn');
        return false;
      } finally {
        this._handlingQuiz = false;
      }
    }

    /**
     * 逐空清空：清一个空后考试页可能重渲染，旧引用会失效，
     * 所以每次都重新读取实时 DOM，并复查补清，直到所有空都为空。
     */
    async _clearFillBlanks(questionEl) {
      for (let round = 0; round < 3; round++) {
        let total = this._getFillInputs(questionEl).length;
        if (total === 0) return;
        for (let i = 0; i < total; i++) {
          const live = this._getFillInputs(questionEl);
          const inp = live[i];
          if (!inp || !(inp.value || '').trim()) continue;
          this._setTextValue(inp, '');
          await DOM.sleep(60);
        }
        await DOM.sleep(150);
        const left = this._getFillInputs(questionEl).filter(inp => (inp.value || '').trim());
        if (left.length === 0) return;
      }
    }

    /** 从题型标签里取题号，如 "23.填空题" → "第23题 " */
    _questionNumberLabel(questionEl) {
      const t = (questionEl.querySelector('.item-type')?.textContent || '').trim();
      const m = t.match(/(\d+)\s*[.．、]/);
      return m ? `第${m[1]}题 ` : '';
    }

    /** 收集当前页面全部题目与答案，供"提取试题"导出 Word 使用 */
    collectExamData() {
      const typeLabel = { single: '单选题', multi: '多选题', judge: '判断题', fill: '填空题', essay: '简答题' };
      const progMap = new Map();
      for (const q of this.pageQuestions) progMap.set(q.stemKey, q);
      const cache = Storage.getAnswerCache();
      const rows = [];
      const seen = new Set();

      for (const el of this._collectQuestionItemsOnPage()) {
        const stem = this.getQuestionStem(el);
        const stemKey = DOM.normalizeText(stem).substring(0, 150);
        if (!stemKey || seen.has(stemKey)) continue;
        seen.add(stemKey);
        const qtype = this.detectQuestionType(el);
        const typeText = (el.querySelector('.item-type')?.textContent || '').trim();
        const numMatch = typeText.match(/(\d+)\s*[.．、]/);
        const scoreMatch = typeText.match(/[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/);
        // 未识别题型也要导出，用试卷上的题型文字兜底
        const fallbackLabel = typeText
          .replace(/^\d+\s*[.．、]\s*/, '')
          .replace(/[（(]\s*\d+(?:\.\d+)?\s*分\s*[）)]/g, '')
          .trim();

        // 填空题/简答题没有选项；填空页面的“答案保存成功”等文字会被当成选项，必须丢弃
        const options = (qtype === QTYPE.FILL || qtype === QTYPE.ESSAY) ? [] : this._getAllOptionTexts(el);
        const prog = progMap.get(stemKey);
        // 答案优先级：页面实际作答 > 脚本记录 > 答案缓存 > 未作答
        let answer = this.readUserSelection({ el, qtype, stem, stemKey });
        if (!answer && prog && prog.answered && prog.answer) answer = prog.answer;
        // 缓存条目是 { answer, time } 包装，真正答案在 .answer 里
        if (!answer && cache[stemKey] && cache[stemKey].answer) answer = cache[stemKey].answer;
        let answerText = this._formatAnswerText(qtype, answer, options);
        let stemParts = null;
        let inlineFull = false;

        // 填空题：把答案直接填回原文的空位，导出时高亮；答案不再单独列一行
        if (qtype === QTYPE.FILL) {
          const fillInputs = this._getFillInputs(el);
          if (fillInputs.length > 0) {
            let ansTexts = [];
            if (answer) {
              if (Array.isArray(answer.texts)) ansTexts = answer.texts.map(v => String(v));
              else if (answer.text) ansTexts = this._splitFillParts(String(answer.text), fillInputs.length).map(v => String(v));
            }
            const values = fillInputs.map((inp, i) => (inp.value || '').trim() || (ansTexts[i] || '').trim());
            stemParts = this._buildFillStemParts(el, fillInputs, values);
            inlineFull = !!stemParts && values.every(v => v);
            if (inlineFull) answerText = '';
          }
        }

        rows.push({
          num: numMatch ? parseInt(numMatch[1], 10) : rows.length + 1,
          typeLabel: typeLabel[qtype] || fallbackLabel || '题目',
          score: scoreMatch ? scoreMatch[1] : '',
          stem,
          stemParts,
          inlineFull,
          options,
          answerText,
        });
      }
      rows.sort((a, b) => a.num - b.num);
      return { title: '雨课堂试题与答案', questions: rows };
    }

    /** 把答案对象格式化成可读文本（选择题带选项内容，多空填空按空分列） */
    _formatAnswerText(qtype, answer, options) {
      if (!answer) return '';
      const letter = (i) => String.fromCharCode(65 + i);
      const optLabel = (i) => {
        const t = options && options[i] ? String(options[i]).trim() : '';
        return `${letter(i)}${t ? '. ' + t : ''}`;
      };

      const idx = Array.isArray(answer.indices)
        ? answer.indices
        : (typeof answer.index === 'number' ? [answer.index] : null);
      if (idx && idx.length > 0) return idx.map(i => optLabel(i)).join('；');

      if (qtype === QTYPE.FILL) {
        if (Array.isArray(answer.texts) && answer.texts.length > 0) {
          return answer.texts.length > 1
            ? answer.texts.map((t, i) => `第${i + 1}空：${t}`).join('；')
            : String(answer.texts[0]);
        }
        if (answer.text) return String(answer.text);
        if (answer.value) return String(answer.value);
        return '';
      }
      if (qtype === QTYPE.ESSAY) {
        return String(answer.text || answer.value || (Array.isArray(answer.texts) ? answer.texts.join('\n') : '') || '');
      }
      return String(answer.text || answer.value || '');
    }

    /**
     * 把填空题干按空位拆成 [{t:文本}|{a:答案}]，导出时把答案直接填回原文空位。
     * 用克隆 DOM 替换空输入为标记，避免 HTML 里的 input 值不出现在 textContent 中。
     */
    _buildFillStemParts(questionEl, fillInputs, values) {
      const root = fillInputs[0].closest?.('.exam-font') || fillInputs[0].parentElement || questionEl;
      if (!root || typeof root.cloneNode !== 'function') return null;
      const valMap = new Map(fillInputs.map((inp, i) => [inp, values[i] || '']));
      const selector = 'input:not([type]), input[type="text"], textarea';
      const isBlankInput = (inp) => {
        if (inp.disabled) return false;
        const cls = typeof inp.className === 'string' ? inp.className : '';
        const hint = cls + ' ' + (inp.getAttribute('placeholder') || '');
        return !/search|搜索/i.test(hint);
      };
      const clone = root.cloneNode(true);
      const origInputs = Array.from(root.querySelectorAll(selector)).filter(isBlankInput);
      const cloneInputs = Array.from(clone.querySelectorAll(selector)).filter(isBlankInput);
      const markerVals = [];
      for (let i = 0; i < cloneInputs.length; i++) {
        markerVals.push((origInputs[i] && valMap.get(origInputs[i])) || '');
        const wrap = cloneInputs[i].closest?.('.blank-area') || cloneInputs[i];
        wrap.replaceWith(`@@YKBLANK${i}@@`);
      }
      const raw = String(clone.textContent || '');
      const parts = [];
      const re = /@@YKBLANK(\d+)@@/g;
      let last = 0, m;
      while ((m = re.exec(raw))) {
        const txt = raw.slice(last, m.index);
        if (txt) parts.push({ t: txt });
        parts.push({ a: markerVals[parseInt(m[1], 10)] || '' });
        last = re.lastIndex;
      }
      const tail = raw.slice(last);
      if (tail) parts.push({ t: tail });
      for (const p of parts) {
        if (p.t) p.t = p.t.replace(/[\s ]+/g, ' ');
      }
      if (parts[0] && parts[0].t) parts[0].t = parts[0].t.replace(/^ /, '');
      const lastPart = parts[parts.length - 1];
      if (lastPart && lastPart.t) lastPart.t = lastPart.t.replace(/ $/, '');
      return parts.some(p => Object.prototype.hasOwnProperty.call(p, 'a')) ? parts : null;
    }

    /** 检查题目DOM中是否有已选中的选项 */
    _hasActiveSelection(questionEl) {
      const radios = questionEl.querySelectorAll('input[type="radio"]');
      for (const r of radios) { if (r.checked) return true; }
      const checks = questionEl.querySelectorAll('input[type="checkbox"]');
      for (const c of checks) { if (c.checked) return true; }
      const textInputs = questionEl.querySelectorAll('input[type="text"]:not([class*="search"]), textarea');
      for (const inp of textInputs) {
        if ((inp.value || '').trim()) return true;
      }
      const richEditors = questionEl.querySelectorAll('[contenteditable="true"]');
      for (const ed of richEditors) {
        if ((ed.textContent || '').trim()) return true;
      }
      // 也检查 iframe 内的编辑器
      try {
        const iframes = questionEl.querySelectorAll('iframe');
        for (const f of iframes) {
          try {
            const doc = f.contentDocument || f.contentWindow?.document;
            if (doc) {
              for (const ta of doc.querySelectorAll('textarea')) {
                if ((ta.value || '').trim()) return true;
              }
              for (const ed of doc.querySelectorAll('[contenteditable="true"]')) {
                if ((ed.textContent || '').trim()) return true;
              }
            }
          } catch(e) {}
        }
      } catch(e) {}
      const selected = questionEl.querySelector('[class*="selected"], [class*="active"], [class*="checked"], [aria-checked="true"]');
      if (selected) return true;
      return false;
    }

    // ========== 自动作答（仅高置信度来源） ==========
    /**
     * 返回 answer 对象或 null
     * 高置信度来源：
     *   1. 缓存 (之前正确作答过的题目)
     *   2. window 全局状态 (__INITIAL_STATE__, __DATA__ 等)
     *   3. DOM 显式 data-answer 属性 (值为 true/1/correct/right)
     *   4. 隐藏 input[name*=answer] 或 data-answer 元素
     * 不使用：class 推断、aria 推断、关键词推断、重试提交
     */
    async tryAutoAnswer(q) {
      // 1. 缓存
      const cached = this.quizCache[q.stemKey];
      if (cached) {
        // 多选题旧格式修复：如果缓存答案只有 index 没有 indices，丢弃让 AI 重答
        if (q.qtype === QTYPE.MULTI && cached.answer && typeof cached.answer.index === 'number' && !cached.answer.indices) {
          logger.warn('Quiz', '多选题缓存为旧格式(单选index)，丢弃缓存，让AI重答:', q.stemKey.substring(0, 50));
          delete this.quizCache[q.stemKey];
          Storage.setAnswerCache(this.quizCache);
          // 不返回，继续往下走到 AI
        // 填空题旧格式修复：缓存答案无 text 字段（旧版误将填空题当选择题处理），丢弃让 AI 重答
        } else if (q.qtype === QTYPE.FILL && cached.answer && !cached.answer.text && !Array.isArray(cached.answer.texts)) {
          logger.warn('Quiz', '填空题缓存为旧格式(无text字段)，丢弃缓存，让AI重答:', q.stemKey.substring(0, 50));
          delete this.quizCache[q.stemKey];
          Storage.setAnswerCache(this.quizCache);
          // 不返回，继续往下走到 AI
        } else {
          logger.info('Quiz', '缓存命中:', q.stemKey.substring(0, 40));
          await this.applyAnswer(q.el, cached.answer, q.qtype);
          return cached.answer;
        }
      }

      // 解答题：不尝试自动作答
      if (q.qtype === QTYPE.ESSAY) return null;

      // 填空题：统一走 AI 作答，不信任全局状态/预填值（可能是旧版错误缓存）
      if (q.qtype === QTYPE.FILL) return null;

      // 2. 全局 JS 状态
      const stateAnswer = this.findAnswerInGlobalState(q);
      if (stateAnswer !== null) {
        logger.info('Quiz', '全局状态找到答案');
        await this.applyAnswer(q.el, stateAnswer, q.qtype);
        Storage.addAnswer(q.stemKey, stateAnswer);
        this.quizCache = Storage.getAnswerCache();
        return stateAnswer;
      }

      // 4. DOM 显式答案属性（仅 data-answer/data-correct/data-right 且值为 true/1）
      const domAnswer = this.findExplicitDOMAnswer(q);
      if (domAnswer !== null) {
        logger.info('Quiz', 'DOM显式属性找到答案');
        await this.applyAnswer(q.el, domAnswer, q.qtype);
        Storage.addAnswer(q.stemKey, domAnswer);
        this.quizCache = Storage.getAnswerCache();
        return domAnswer;
      }

      // 5. 隐藏元素中的答案数据
      const hiddenAnswer = this.findHiddenAnswerData(q.el);
      if (hiddenAnswer !== null) {
        logger.info('Quiz', '隐藏数据找到答案');
        await this.applyAnswer(q.el, hiddenAnswer, q.qtype);
        Storage.addAnswer(q.stemKey, hiddenAnswer);
        this.quizCache = Storage.getAnswerCache();
        return hiddenAnswer;
      }

      return null;
    }

    /** 单题 AI 请求：按题型组织题干/选项/全文，返回 answer 对象或 null */
    async _requestAIAnswer(q) {
      if (!this.ai || !this.ai.enabled) return null;
      const stem = q.stem || this.getQuestionStem(q.el);
      if (q.qtype === QTYPE.ESSAY) {
        return await this.ai.answer(stem, [], QTYPE.ESSAY, (q.el.textContent || '').substring(0, 2000));
      }
      if (q.qtype === QTYPE.FILL) {
        const blankCount = this._getFillInputs(q.el).length;
        let fullText = (q.el.textContent || '').substring(0, 800);
        const fillRule = '每个空只给一个确切答案，优先教材原话或关键术语，简明扼要，不要重复题干，不要用"/"给多个备选';
        if (blankCount > 1) {
          fullText += `\n（本题共有 ${blankCount} 个空，请按空的顺序输出 {"texts": [...]} 数组，每个元素对应一个空；${fillRule}）`;
        } else {
          fullText += `\n（${fillRule}）`;
        }
        return await this.ai.answer(stem, [], QTYPE.FILL, fullText);
      }
      const opts = this._getAllOptionTexts(q.el);
      const cleanOpts = (opts.length === 1 && opts[0]?.startsWith('__FULLTEXT__:')) ? [] : opts;
      const fullText = (cleanOpts.length < 2) ? (q.el.textContent || '').substring(0, 800) : null;
      return await this.ai.answer(stem, cleanOpts, q.qtype, fullText);
    }

    // ========== 全局 JS 状态查找 ==========
    findAnswerInGlobalState(q) {
      // 常见的全局状态变量名
      const stateNames = [
        '__INITIAL_STATE__', '__NUXT__', '__NEXT_DATA__',
        '__DATA__', '__PRELOADED_STATE__', '__STORE__',
        'pageData', 'appData', 'window._state', 'window.__data',
        '__SERVER_DATA__', '__APP_DATA__', '__RENDER_DATA__'
      ];

      for (const name of stateNames) {
        try {
          let data = null;
          // 支持嵌套路径
          if (name.includes('.')) {
            const parts = name.split('.');
            let obj = window;
            for (const p of parts) {
              obj = obj?.[p];
              if (!obj) break;
            }
            data = obj;
          } else {
            data = window[name];
          }
          if (!data || typeof data !== 'object') continue;

          // 递归搜索包含题目答案的数据
          const answer = this._searchStateForAnswer(data, q.stemKey, q.qtype, 0);
          if (answer !== null) return answer;
        } catch (e) {
          // 跨域访问可能抛异常
        }
      }
      return null;
    }

    _searchStateForAnswer(obj, stemKey, qtype, depth) {
      if (!obj || typeof obj !== 'object' || depth > 8) return null;
      if (depth > 0 && typeof obj === 'string' && obj.length > 3 && obj.length < 200) {
        // 检查字符串是否匹配答案模式
        const norm = DOM.normalizeText(obj).substring(0, 80);
        if (norm.includes(stemKey.substring(0, 20))) return null; // 是题干本身，跳过
      }

      // 查找包含答案数据的 key
      if (depth > 0 && !Array.isArray(obj)) {
        const keys = Object.keys(obj);
        // 检查是否有 answer/correct 相关的 key
        const answerKeys = keys.filter(k =>
          /^(answer|correct|right|key|solution)$/i.test(k) ||
          /(answer|correct|right|solution)/i.test(k)
        );
        for (const k of answerKeys) {
          const val = obj[k];
          if (Array.isArray(val) && val.length > 0) {
            // 可能是选项索引数组
            if (val.every(v => typeof v === 'number')) {
              return { indices: val };
            }
          }
          if (typeof val === 'number' && val >= 0) {
            return { index: val };
          }
          if (typeof val === 'string' && val.length > 0 && val.length < 100) {
            // 尝试解析为字母答案
            if (/^[A-Ha-h]$/.test(val.trim())) {
              const letterMap = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5, 'G': 6, 'H': 7 };
              const idx = letterMap[val.trim().toUpperCase()];
              if (idx !== undefined) return { index: idx };
            }
            return { value: val.trim() };
          }
          if (typeof val === 'boolean') {
            return { value: val ? 'true' : 'false' };
          }
        }
      }

      // 递归搜索
      if (Array.isArray(obj)) {
        for (let i = 0; i < Math.min(obj.length, 50); i++) {
          const result = this._searchStateForAnswer(obj[i], stemKey, qtype, depth + 1);
          if (result !== null) return result;
        }
      } else if (typeof obj === 'object') {
        const keys = Object.keys(obj).slice(0, 30);
        for (const k of keys) {
          // 跳过明显不是答案数据的 key
          if (/^(id|name|title|url|src|href|class|style|type|key|ref)$/i.test(k)) continue;
          const result = this._searchStateForAnswer(obj[k], stemKey, qtype, depth + 1);
          if (result !== null) return result;
        }
      }
      return null;
    }

    // ========== DOM 显式答案属性查找（严格模式） ==========
    /**
     * 仅匹配明确标记正确答案的属性：
     *   data-answer="true" / data-correct="1" / data-right="correct" 等
     * 不使用 class/aria 推断，避免 UI 状态误解
     */
    findExplicitDOMAnswer(q) {
      const candidates = q.el.querySelectorAll('input[type="radio"], input[type="checkbox"], [class*="option"], [class*="choice"], label, li, div');

      for (const cand of candidates) {
        let el = cand;
        while (el && el !== q.el && el !== document.body) {
          // 严格检查：仅 data-answer / data-correct / data-right
          for (const attr of ['data-answer', 'data-correct', 'data-right']) {
            const raw = el.getAttribute?.(attr);
            if (raw !== null && raw !== undefined) {
              const v = raw.toString().toLowerCase().trim();
              if (v === 'true' || v === '1' || v === 'correct' || v === 'right' || v === 'yes') {
                return this.getOptionIndexOrValue(cand, q.el);
              }
            }
          }
          el = el.parentElement;
        }
      }
      return null;
    }

    // ========== 隐藏答案数据查找 ==========
    findHiddenAnswerData(questionEl) {
      // script 标签中的答案变量
      const scripts = questionEl.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        const patterns = [
          /"(?:answer|correct|rightAnswer|answerKey|correctAnswer)"\s*[:=]\s*"([^"]+)"/i,
          /'(?:answer|correct|rightAnswer|answerKey|correctAnswer)'\s*[:=]\s*'([^']+)'/i,
          /answer\s*[:=]\s*(\[[0-9,\s]+\])/i,
          /correct\s*[:=]\s*"([^"]+)"/i,
        ];
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) {
            try {
              const parsed = JSON.parse(match[1]);
              if (Array.isArray(parsed)) return { indices: parsed };
            } catch (e) {
              return { value: match[1].trim() };
            }
          }
        }
      }

      // 隐藏的 input[name*=answer]
      const hiddenInputs = questionEl.querySelectorAll('input[type="hidden"][name*="answer"], input[type="hidden"][name*="correct"], input[type="hidden"][name*="right"]');
      for (const inp of hiddenInputs) {
        const val = inp.value?.trim();
        if (val && val.length > 0 && val.length < 200) {
          return { value: val };
        }
      }

      return null;
    }

    // ========== 题型识别 ==========
    detectQuestionType(questionEl) {
      const fullText = (questionEl.textContent || '').toLowerCase();

      const textareas = questionEl.querySelectorAll('textarea');
      const radios = questionEl.querySelectorAll('input[type="radio"]');
      const checks = questionEl.querySelectorAll('input[type="checkbox"]');
      const textInputs = questionEl.querySelectorAll('input[type="text"]:not([class*="search"]):not([placeholder*="搜索"]):not([placeholder*="search"])');

      // 解答题检测
      // 先检查题型标签（通常在最前面，如 .item-type、[class*="type"] 等）
      const typeLabelEl = questionEl.querySelector('.item-type, [class*="type-tag"], [class*="qtype"], [class*="question-type"]');
      const typeLabelText = (typeLabelEl?.textContent || '').substring(0, 20);
      const isExplicitEssay = /简答|论述|解答|问答|主观|作文|essay|问答|简述|计算|分析|应用|综合|材料|设计|编程|证明|推导|绘图|案例|评价|说明|阐述|解释|回答|作答|名词解释|辨析/i.test(typeLabelText);
      const isExplicitFill = /填空|填充|补全|填写|完形|fill/i.test(typeLabelText);

      // 找到所有富文本编辑器（包括 iframe 内的）
      const contentEditables = questionEl.querySelectorAll('[contenteditable="true"], [contenteditable=""], .w-e-text, .ql-editor, [class*="w-e-text"], iframe');
      const hasRichEditor = contentEditables.length > 0;
      // 检查 iframe 内是否有 contentEditable
      let hasIframeEditor = false;
      if (contentEditables.length > 0) {
        for (const el of contentEditables) {
          if (el.tagName === 'IFRAME') {
            try {
              const doc = el.contentDocument || el.contentWindow?.document;
              if (doc && doc.querySelector('[contenteditable="true"], textarea')) { hasIframeEditor = true; break; }
            } catch(e) {}
          }
        }
      }

      const essayKeywords = /简答|论述|解答|问答|简述|作文|计算|分析|应用|综合|材料|设计|编程|证明|推导|绘图|案例|评价|说明|阐述|解释|主观|回答|作答|名词解释|辨析|essay/i;
      const hasEssayKeyword = essayKeywords.test(fullText.substring(0, 120)) || essayKeywords.test(typeLabelText);

      // 优先检测：题型标签明确标注为解答题
      if (isExplicitEssay && radios.length === 0 && checks.length === 0) {
        return QTYPE.ESSAY;
      }

      // 富文本编辑器 + 无选项 → 解答题（即使没有 essay 关键词也更可能是主观题）
      if (radios.length === 0 && checks.length === 0 && textInputs.length === 0) {
        if (hasRichEditor || hasIframeEditor) {
          if (hasEssayKeyword) return QTYPE.ESSAY;
          // 没有 essay 关键词但有大量文本内容的编辑器 → 仍然判定为解答题
          for (const el of contentEditables) {
            if (el.tagName !== 'IFRAME') {
              const childText = (el.textContent || '').trim();
              if (el.classList.contains('ql-editor') || el.classList.contains('w-e-text') || /editor|text|answer/i.test(el.className)) {
                return QTYPE.ESSAY;
              }
            }
          }
          return QTYPE.ESSAY;  // 保守判定：有 contentEditable 且无选项，大概率是主观题
        }
        // 检查常见的富文本编辑器类名
        const editorClasses = questionEl.querySelectorAll('[class*="richtext"], [class*="rich-text"], [class*="w-e-text"], [class*="edui"], [class*="cke_"], [class*="trumbowyg"], [class*="sun-editor"]');
        if (editorClasses.length > 0) return QTYPE.ESSAY;
      }

      // 有 textarea 的情况
      if (textareas.length > 0) {
        // 如果同时有选项和文本框 → 以选项为准，不是解答题
        if (radios.length > 0 || checks.length > 0) {
          if (checks.length > 0) return QTYPE.MULTI;
          if (radios.length > 0) return this.isJudgeByOptions(questionEl) ? QTYPE.JUDGE : QTYPE.SINGLE;
        }
        // 判断是大文本框(解答)还是小文本框(填空)
        const isEssay = Array.from(textareas).some(ta => {
          const rows = parseInt(ta.getAttribute('rows') || '1');
          const h = ta.offsetHeight || ta.clientHeight || 0;
          // 放宽条件：rows>=4 或 高度>80px 或 有essay关键词 或 题型标签标注解答
          return (rows >= 4) || (h > 80) || hasEssayKeyword || isExplicitEssay;
        });
        if (isEssay) return QTYPE.ESSAY;
        return QTYPE.FILL;
      }

      // 纯文本输入(无选项) → 填空题
      if (textInputs.length > 0 && radios.length === 0 && checks.length === 0) {
        // 只检查 .item-type 区域的题型标签，避免题干正文中的词干扰（如"判断能力"匹配"判断"）
        const typeLabel = (questionEl.querySelector('.item-type')?.textContent || '').substring(0, 30);
        if (/判断|选择|单选|多选/i.test(typeLabel)) {
          return QTYPE.UNKNOWN;
        }
        if (/简答|论述|解答|问答|简述|计算|分析|应用|综合|材料|设计|编程|证明|推导|绘图|案例|评价|说明|阐述|解释|主观|回答|作答|作文|essay/i.test(typeLabel)) {
          return QTYPE.ESSAY;
        }
        return QTYPE.FILL;
      }

      // 多选题
      if (checks.length > 0) return QTYPE.MULTI;

      // Element UI 多选题：el-checkbox 或 list-unstyled-checkbox
      if (questionEl.querySelectorAll('label.el-checkbox').length >= 2) return QTYPE.MULTI;
      if (questionEl.querySelectorAll('ul.list-unstyled-checkbox').length > 0) return QTYPE.MULTI;

      // 单选/判断
      if (radios.length > 0) {
        if (this.isJudgeByOptions(questionEl)) return QTYPE.JUDGE;
        // 额外：即使选项文本不是标准判断词，题干明确提到"判断"也归为判断题
        const stemText = (questionEl.textContent || '').substring(0, 100);
        if (/判断|对错|是非/i.test(stemText)) return QTYPE.JUDGE;
        return QTYPE.SINGLE;
      }

      // Element UI 单选题：el-radio 或 list-unstyled-radio
      if (questionEl.querySelectorAll('label.el-radio').length >= 2) {
        if (this.isJudgeByOptions(questionEl)) return QTYPE.JUDGE;
        return QTYPE.SINGLE;
      }

      // 无原生 input，检查选项文本
      const optionEls = questionEl.querySelectorAll('[class*="option"], [class*="choice"], li[class*="item"], label, [class*="list-unstyled"] > li, [class*="list-unstyled"] > div');
      if (optionEls.length > 0) {
        // 考试系统类型判断：优先根据选项容器类名
        const hasCheckboxClass = questionEl.querySelectorAll('[class*="checkbox"]:not([class*="radio"])');
        const hasRadioClass = questionEl.querySelectorAll('[class*="radio"]:not([class*="checkbox"])');
        if (hasCheckboxClass.length > 0) return QTYPE.MULTI;
        const multiMarkers = questionEl.querySelectorAll('[class*="checkbox"], [class*="multi"], [class*="check"], [type="checkbox"]');
        if (multiMarkers.length > 0) return QTYPE.MULTI;
        if (this.isJudgeByOptions(questionEl)) return QTYPE.JUDGE;
        const contextText = fullText.substring(0, 120);
        if (/多选|不定项|多项|multiple|多选|不定项/i.test(contextText)) return QTYPE.MULTI;
        return QTYPE.SINGLE;
      }

      // 从文本内容推断
      if (/多选|不定项|多项|multiple/i.test(fullText.substring(0, 100))) return QTYPE.MULTI;
      if (/判断|对错|是非/i.test(fullText.substring(0, 100))) return QTYPE.JUDGE;
      if (/填空|填充|补全|填写/i.test(fullText.substring(0, 100))) return QTYPE.FILL;
      if (/简答|论述|解答|问答|简述|计算|分析|应用|综合|材料|设计|编程|证明|推导|绘图|案例|评价|说明|阐述|解释|主观|回答|作答/i.test(fullText.substring(0, 100))) return QTYPE.ESSAY;
      if (/单选|选择/i.test(fullText.substring(0, 100))) return QTYPE.SINGLE;

      return QTYPE.UNKNOWN;
    }

    isJudgeByOptions(questionEl) {
      const optionTexts = this.getOptionLabels(questionEl);
      if (optionTexts.length < 2 || optionTexts.length > 4) return false;

      // 检查选项文本是否包含判断关键词（不要求完全匹配，允许前后缀如"A. 正确"）
      const judgeWords = ['对', '错', '正确', '错误', '是', '否', '√', '×', '✓', '✗',
                          'True', 'False', 'Yes', 'No', 'T', 'F', 'Y', 'N',
                          'true', 'false', 'yes', 'no'];
      let judgeCount = 0;
      for (const t of optionTexts) {
        const cleaned = t.trim().replace(/^[A-Za-z0-9][.、．)\s]+/, '').trim(); // 去掉" A."前缀
        for (const w of judgeWords) {
          if (cleaned === w || cleaned.startsWith(w) || cleaned.endsWith(w)) {
            judgeCount++;
            break;
          }
        }
      }
      // 2-4个选项且至少2个是判断词 → 判断题
      if (optionTexts.length === 2 && judgeCount === 2) return true;
      if (optionTexts.length >= 2 && judgeCount >= 2) {
        const stem = this.getQuestionStem(questionEl).substring(0, 80);
        if (/判断|对错|是非|正确错误|说法.*正确|说法.*错误|下列说法|以下说法/i.test(stem)) return true;
      }
      // 题干包含判断提示且只有2个选项
      if (optionTexts.length === 2) {
        const stem = this.getQuestionStem(questionEl).substring(0, 80);
        if (/判断|对错|是非|正确错误|下列说法|以下说法/i.test(stem)) return true;
      }
      return false;
    }

    getOptionLabels(questionEl) {
      const labels = [];
      const seen = new Set();
      const addLabel = (t) => {
        if (!t || t.length > 30 || t.length < 1) return;
        const key = t.substring(0, 10);
        if (seen.has(key)) return;
        seen.add(key);
        labels.push(t);
      };

      const labelEls = questionEl.querySelectorAll('label');
      for (const el of labelEls) {
        addLabel(DOM.getText(el));
      }
      if (labels.length >= 2) return labels;

      const container = questionEl.querySelector('[class*="option"], [class*="choice"], [class*="options"], [class*="choices"]');
      if (container) {
        const items = container.querySelectorAll('li, p, div, span');
        for (const item of items) {
          addLabel(DOM.getText(item));
        }
      }

      // 也检查直接子元素中的短文本
      if (labels.length < 2) {
        const children = questionEl.children;
        for (const child of children) {
          const t = DOM.getText(child);
          if (t && t.length <= 30) addLabel(t);
        }
      }

      return labels;
    }

    /** 获取所有选项的完整文本（供 AI 使用） */
    _getAllOptionTexts(questionEl) {
      const texts = [];
      const seen = new Set();

      // 判断题：Element UI 图标选项（value=true/false，无文字），固定映射为 正确/错误
      const judgeRadios = questionEl.querySelectorAll('input[type="radio"]');
      if (judgeRadios.length === 2) {
        const vals = Array.from(judgeRadios).map(i => String(i.value || '').toLowerCase());
        if (vals.includes('true') && vals.includes('false')) {
          return Array.from(judgeRadios).map(i =>
            String(i.value).toLowerCase() === 'true' ? '正确' : '错误');
        }
      }

      const add = (t) => {
        if (!t) return;
        // 去除前缀字母标记 A. A、A) (A) 等
        const cleaned = t.replace(/^\s*[（(]?\s*[A-Ha-h]\s*[)）.、．.\s:：]+\s*/, '').trim();
        if (cleaned && cleaned.length >= 1 && cleaned.length < 200) {
          const key = cleaned.substring(0, 30);
          if (!seen.has(key)) { seen.add(key); texts.push(cleaned); }
        }
      };

      // 策略1：找到 input[type=radio/checkbox] → 取其所在 label/容器文本
      const inputs = questionEl.querySelectorAll('input[type="radio"], input[type="checkbox"]');
      for (const inp of inputs) {
        // 优先找最近的 label 父元素
        const label = inp.closest('label');
        if (label) { add(DOM.getText(label)); continue; }
        // 找包含该 input 的选项容器
        const optionWrap = inp.closest('[class*="option"], [class*="choice"], li');
        if (optionWrap) { add(DOM.getText(optionWrap)); continue; }
        // 最后找任意父级 div/li
        const parent = inp.closest('div, li');
        if (parent) { add(DOM.getText(parent)); }
      }
      if (texts.length >= 2) {
        logger.debug('Quiz', `选项提取(策略1): ${texts.length}项`, texts);
        return texts;
      }

      // 策略2：在有 radio/checkbox 的容器中，找所有带文本的子元素
      // 含考试系统 list-unstyled-checkbox / list-unstyled-radio 等容器
      const containerPatterns = [
        '[class*="options"]', '[class*="choices"]', '[class*="option-list"]',
        '[class*="option-group"]', '[class*="list-unstyled-checkbox"]',
        '[class*="list-unstyled-radio"]', '[class*="list-unstyled"]',
        '[class*="answer-list"]', '[class*="answerList"]',
      ];
      for (const pat of containerPatterns) {
        const containers = questionEl.querySelectorAll(pat);
        for (const container of containers) {
          const items = container.children;
          for (const item of items) {
            if (item.tagName === 'BR' || item.tagName === 'HR') continue;
            const text = DOM.getText(item);
            if (text && text.length >= 1) add(text);
          }
          if (texts.length >= 2) break;
        }
        if (texts.length >= 2) break;
      }
      if (texts.length >= 2) {
        logger.debug('Quiz', `选项提取(策略2): ${texts.length}项`, texts);
        return texts;
      }

      // 策略3：无 radio/checkbox 输入 → 纯文本选项（React/Vue 组件渲染）
      // 查找有规律编号的子元素：A.xx B.xx 或 1.xx 2.xx
      const allText = DOM.getText(questionEl);
      // 尝试按字母前缀拆分: A. A、A) (A) A．等
      const letterSplitRe = /(?:^|\n|\.\s*|;\s*|；\s*)\s*([A-H])\s*[.、．)\s]+/gim;
      const letterMatches = [...allText.matchAll(letterSplitRe)];
      if (letterMatches.length >= 2) {
        for (let i = 0; i < letterMatches.length; i++) {
          const matchStart = letterMatches[i].index + letterMatches[i][0].length;
          const matchEnd = (i + 1 < letterMatches.length) ? letterMatches[i + 1].index : allText.length;
          const text = allText.substring(matchStart, matchEnd).trim();
          if (text) add(text);
        }
      }
      if (texts.length >= 2) {
        logger.debug('Quiz', `选项提取(策略3-字母拆分): ${texts.length}项`, texts);
        return texts;
      }

      // 策略4：按数字前缀拆分 1. 2. 3. 4.
      const numSplit = allText.split(/(?:^|\n)\s*(\d{1,2})\s*[.、．)\s]+/m);
      if (numSplit.length >= 5) {
        for (let i = 1; i < numSplit.length; i += 2) {
          const text = numSplit[i + 1] || '';
          if (text.trim()) add(text.trim());
        }
      }
      if (texts.length >= 2) {
        logger.debug('Quiz', `选项提取(策略4-数字拆分): ${texts.length}项`, texts);
        return texts;
      }

      // 策略5：找 questionEl 下所有直接子元素或孙子元素中带字母前缀的
      const allDivs = questionEl.querySelectorAll('div, li, p, span');
      for (const div of allDivs) {
        const t = DOM.getText(div);
        if (/^[A-H][.、．)\s]/.test(t) && t.length <= 200) {
          add(t);
        }
      }
      if (texts.length >= 2) {
        logger.debug('Quiz', `选项提取(策略5-字母标记): ${texts.length}项`, texts);
        return texts;
      }

      // 策略6：判断题专用 — 在题干文本中搜索 "对/错" "正确/错误" "是/否" 等二元选项
      const judgePairPatterns = [
        ['对', '错'], ['正确', '错误'], ['是', '否'], ['√', '×'],
        ['T', 'F'], ['True', 'False'], ['Yes', 'No'], ['Y', 'N'],
        ['true', 'false'], ['yes', 'no'],
      ];
      for (const [pos, neg] of judgePairPatterns) {
        if (allText.includes(pos) && allText.includes(neg)) {
          add(pos);
          add(neg);
          logger.debug('Quiz', `选项提取(策略6-判断题): ${texts.length}项`, texts);
          return texts;
        }
      }

      // 策略7：全文回退 — 把元素内所有可见的子元素文本作为选项
      // 查找所有直接子元素中可能是选项的元素（文本较短、看起来像选项）
      const directChildren = questionEl.children;
      if (directChildren.length >= 2) {
        const candidateTexts = [];
        for (const child of directChildren) {
          const t = DOM.getText(child);
          if (t && t.length >= 1 && t.length <= 200) {
            candidateTexts.push(t);
          }
        }
        if (candidateTexts.length >= 2) {
          for (const t of candidateTexts) add(t);
          logger.debug('Quiz', `选项提取(策略7-直接子元素): ${texts.length}项`, texts);
          return texts;
        }
      }

      // 策略8：最后手段 — 从完整文本中截取。如果文本较短（<500字），整体传给AI
      if (allText.length > 0 && allText.length < 600) {
        texts.push('__FULLTEXT__:' + allText);
        logger.debug('Quiz', `选项提取(策略8-全文回退): 文本长度=${allText.length}`);
        return texts;
      }

      logger.debug('Quiz', `选项提取全部失败: inputs=${inputs.length}, textLen=${allText.length}`, allText.substring(0, 100));
      return texts;
    }

    /** 获取选项DOM元素列表（用于点击），与 _getAllOptionTexts 策略对应 */
    _getOptionElements(questionEl) {
      // 策略1：有 radio/checkbox input → 返回其容器
      const inputs = questionEl.querySelectorAll('input[type="radio"], input[type="checkbox"]');
      if (inputs.length >= 2) {
        const els = [];
        for (const inp of inputs) {
          const label = inp.closest('label');
          if (label) { els.push(label); continue; }
          const wrap = inp.closest('[class*="option"], [class*="choice"], li');
          if (wrap) { els.push(wrap); continue; }
          els.push(inp);
        }
        return els;
      }

      // 策略2：选项容器 → 返回直接子元素（含考试系统 list-unstyled 容器）
      const containerPatterns = [
        '[class*="options"]', '[class*="choices"]', '[class*="option-list"]',
        '[class*="option-group"]', '[class*="list-unstyled-checkbox"]',
        '[class*="list-unstyled-radio"]', '[class*="list-unstyled"]',
        '[class*="answer-list"]', '[class*="answerList"]',
      ];
      for (const pat of containerPatterns) {
        const containers = questionEl.querySelectorAll(pat);
        for (const container of containers) {
          // 跳过太宽泛的匹配（如 list-unstyled 匹配到父级非选项容器）
          const isLikelyOptionContainer = (
            container.querySelectorAll('input[type="radio"], input[type="checkbox"]').length >= 2 ||
            /checkbox|radio|option|choice|answer/i.test(container.className?.toString() || '')
          );
          if (pat === '[class*="list-unstyled"]' && !isLikelyOptionContainer) continue;

          const children = Array.from(container.children).filter(c => {
            const t = DOM.getText(c);
            return t && t.length >= 1 && t.length <= 300;
          });
          if (children.length >= 2) {
            logger.debug('Quiz', `选项元素(策略2-${pat}): ${children.length}个`);
            return children;
          }
        }
      }

      // 策略3：label 元素
      const labels = questionEl.querySelectorAll('label');
      if (labels.length >= 2) return Array.from(labels);

      // 策略4：带字母前缀的 div/li/p/span (A/B/C/D) → 优先内部可点击元素
      const letterItems = [];
      const allItems = questionEl.querySelectorAll('div, li, p, span');
      for (const item of allItems) {
        const t = DOM.getText(item).trim();
        if (/^[A-H][.、．)\s]/.test(t) && t.length <= 300) {
          const clickable = item.querySelector('a, button, [role="button"], [class*="click"], [class*="check-box"], [class*="radio-box"]');
          letterItems.push(clickable || item);
        }
      }
      if (letterItems.length >= 2) return letterItems;

      // 策略5：questionEl 的直接子元素
      const directChildren = Array.from(questionEl.children).filter(c => {
        const t = DOM.getText(c);
        return t && t.length >= 1 && t.length <= 300;
      });
      if (directChildren.length >= 2) return directChildren;

      // 策略6：查找所有可能是选项的 div（React渲染常见：每个选项是一个div）
      const candidates = [];
      const allDivs = questionEl.querySelectorAll(':scope > div, :scope > li, :scope > span, :scope > label');
      for (const div of allDivs) {
        const t = DOM.getText(div).trim();
        if (t && t.length >= 1 && t.length <= 300) {
          const isDuplicate = candidates.some(c => {
            const ct = DOM.getText(c);
            return ct.includes(t) || t.includes(ct);
          });
          if (!isDuplicate) candidates.push(div);
        }
      }
      if (candidates.length >= 2) return candidates;

      // 策略7：考试系统 Vue 组件 — 选项可能有内部图标/勾选元素
      const checkIcons = questionEl.querySelectorAll('[class*="check-icon"], [class*="radio-icon"], [class*="select-icon"], [class*="check-box"], [class*="radio-box"], [class*="option-icon"], [class*="choice-icon"], i[class*="check"], i[class*="select"]');
      if (checkIcons.length >= 2) {
        // 返回它们的父级可点击容器
        const iconParents = Array.from(checkIcons).map(icon => {
          return icon.closest('li, div, label, span') || icon;
        }).filter((el, i, arr) => arr.indexOf(el) === i); // 去重
        if (iconParents.length >= 2) {
          logger.debug('Quiz', `选项元素(策略7-图标): ${iconParents.length}个`);
          return iconParents;
        }
      }

      // 策略8：ARIA role
      const ariaItems = questionEl.querySelectorAll('[role="radio"], [role="checkbox"], [class*="option-item"], [class*="choice-item"]');
      if (ariaItems.length >= 2) return Array.from(ariaItems);

      // 策略9：最后兜底 — 在 questionEl 内找所有独立的 li，或按层级找孙子元素
      const allLis = questionEl.querySelectorAll(':scope li, :scope > * > li');
      if (allLis.length >= 2) {
        const validLis = Array.from(allLis).filter(li => {
          const t = DOM.getText(li);
          return t && t.length >= 1 && t.length <= 300;
        });
        if (validLis.length >= 2) return validLis;
      }

      return [];
    }

    // ========== 读取用户在页面上的手动选择 ==========
    readUserSelection(q) {
      // 填空题
      if (q.qtype === QTYPE.FILL) {
        const inputs = this._getFillInputs(q.el);
        if (inputs.length === 0) return null;
        const values = [];
        for (const inp of inputs) {
          const val = (inp.value || '').trim();
          // 多空填空必须每个空都有值，半填视为未完成，避免被当成已作答
          if (!val || /填空|请输入|your answer/i.test(val)) return null;
          values.push(val);
        }
        return { text: values.join('；'), isFill: true };
      }

      // 解答题
      if (q.qtype === QTYPE.ESSAY) {
        const textareas = q.el.querySelectorAll('textarea');
        const richEditors = q.el.querySelectorAll('[contenteditable="true"], .w-e-text, .ql-editor');
        let content = '';
        for (const ta of textareas) content += (ta.value || '') + ' ';
        for (const ed of richEditors) content += (ed.textContent || '') + ' ';
        // 也检查 iframe 内的内容
        try {
          const iframes = q.el.querySelectorAll('iframe');
          for (const f of iframes) {
            try {
              const doc = f.contentDocument || f.contentWindow?.document;
              if (doc) {
                for (const ta of doc.querySelectorAll('textarea')) content += (ta.value || '') + ' ';
                for (const ed of doc.querySelectorAll('[contenteditable="true"], .w-e-text, .ql-editor')) content += (ed.textContent || '') + ' ';
              }
            } catch(e) {}
          }
        } catch(e) {}
        content = content.trim();
        if (content.length > 0) return { text: content, isEssay: true };
        return null;
      }

      // 选择题 / 判断题
      const radios = q.el.querySelectorAll('input[type="radio"]');
      const checks = q.el.querySelectorAll('input[type="checkbox"]');

      if (checks.length > 0) {
        // 多选
        const indices = [];
        Array.from(checks).forEach((cb, i) => {
          if (cb.checked) indices.push(i);
        });
        if (indices.length > 0) return { indices };
        return null;
      }

      if (radios.length > 0) {
        // 单选 / 判断
        for (let i = 0; i < radios.length; i++) {
          if (radios[i].checked) return { index: i };
        }
        return null;
      }

      // 无原生 input，检查容器中是否有选中状态的元素
      const selected = q.el.querySelector('[class*="selected"], [class*="active"], [class*="checked"], [aria-checked="true"]');
      if (selected) {
        const text = DOM.getText(selected);
        if (text) return { text: text.substring(0, 80) };
      }

      return null;
    }

    /** 清除题目中所有已选项，确保可以重新作答 */
    _clearAllSelections(questionEl) {
      // 清除所有 radio
      const radios = questionEl.querySelectorAll('input[type="radio"]');
      radios.forEach(r => {
        if (r.checked) {
          r.checked = false;
          r.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      // 清除所有 checkbox
      const checks = questionEl.querySelectorAll('input[type="checkbox"]');
      checks.forEach(c => {
        if (c.checked) {
          c.checked = false;
          c.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      // 清除文本输入
      const textInputs = questionEl.querySelectorAll('input[type="text"]:not([class*="search"]), textarea');
      textInputs.forEach(inp => {
        if ((inp.value || '').trim()) {
          this._setTextValue(inp, '');
        }
      });
      // 清除富文本编辑器
      const richEditors = questionEl.querySelectorAll('[contenteditable="true"]');
      richEditors.forEach(ed => {
        ed.textContent = '';
        ed.dispatchEvent(new Event('input', { bubbles: true }));
      });
      // 清除可能的 CSS 选中状态 (React/Vue 组件)
      // 注意：只用精确选择器，[class*="active"] 太宽泛会误伤所有选项
      const selectedEls = questionEl.querySelectorAll('[class*="is-checked"], [class*="is-selected"], [class*="option-checked"], [class*="option-selected"], [aria-checked="true"]');
      selectedEls.forEach(el => {
        try {
          el.click();
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } catch (e) { /* 静默 */ }
      });
    }

    /** 检查自定义组件选项是否已点亮（选中状态） */
    _isOptionSelected(el) {
      if (!el) return false;
      // Element UI 组件实例的选中状态最可靠（Vue 数据层，不依赖渲染出的 class）
      const labelEl = el.matches?.('label.el-radio, label.el-checkbox')
        ? el
        : el.querySelector?.('label.el-radio, label.el-checkbox');
      const vm = labelEl && labelEl.__vue__;
      if (vm) {
        try {
          if (labelEl.classList.contains('el-checkbox') && typeof vm.isChecked === 'boolean') return vm.isChecked;
          if (labelEl.classList.contains('el-radio')) return vm.model === vm.label;
        } catch (e) { /* 组件状态读不到时退回 DOM 判断 */ }
      }
      // 检查元素自身或其最近父级是否有选中标记
      const target = el.closest?.('li, div, label, span') || el;
      const hasCheckedClass = target.matches?.('[class*="is-checked"], [class*="is-selected"], [class*="option-checked"], [class*="option-selected"], [class*="checked"], [aria-checked="true"]');
      if (hasCheckedClass) return true;
      // 检查内部是否有选中图标/标记
      const innerMark = target.querySelector?.('[class*="is-checked"], [class*="is-selected"], [class*="checked"], [aria-checked="true"], [class*="check-icon"]');
      if (innerMark) return true;
      // 检查是否有原生 checked input
      const checkedInput = target.querySelector?.('input:checked');
      return !!checkedInput;
    }

    // ========== 应用答案 ==========
    async applyAnswer(questionEl, answer, qtype) {
      if (!answer) return false;

      const hasStdInputs = questionEl.querySelectorAll('input[type="radio"], input[type="checkbox"]').length >= 2;
      // Element UI 组件检测：el-radio / el-checkbox 必须通过点击触发，不能用 safeSetValue
      const isElementUI = questionEl.querySelectorAll('label.el-radio, label.el-checkbox').length >= 2;

      // 判断题：把 "对/错/正确/错误/是/否/√/×" 等文本答案规范化为选项索引
      if (qtype === QTYPE.JUDGE || qtype === 'judge') {
        answer = this._normalizeJudgeAnswer(questionEl, answer);
      }

      // 多选索引数组 —— 先于单选/清除处理，走独立逻辑
      if (answer.indices && Array.isArray(answer.indices) && answer.indices.length >= 1) {
        // Element UI 或自定义组件：必须用点击方式（safeSetValue 不会触发 Vue 响应式更新）
        if (isElementUI || !hasStdInputs) {
          const optionEls = this._getOptionElements(questionEl);

          if (optionEls.length >= 2) {
            const wanted = answer.indices.filter(i => i >= 0 && i < optionEls.length);
            if (wanted.length > 0) {
              const wantSet = new Set(wanted);
              // 只有存在旧选择时才清空；没答案的干净页面直接勾选，避免"先删再填"的闪烁
              if (optionEls.some(el => this._isOptionSelected(el))) {
                this._clearChoiceAnswers(questionEl);
                await DOM.sleep(300);
              }
              const missed = [];
              for (let i = 0; i < optionEls.length; i++) {
                if (!wantSet.has(i)) continue;
                const el = optionEls[i];
                // 已经选中就跳过：checkbox 再点一次会取消选中
                if (this._isOptionSelected(el)) continue;
                const inner = el.querySelector('.el-radio__inner, .el-checkbox__inner, [class*="check"], [class*="select"], i, svg, [class*="icon"], [class*="toggle"]');
                // 每个选项只点一次。不要检测失败就重试：checkbox 每点一次切换一次，
                // 重试会让选项在"选中/取消"之间反复切换（用户看到反复填写又删除）
                DOM.safeClickOnce(inner || el);
                await DOM.sleep(180);
                if (!this._isOptionSelected(el)) missed.push(i + 1);
              }
              if (missed.length > 0) {
                // 不再补点，避免来回切换；未生效的题可稍后用 ↻ 重答
                logger.warn('Quiz', `多选第 ${missed.join('、')} 项点击后未检测到选中状态，已停止重试以免闪烁`);
              }
              await DOM.sleep(200);
              return true;
            }
          }
        }

        // 标准 checkbox（非 Element UI）：清除后逐个勾选
        if (hasStdInputs) {
          this._clearAllSelections(questionEl);
          const inputs = questionEl.querySelectorAll('input[type="checkbox"]');
          if (inputs.length === 0) return false;
          let clicked = false;
          for (const idx of answer.indices) {
            if (idx < inputs.length) {
              DOM.safeSetValue(inputs[idx]);
              clicked = true;
            }
          }
          return clicked;
        }

        // 兜底：按选项文本定位点击
        const opts = this._getAllOptionTexts(questionEl);
        if (opts.length >= 2) {
          let anyOk = false;
          for (const idx of answer.indices) {
            if (idx >= opts.length) continue;
            for (let attempt = 0; attempt < 3; attempt++) {
              const found = this._clickByText(questionEl, opts[idx]);
              if (found) {
                await DOM.sleep(150);
                anyOk = true;
                break;
              }
              await DOM.sleep(100);
            }
          }
          if (anyOk) return true;
        }

        // 最后手段：找所有 li / option-item 按索引点击
        const allItems = questionEl.querySelectorAll('li, [class*="option-item"], [class*="choice-item"], [class*="list-item"]');
        const valid = Array.from(allItems).filter(el => {
          const t = DOM.getText(el);
          return t && t.length >= 1 && t.length <= 300;
        });
        if (valid.length >= 2) {
          for (const idx of answer.indices) {
            if (idx < valid.length) {
              DOM.safeClickOnce(valid[idx]);
              await DOM.sleep(100);
            }
          }
          return true;
        }

        logger.warn('Quiz', `多选 indices=${JSON.stringify(answer.indices)} 未能应用, optionEls=${optionEls ? optionEls.length : 0}`);
        return false;
      }

      // 单选索引：优先点击（Element UI），其次 safeSetValue（标准input）
      if (typeof answer.index === 'number') {
        // 填空题不接受 index 格式的答案（旧版可能误将填空题当选择题缓存了错误答案）
        if (qtype === QTYPE.FILL) return false;
        this._clearAllSelections(questionEl);
        const optionEls = this._getOptionElements(questionEl);

        // Element UI: 点击 label/el-radio__inner
        if (isElementUI && optionEls.length >= 2 && answer.index < optionEls.length) {
          const el = optionEls[answer.index];
          const inner = el.querySelector('.el-radio__inner, .el-checkbox__inner');
          DOM.safeClick(inner || el);
          await DOM.sleep(150);
          return this._isOptionSelected(el) || true;  // 乐观返回true
        }

        // 标准 input
        if (hasStdInputs) {
          const inputs = questionEl.querySelectorAll('input[type="radio"], input[type="checkbox"]');
          if (answer.index < inputs.length) {
            DOM.safeSetValue(inputs[answer.index]);
            return true;
          }
        }

        // 自定义组件
        if (optionEls.length >= 2 && answer.index < optionEls.length) {
          const clicked = DOM.safeClick(optionEls[answer.index]);
          if (clicked) return true;
        }

        // 兜底：用选项文本匹配
        const opts = this._getAllOptionTexts(questionEl);
        if (opts.length >= 2 && answer.index < opts.length) {
          const fullOpt = opts[answer.index];
          if (this._clickByText(questionEl, fullOpt)) return true;
        }
        // 判断题最终兜底：按 对/错 极性点击
        if (qtype === QTYPE.JUDGE || qtype === 'judge') {
          return this._clickJudgeByPolarity(questionEl, answer.index);
        }
        return false;
      }

      // 文本
      if (answer.text || answer.value || (Array.isArray(answer.texts) && answer.texts.length > 0)) {
        const searchText = (answer.text || answer.value || answer.texts.join('；')).toString().trim();

        // 填空
        if (qtype === QTYPE.FILL || answer.isFill) {
          const inputs = this._getFillInputs(questionEl);
          if (inputs.length === 0) return false;
          // 单空：整段写入，绝不按分隔符截断（避免答案里含逗号/分号时丢内容）
          if (inputs.length === 1) {
            return await this._fillBlanks(questionEl, [searchText]);
          }
          // 多空：优先用 AI 返回的数组，否则按分隔符智能拆分
          const parts = Array.isArray(answer.texts) && answer.texts.length > 0
            ? answer.texts.map(v => String(v).trim())
            : this._splitFillParts(searchText, inputs.length);
          if (parts.length < inputs.length) {
            logger.warn('Quiz', `填空题有${inputs.length}个空，只拆出${parts.length}段答案，其余空留待手动`);
          }
          return await this._fillBlanks(questionEl, parts);
        }

        // 解答题
        if (qtype === QTYPE.ESSAY || answer.isEssay) {
          return await this._applyEssayAnswer(questionEl, searchText);
        }

        // 判断题：文本答案按 对/错 极性匹配选项
        if (qtype === QTYPE.JUDGE || qtype === 'judge') {
          const pol = judgePolarity(searchText);
          if (pol !== -1) {
            const opts = this._getAllOptionTexts(questionEl);
            for (const opt of opts) {
              if (judgePolarity(opt) === pol && this._clickByText(questionEl, opt)) return true;
            }
            return this._clickJudgeByPolarity(questionEl, pol === 1 ? 0 : 1);
          }
        }

        // 选择题：匹配文本
        return this._clickByText(questionEl, searchText);
      }

      // 字母答案 A/B/C/D/...
      if (typeof answer === 'string' && answer.length === 1) {
        const map = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5, 'G': 6, 'H': 7 };
        const idx = map[answer.toUpperCase()];
        if (idx !== undefined) {
          const optionEls = this._getOptionElements(questionEl);
          if (hasStdInputs) {
            const inputs = questionEl.querySelectorAll('input[type="radio"], input[type="checkbox"]');
            if (idx < inputs.length) { DOM.safeSetValue(inputs[idx]); return true; }
          }
          if (optionEls.length >= 2 && idx < optionEls.length) {
            return DOM.safeClick(optionEls[idx]);
          }
        }
      }

      return false;
    }

    /** 判断题文本答案 → 按选项极性转换为索引 */
    _normalizeJudgeAnswer(questionEl, answer) {
      if (!answer || typeof answer !== 'object' || typeof answer.index === 'number') return answer;
      const text = [answer.text, answer.value].find(t => typeof t === 'string' && t.trim());
      if (!text) return answer;
      const pol = judgePolarity(text);
      if (pol === -1) return answer;
      const opts = this._getAllOptionTexts(questionEl);
      for (let i = 0; i < Math.min(opts.length, 4); i++) {
        if (judgePolarity(opts[i]) === pol) return { index: i };
      }
      if (opts.length === 2) return { index: pol === 1 ? 0 : 1 };
      return answer;
    }

    /** 判断题兜底：按极性点击包含 对/错/正确/错误/√/× 的选项 */
    _clickJudgeByPolarity(questionEl, index) {
      // Element UI 图标判断题：value=true 是"正确"（√），value=false 是"错误"（×）
      for (const inp of questionEl.querySelectorAll('input[type="radio"]')) {
        const v = String(inp.value || '').toLowerCase();
        if (v !== 'true' && v !== 'false') continue;
        if ((v === 'true') === (index === 0)) {
          const label = inp.closest('label') || inp;
          DOM.safeClick(label.querySelector('.el-radio__inner') || label);
          return true;
        }
      }
      const want = index === 0 ? 1 : 0;
      const candidates = questionEl.querySelectorAll('label, li, [class*="option"], [class*="choice"]');
      for (const el of candidates) {
        const t = DOM.getText(el);
        if (!t || t.length > 30 || judgePolarity(t) !== want) continue;
        const inner = el.querySelector('.el-radio__inner, .el-checkbox__inner, input[type="radio"], input[type="checkbox"]');
        DOM.safeClick(inner || el);
        return true;
      }
      return false;
    }

    /** 点击包含指定文本的选项元素 */
    _clickByText(questionEl, searchText) {
      const labels = questionEl.querySelectorAll('label, [class*="option"], [class*="choice"], li');
      for (const label of labels) {
        if (DOM.getText(label).includes(searchText)) {
          const input = label.querySelector('input');
          if (input) { DOM.safeSetValue(input); } else { DOM.safeClickOnce(label); }
          return true;
        }
      }
      const inputs = questionEl.querySelectorAll('input');
      for (const inp of inputs) {
        if (inp.value === searchText) { DOM.safeSetValue(inp); return true; }
      }
      // 最后手段：点击任何包含该文本的元素
      const allEls = questionEl.querySelectorAll('div, span, li, label, p, button, a');
      for (const el of allEls) {
        const t = DOM.getText(el);
        if (t === searchText || (t.length <= 100 && t.includes(searchText) && searchText.length > 1)) {
          DOM.safeClickOnce(el);
          return true;
        }
      }
      return false;
    }

    /** 查找解答题/填空题的编辑器元素，支持多种编辑器类型 */
    _findEssayEditors(scope, depth = 0) {
      const results = [];
      const seen = new Set();
      const add = (el) => {
        if (el && !seen.has(el)) { seen.add(el); results.push(el); }
      };

      if (!scope || depth > 3) return results;

      // 1. 标准 textarea
      scope.querySelectorAll('textarea').forEach(add);
      // 2. contenteditable 元素（含所有可编辑变体）
      scope.querySelectorAll('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [contenteditable="markdown"]').forEach(add);
      // 3. Quill 编辑器
      scope.querySelectorAll('.ql-editor, .ql-container [contenteditable]').forEach(add);
      // 4. 富文本编辑器常见类名 — 只添加可写的子元素
      const richSelectors = [
        '.w-e-text', '.w-e-textarea',   // wangEditor 可写区域
        '[class*="edui"] textarea',      // UEditor
        '[class*="cke_"] textarea',      // CKEditor
        '[class*="fr-box"] [contenteditable]', // Froala
        '[class*="tox-"] .tox-edit-area', // TinyMCE
        '[class*="sun-editor"] [contenteditable]',
      ];
      for (const sel of richSelectors) {
        scope.querySelectorAll(sel).forEach(add);
      }
      // 4b: 通过类名中的 richtext/trumbowyg 找到可写元素
      scope.querySelectorAll('[class*="richtext"], [class*="rich-text"], [class*="trumbowyg"]').forEach(el => {
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.contentEditable === 'true' || el.contentEditable === '') {
          add(el);
        }
        el.querySelectorAll('textarea, [contenteditable="true"]').forEach(add);
      });
      // 4c: 雨课堂/国内平台常见编辑器类名 — 找可写子元素
      const cnEditorSelectors = [
        '[class*="answer-edit"]', '[class*="text-edit"]',
        '[class*="edit-area"]', '[class*="input-area"]',
        '[class*="fill-answer"]', '[class*="write-answer"]',
        '[class*="short-answer"]', '[class*="long-answer"]',
        '[class*="essay-answer"]', '[class*="subjective"]',
        '[class*="answer-content"]',
      ];
      for (const sel of cnEditorSelectors) {
        for (const el of scope.querySelectorAll(sel)) {
          el.querySelectorAll('textarea, input, [contenteditable="true"]').forEach(add);
          if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.contentEditable === 'true' || el.contentEditable === '') {
            add(el);
          }
        }
      }
      // 4d: Element UI 输入组件 (雨课堂常用)
      scope.querySelectorAll('.el-textarea__inner, .el-input__inner, [class*="el-input"], textarea.el-input__inner').forEach(el => {
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') add(el);
      });

      // 5. 按 ID 包含 editor/text/answer — 只添加可写元素
      scope.querySelectorAll('[id*="editor"], [id*="Editor"], [id*="text"], [id*="Text"], [id*="answer"], [id*="Answer"]').forEach(el => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'textarea' || tag === 'input' || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') {
          add(el);
        }
      });
      // 6. 所有 div[role="textbox"] 或具有 aria-multiline 的元素
      scope.querySelectorAll('[role="textbox"], [aria-multiline="true"], [class*="input"][contenteditable]').forEach(add);
      // 7. 在 iframe 内查找
      try {
        scope.querySelectorAll('iframe').forEach(iframe => {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (doc && doc.body) {
              // 递归查找 iframe 文档
              this._findEssayEditors(doc, depth + 1).forEach(add);
            }
          } catch (e2) {
            // cross-origin iframe — 尝试从主 window 的 frame 引用访问
            try {
              const idx = Array.from(scope.ownerDocument?.querySelectorAll('iframe') || []).indexOf(iframe);
              if (idx >= 0 && window.frames?.[idx]) {
                const fDoc = window.frames[idx].document;
                if (fDoc && fDoc.body) {
                  this._findEssayEditors(fDoc, depth + 1).forEach(add);
                }
              }
            } catch (e3) { /* still cross-origin */ }
          }
        });
      } catch (e) {}

      return results;
    }

    /** 解答题答案写入：多策略尝试写入富文本编辑器 */
    async _applyEssayAnswer(questionEl, searchText) {
      if (!searchText) return false;

      // 收集所有可写元素的诊断信息
      const diag = {
        tagNames: {}, selectors: {}, iframes: 0, visible: 0
      };

      // 查找编辑器：多次尝试，每轮扩大范围
      const findEditors = (scope) => this._findEssayEditors(scope);
      let editors = [];

      // 尝试3轮，每轮逐渐扩大搜索范围，间隔短暂等待给DOM渲染时间
      for (let round = 0; round < 3; round++) {
        if (round === 0) {
          editors = findEditors(questionEl);
        } else if (round === 1 && editors.length === 0 && this.pageContainer) {
          editors = findEditors(this.pageContainer);
        } else if (round === 2 && editors.length === 0) {
          editors = findEditors(document);
          // 也尝试在所有同域 iframe 中查找
          if (editors.length === 0) {
            try {
              for (let i = 0; i < Math.min(window.frames.length, 10); i++) {
                try {
                  const fDoc = window.frames[i].document;
                  if (fDoc) editors = findEditors(fDoc);
                  if (editors.length > 0) break;
                } catch (e) { /* cross-origin */ }
              }
            } catch (e) {}
          }
        }
        if (editors.length > 0) break;
        await new Promise(r => setTimeout(r, 300));
      }

      // 详细诊断输出
      if (editors.length === 0) {
        // 输出 questionEl 的完整结构诊断
        const qClass = (questionEl.className?.toString?.() || questionEl.getAttribute?.('class') || '').substring(0, 100);
        logger.warn('Quiz', `❌ 未找到编辑器! questionEl类名="${qClass}"`);
        logger.warn('Quiz', `questionEl标签=${questionEl.tagName} id=${questionEl.id || '无'}`);
        logger.warn('Quiz', `questionEl内含: textarea=${questionEl.querySelectorAll('textarea').length} contentEditable=${questionEl.querySelectorAll('[contenteditable]').length} input=${questionEl.querySelectorAll('input').length} iframe=${questionEl.querySelectorAll('iframe').length}`);
        // 检查整个页面有什么可写元素
        const pageTextareas = document.querySelectorAll('textarea').length;
        const pageEditable = document.querySelectorAll('[contenteditable="true"]').length;
        const pageIframes = document.querySelectorAll('iframe').length;
        logger.warn('Quiz', `全页面统计: textarea=${pageTextareas} contentEditable=${pageEditable} iframe=${pageIframes}`);
        // 列出前5个可见文本输入框
        let visIdx = 0;
        for (const el of document.querySelectorAll('textarea, [contenteditable="true"]')) {
          if (visIdx >= 5) break;
          if (el.offsetParent !== null || el.offsetHeight > 0) {
            const tag = el.tagName.toLowerCase();
            const cls = (el.className || '').substring(0, 60);
            const parentCls = (el.parentElement?.className || '').substring(0, 40);
            logger.warn('Quiz', `可见输入框#${visIdx + 1}: <${tag}> class="${cls}" 父类名="${parentCls}"`);
            visIdx++;
          }
        }
      } else {
        logger.info('Quiz', `✅ 找到 ${editors.length} 个编辑器:`,
          Array.from(editors).slice(0, 5).map(e =>
            `<${e.tagName.toLowerCase()}> class="${(e.className||'').substring(0,40)}" visible=${e.offsetParent !== null} editable=${e.contentEditable}`
          ).join(' | ')
        );
      }

      // 写入所有找到的编辑器
      for (const editor of editors) {
        const wrote = await this._writeToEditor(editor, searchText);
        if (wrote) {
          // 验证内容是否真的写入了
          const verifyText = (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') ? editor.value : editor.textContent;
          if (verifyText?.trim()?.length > 0) {
            logger.info('Quiz', `编辑器写入验证成功 (${editor.tagName}), 内容长度=${verifyText.length}`);
            return true;
          }
        }
      }

      // 兜底轮询（某些编辑器需要时间初始化）
      for (let retry = 0; retry < 5; retry++) {
        await new Promise(r => setTimeout(r, 500));
        editors = findEditors(document);
        if (editors.length > 0) {
          for (const editor of editors) {
            if (await this._writeToEditor(editor, searchText)) {
              const verifyText = (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') ? editor.value : editor.textContent;
              if (verifyText?.trim()?.length > 0) {
                logger.info('Quiz', `轮询${retry + 1}: 编辑器写入成功`);
                return true;
              }
            }
          }
        }
      }

      // 兜底: 查找任何可见的可写元素（即使 _findEssayEditors 漏掉了）
      const fallbacks = questionEl.querySelectorAll('[class*="text"], [class*="Text"], [class*="content"], [class*="answer"], [class*="edit"], [class*="input"], [class*="textarea"], .el-textarea__inner');
      for (const fb of fallbacks) {
        if (fb.tagName === 'TEXTAREA' || fb.tagName === 'INPUT' || fb.getAttribute('contenteditable') === 'true') {
          if (await this._writeToEditor(fb, searchText)) return true;
        }
      }

      // 终极兜底：尝试用 execCommand 插入任何可见的文本输入
      try {
        const activeEl = document.activeElement;
        const allEditable = document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"], [role="textbox"]');
        for (const el of allEditable) {
          if (el.offsetParent !== null || el.offsetHeight > 0) {
            el.focus({ preventScroll: true });
            try { el.select?.(); } catch(e) {}
            const edDoc = el.ownerDocument || document;
            const edWin = edDoc.defaultView || window;
            edDoc.execCommand('selectAll', false, null);
            edDoc.execCommand('insertText', false, searchText);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (activeEl && activeEl !== el) activeEl.focus({ preventScroll: true });
            logger.info('Quiz', 'execCommand终极写入成功');
            return true;
          }
        }
      } catch (e) {
        logger.warn('Quiz', 'execCommand终极写入失败:', e.message);
      }

      logger.warn('Quiz', '所有方案均无法写入编辑器, searchText前80=' + searchText.substring(0, 80));
      return false;
    }

    /** 向单个编辑器元素写入答案，尝试多种技术 */
    async _writeToEditor(editor, text) {
      if (!editor) return false;
      const tag = editor.tagName.toLowerCase();
      const isContentEditable = editor.getAttribute('contenteditable') === 'true' || editor.getAttribute('contenteditable') === '';
      const isInput = tag === 'textarea' || tag === 'input';

      try {
        if (isInput) {
          // 策略1: 原生 setter + 事件
          this._setTextValue(editor, text);
          editor.dispatchEvent(new Event('keydown', { bubbles: true }));
          editor.dispatchEvent(new Event('keyup', { bubbles: true }));
          // 触发 Vue v-model
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          editor.dispatchEvent(new Event('change', { bubbles: true }));
          // 尝试触发 element-plus / Element UI 响应
          const vueEl = editor.__vue__ || editor.closest?.('[class*="el-"]')?.__vue__;
          if (vueEl) {
            try { vueEl.$emit?.('input', text); } catch(e) {}
          }
          return true;
        }

        if (isContentEditable) {
          // 策略2: 直接设置 innerHTML（富文本编辑器需要 HTML）
          // 注意：有些编辑器用 textContent 不触发内部更新，需要用 innerHTML
          editor.focus({ preventScroll: true });

          // 2a: 用 execCommand 清除并插入（使用编辑器所属文档，支持iframe内编辑器）
          try {
            const editorDoc = editor.ownerDocument || document;
            const editorWin = editorDoc.defaultView || window;
            const sel = editorWin.getSelection();
            const range = editorDoc.createRange();
            range.selectNodeContents(editor);
            sel.removeAllRanges();
            sel.addRange(range);
            editorDoc.execCommand('delete', false, null);
            const htmlText = text.replace(/\n/g, '<br>');
            editorDoc.execCommand('insertHTML', false, htmlText);
            logger.info('Quiz', 'execCommand写入成功 (contentEditable)');
          } catch (e2) {
            // 2b: 直接用 innerHTML
            editor.innerHTML = text.replace(/\n/g, '<br>');
          }

          // 2c: 也设置 textContent 作为备份
          if (!editor.textContent?.trim()) {
            editor.textContent = text;
          }

          // 事件风暴：触发所有可能的事件类型
          const events = ['input', 'change', 'keydown', 'keyup', 'keypress', 'blur'];
          for (const evt of events) {
            editor.dispatchEvent(new Event(evt, { bubbles: true, cancelable: true }));
          }
          // 额外延迟再触发一次 input（有些框架需要）
          setTimeout(() => {
            editor.dispatchEvent(new Event('input', { bubbles: true }));
          }, 50);

          // 2d: 尝试触发 Vue 响应式（Element UI / element-plus）
          const vueWrapper = editor.closest('[class*="editor"], [class*="edit"], .ql-container, [class*="rich"], [class*="text"], .el-textarea, .w-e-text-container, [class*="w-e"]');
          if (vueWrapper) {
            vueWrapper.dispatchEvent(new Event('input', { bubbles: true }));
            try {
              const vueEl = vueWrapper.__vue__ || editor.__vue__;
              if (vueEl?.$emit) {
                vueEl.$emit('input', text);
                vueEl.$emit('change', text);
              }
              // 尝试找到 el-form 的 model 并直接更新
              const form = vueWrapper.closest('[class*="el-form"], .el-form');
              if (form?.__vue__?.$model) {
                // 尝试遍历更新
              }
            } catch(e) {}
          }

          // 2e: 尝试触发 React 的 onChange 模拟
          try {
            const nativeInputValue = Object.getOwnPropertyDescriptor(window.HTMLDivElement.prototype, 'textContent')?.set;
            if (nativeInputValue) {
              nativeInputValue.call(editor, text);
            }
          } catch(e) {}

          return true;
        }
      } catch (e) {
        logger.warn('Quiz', '_writeToEditor 失败:', e.message);
      }

      return false;
    }

    /**
     * 逐空写入并复查：考试页在 input/blur 后会重渲染或异步保存，
     * 同步批量写入容易被覆盖，所以每写一个空就等待，写完后重新读取实际 DOM 验证并补写。
     * 只有全部空都有值、且空数不超过答案段数时才返回 true。
     */
    async _fillBlanks(questionEl, parts) {
      const writeIndices = async (indices) => {
        for (const i of indices) {
          if (i >= parts.length) continue;
          const live = this._getFillInputs(questionEl);
          const inp = live[i];
          if (!inp) continue;
          try { inp.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
          // AI 偶尔会在答案首尾带 "/" 等备选分隔符，填入前去掉
          const text = String(parts[i] == null ? '' : parts[i]).replace(/^[\s/／|｜]+|[\s/／|｜]+$/g, '');
          this._setTextValue(inp, text);
          try { inp.blur(); } catch (e) { /* ignore */ }
          await DOM.sleep(180);
        }
      };

      await writeIndices(this._getFillInputs(questionEl).map((_, i) => i));

      for (let round = 0; round < 3; round++) {
        await DOM.sleep(400);
        const live = this._getFillInputs(questionEl);
        if (live.length === 0) return false;
        const emptyIdx = [];
        for (let i = 0; i < live.length; i++) {
          if (!(live[i].value || '').trim()) emptyIdx.push(i);
        }
        if (emptyIdx.length === 0) {
          if (live.length > parts.length) {
            logger.warn('Quiz', `填空题有${live.length}个空，但答案只有${parts.length}段`);
            return false;
          }
          return true;
        }
        const retryable = emptyIdx.filter(i => i < parts.length);
        if (retryable.length === 0 || round === 2) break;
        logger.warn('Quiz', `填空第 ${retryable.map(i => i + 1).join('、')} 空未写入，重试`);
        await writeIndices(retryable);
      }
      const finalLive = this._getFillInputs(questionEl);
      const pattern = finalLive.map(inp => (inp.value || '').trim() ? '✓' : '✗').join('');
      logger.warn('Quiz', `填空题未填满: ${pattern} (共${finalLive.length}空)`);
      return false;
    }

    _setTextValue(input, value) {
      try {
        const proto = input instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (nativeSetter?.set) {
          nativeSetter.set.call(input, value);
        } else {
          input.value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
      } catch (e) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    /** 获取填空题的可填写输入框（排除搜索框；有连续 data-blank-index 时按它排序） */
    _getFillInputs(questionEl) {
      const raw = questionEl.querySelectorAll('input:not([type]), input[type="text"], textarea');
      const list = Array.from(raw).filter(inp => {
        if (inp.disabled) return false;
        const cls = typeof inp.className === 'string' ? inp.className : '';
        const hint = cls + ' ' + (inp.getAttribute('placeholder') || '');
        if (/search|搜索/i.test(hint)) return false;
        return true;
      });
      if (list.length > 1) {
        const idxs = list.map(inp => parseInt(inp.getAttribute('data-blank-index'), 10));
        const isSequence = idxs.every(n => Number.isInteger(n)) &&
          idxs.slice().sort((a, b) => a - b).every((v, i) => v === i);
        if (isSequence) {
          return list.map((inp, i) => ({ inp, i: idxs[i] }))
            .sort((a, b) => a.i - b.i)
            .map(x => x.inp);
        }
      }
      return list;
    }

    /** 把多空答案文本拆成与空数匹配的片段；份数对不上时返回整段 */
    _splitFillParts(text, count) {
      if (count <= 1) return [text];
      const trySplit = (re) => {
        const parts = text.split(re).map(p => p.trim()).filter(p => p.length > 0 && p.length <= 300);
        return parts.length === count ? parts : null;
      };
      // 依次按 换行 / 分号 / 竖线 / 逗号 / 顿号 尝试，只有份数正好等于空数才采用
      for (const re of [/\r?\n/, /[；;]/, /\|/, /[，,]/, /、/]) {
        const parts = trySplit(re);
        if (parts) return parts;
      }
      // "1. xxx 2. yyy" / "①xxx ②yyy" 编号格式
      const numbered = text
        .split(/[(（]?[0-9一二三四五六七八九十]{1,2}[)）.、．:：]\s*|[①②③④⑤⑥⑦⑧⑨⑩]\s*/)
        .map(s => s.trim())
        .filter(Boolean);
      if (numbered.length === count) return numbered;
      return [text];
    }

    // ========== 高亮未作答题目 ==========
    /**
     * 跟随滚动到正在作答的题目：始终滚到视口正中间（作答前调用，填空也开始写之前就居中），
     * 700ms 节流 + 排队最后一次请求，避免并发作答时页面频繁跳动。
     */
    _followQuestion(questionEl) {
      if (!questionEl || !document.contains(questionEl)) return;

      const now = Date.now();
      const wait = 700 - (now - (this._lastFollowTs || 0));
      if (wait > 0) {
        this._pendingFollowEl = questionEl;
        if (!this._followTimer) {
          this._followTimer = setTimeout(() => {
            this._followTimer = null;
            const el = this._pendingFollowEl;
            this._pendingFollowEl = null;
            if (el) this._followQuestion(el);
          }, wait);
        }
        return;
      }
      this._lastFollowTs = now;
      try {
        questionEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) { /* ignore */ }
    }

    _highlightQuestions(questions) {
      if (questions.length === 0) { this._clearHighlights(); return; }
      GM_addStyle(`
        .ykh-need-manual {
          outline: 3px dashed #ff9800 !important;
          outline-offset: 4px;
          background: rgba(255,152,0,0.08) !important;
          position: relative;
        }
        .ykh-need-manual::before {
          content: "⚠ 需手动选择";
          position: absolute; top: -24px; left: 4px;
          background: #ff9800; color: #fff;
          font-size: 11px; padding: 2px 8px;
          border-radius: 4px;
          z-index: 99999;
          white-space: nowrap;
          box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }
        .ykh-unanswered-badge {
          position: absolute; top: -12px; right: -8px;
          background: #f44336; color: #fff;
          border-radius: 50%;
          width: 24px; height: 24px;
          font-size: 12px; line-height: 24px;
          text-align: center;
          z-index: 99998;
          box-shadow: 0 2px 4px rgba(0,0,0,0.3);
          pointer-events: none;
        }
        .ykh-float-counter {
          position: fixed; top: 80px; right: 20px;
          background: #f44336; color: #fff;
          padding: 8px 16px; border-radius: 20px;
          font-size: 14px; font-weight: bold;
          z-index: 999999;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          animation: ykh-pulse 2s ease-in-out infinite;
          pointer-events: none;
        }
        @keyframes ykh-pulse {
          0%, 100% { box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
          50% { box-shadow: 0 4px 20px rgba(244,67,54,0.6); }
        }
      `);
      // 先清除旧标记，避免重复调用时徽标叠加
      document.querySelectorAll('[data-ykh-badge]').forEach(el => el.remove());
      document.querySelectorAll('.ykh-need-manual').forEach(el => el.classList.remove('ykh-need-manual'));
      if (this._floatCounter) { this._floatCounter.remove(); this._floatCounter = null; }
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        q.el.classList.add('ykh-need-manual');
        // 添加序号标记 — 不要追加到编辑器内部，而是追加到题干区域或题目容器开头
        const badge = document.createElement('div');
        badge.className = 'ykh-unanswered-badge';
        badge.textContent = String(i + 1);
        badge.setAttribute('data-ykh-badge', '1');
        q.el.style.position = q.el.style.position || 'relative';
        // 找到题干的合适位置追加，避免 badge 出现在编辑器/答题框内
        const stemArea = q.el.querySelector('[class*="stem"], [class*="title"], [class*="topic"], h4, .item-body, .que_tit');
        if (stemArea && stemArea !== q.el) {
          stemArea.style.position = stemArea.style.position || 'relative';
          stemArea.appendChild(badge);
        } else {
          // 没有题干区 → 插入到容器最前面（而不是末尾，避免在编辑器内）
          q.el.insertBefore(badge, q.el.firstChild);
        }
      }
      // 浮动计数器
      this._floatCounter = document.createElement('div');
      this._floatCounter.className = 'ykh-float-counter';
      this._floatCounter.textContent = `未作答: ${questions.length} 题`;
      document.body.appendChild(this._floatCounter);
    }

    _clearHighlights() {
      document.querySelectorAll('.ykh-need-manual').forEach(el => {
        el.classList.remove('ykh-need-manual');
      });
      document.querySelectorAll('[data-ykh-badge]').forEach(el => el.remove());
      if (this._floatCounter) {
        this._floatCounter.remove();
        this._floatCounter = null;
      }
    }

    _notifyManualNeeded(remaining) {
      const types = {};
      for (const q of remaining) {
        types[q.qtype] = (types[q.qtype] || 0) + 1;
      }
      const parts = [];
      if (types.single) parts.push(`${types.single}道单选`);
      if (types.multi)  parts.push(`${types.multi}道多选`);
      if (types.judge)  parts.push(`${types.judge}道判断`);
      if (types.fill)   parts.push(`${types.fill}道填空`);
      if (types.essay)  parts.push(`${types.essay}道解答`);

      this.ui.log('');
      this.ui.log(`┌─────────────────────────────`);
      this.ui.log(`│ ⚠️  需要手动作答: ${parts.join('、')}`);
      this.ui.log(`│ 📝 请在页面上选择/填写正确答案`);
      this.ui.log(`│ 📌 面板"未完成题目"可点击定位，作答后自动打勾`);
      this.ui.log(`│ ✅ 试卷需你自己提交，脚本不会自动交卷`);
      this.ui.log(`└─────────────────────────────`);
      this.ui.log('');
    }

    // ========== 辅助方法 ==========
    findQuestionItems(container) {
      const selectors = [
        '[class*="exercise-item"]',  // Element UI 考试系统（内容区题目包裹）
        '[class*="question-item"]', '[class*="topic"]', '.que_row',
        '[class*="problem-item"]', '[class*="subject-item"]',
        '[class*="question-wrapper"]', '[class*="question_block"]',
        '[class*="questionLi"]', '[class*="question_li"]',
        '[class*="exam-item"]', '[class*="quiz-item"]',
        '[class*="test-item"]', '[class*="answer-item"]',
        '[class*="questionBox"]', '[class*="question-box"]',
        '[class*="single-item"]', '[class*="multi-item"]',
        '[class*="judge-item"]', '[class*="fill-item"]',
        'fieldset', '[class*="fieldset"]',
        '[class*="question-container"]', '[class*="questionContainer"]',
        '[class*="question-wrap"]', '[class*="questionWrap"]',
        '[data-type*="question"]', '[data-qid]',
        '[class*="que_"]', '[id*="que_"]',
        '.que-item', '[class*="que-item"]', '[class*="ques-item"]', '[class*="ques_item"]',
        // 雨课堂/国内平台常见题目包裹
        '[class*="subject-info"]',
        '[class*="paper-item"]',
        '[class*="exam-question"]', '[class*="test-question"]',
        '[class*="que-item"]', '[class*="item-question"]',
      ];
      for (const sel of selectors) {
        const items = container.querySelectorAll(sel);
        // 过滤假题目（如侧边栏只有题号的 .subject-item）
        const realItems = Array.from(items).filter(el => this._isRealQuestion(el));
        if (realItems.length > 0) return realItems;
      }

      // 没找到标准题目项，尝试按逻辑边界拆分
      const splitItems = this._splitContainerIntoQuestions(container);
      if (splitItems.length > 0) return splitItems;

      // 最后兜底：如果容器内确实有题目元素，把整个容器当一道题
      if (this.hasQuestions(container)) return [container];
      return [];
    }

    /** 判断是否是真题目（过滤侧边栏题号等假元素） */
    _isRealQuestion(el) {
      const text = (el.textContent || '').trim();
      // 只有纯数字（1-200）且无选项元素 → 侧边栏题号，不是真题目
      if (/^\d{1,3}$/.test(text) && el.querySelectorAll('ul, input, label.el-radio, label.el-checkbox, .item-type, .item-body').length === 0) {
        return false;
      }
      return true;
    }

    /**
     * 将容器内的题目按逻辑边界拆分
     * 根据 radio/checkbox 组、textarea、填空题输入框等自然边界拆分
     */
    _splitContainerIntoQuestions(container) {
      const items = [];

      // 策略A：按 fieldset 或带 legend 的分组拆分
      const fieldsets = container.querySelectorAll('fieldset, [class*="fieldset"], [class*="question-group"], [class*="questionGroup"]');
      if (fieldsets.length >= 1) {
        return Array.from(fieldsets);
      }

      // 策略B：按 radio group 拆分 — 每组 radio (同name) 是一道题
      const radioGroups = new Map();
      const allRadios = container.querySelectorAll('input[type="radio"]');
      for (const radio of allRadios) {
        const name = radio.getAttribute('name') || radio.id || '';
        if (!radioGroups.has(name)) radioGroups.set(name, []);
        radioGroups.get(name).push(radio);
      }
      if (radioGroups.size >= 1) {
        for (const [name, radios] of radioGroups) {
          // 找到包含这组radio的最近公共祖先作为题目容器
          const wrapper = this._findCommonAncestor(radios, container);
          if (wrapper && !items.includes(wrapper)) {
            items.push(wrapper);
          }
        }
      }

      // 策略C：按 checkbox 组拆分
      const checkboxClusters = this._clusterCheckboxGroups(container);
      for (const cluster of checkboxClusters) {
        if (!items.includes(cluster)) {
          items.push(cluster);
        }
      }

      // 策略D：找独立的 textarea（填空/解答题）
      const textareas = container.querySelectorAll('textarea');
      for (const ta of textareas) {
        // 查找包含此textarea的独立题目包裹元素
        const wrapper = ta.closest('[class*="question"], [class*="topic"], [class*="item"], [class*="wrap"], [class*="block"], [class*="row"], div');
        if (wrapper && !items.includes(wrapper)) {
          // 确保这个wrapper不包含已在items中的元素
          const isSubset = items.some(item => item.contains(wrapper) || wrapper.contains(item));
          if (!isSubset) {
            items.push(wrapper);
          }
        }
      }

      // 策略E：找独立文本输入（填空题，排除搜索框）
      const textInputs = container.querySelectorAll('input[type="text"]:not([class*="search"]):not([placeholder*="搜索"]):not([placeholder*="search"])');
      for (const inp of textInputs) {
        const wrapper = inp.closest('[class*="question"], [class*="topic"], [class*="item"], [class*="wrap"], [class*="block"], [class*="row"], div');
        if (wrapper && !items.includes(wrapper)) {
          const isSubset = items.some(item => item.contains(wrapper) || wrapper.contains(item));
          if (!isSubset) {
            items.push(wrapper);
          }
        }
      }

      // 策略F：找 contenteditable 富文本编辑器（解答题常用 wangEditor/Quill）
      const editableEditors = container.querySelectorAll('[contenteditable="true"], .w-e-text, .ql-editor, [class*="w-e-text"]');
      for (const ed of editableEditors) {
        const wrapper = ed.closest('[class*="question"], [class*="topic"], [class*="item"], [class*="wrap"], [class*="block"], [class*="row"], div');
        if (wrapper && !items.includes(wrapper)) {
          const isSubset = items.some(item => item.contains(wrapper) || wrapper.contains(item));
          if (!isSubset) {
            items.push(wrapper);
          }
        }
      }

      return items;
    }

    /** 找一组元素的最近公共祖先 */
    _findCommonAncestor(elements, maxParent) {
      if (elements.length === 0) return null;
      if (elements.length === 1) {
        let el = elements[0].parentElement;
        while (el && el !== maxParent && el !== document.body) {
          const tag = el.tagName.toLowerCase();
          if (tag === 'fieldset' || el.className && (
            /question|topic|item|problem|exam|quiz/i.test(el.className.toString())
          )) {
            return el;
          }
          el = el.parentElement;
        }
        return elements[0].closest('div, li, fieldset') || elements[0].parentElement;
      }
      // 找所有元素公共祖先
      const getAncestors = (el) => {
        const ancestors = [];
        let current = el.parentElement;
        while (current && current !== maxParent && current !== document.body) {
          ancestors.push(current);
          current = current.parentElement;
        }
        return ancestors;
      };
      const firstAncestors = getAncestors(elements[0]);
      for (const ancestor of firstAncestors) {
        if (elements.every(el => ancestor.contains(el))) {
          return ancestor;
        }
      }
      return elements[0].closest('div, li, fieldset') || elements[0].parentElement;
    }

    /** 将checkbox按邻近关系聚类，每组是一道多选题 */
    _clusterCheckboxGroups(container) {
      const clusters = [];
      const allChecks = Array.from(container.querySelectorAll('input[type="checkbox"]'));
      if (allChecks.length === 0) return clusters;

      const used = new Set();
      for (let i = 0; i < allChecks.length; i++) {
        if (used.has(i)) continue;
        const cluster = [allChecks[i]];
        used.add(i);
        // 找同组的checkbox（邻近或同父元素）
        for (let j = i + 1; j < allChecks.length; j++) {
          if (used.has(j)) continue;
          const a = allChecks[i];
          const b = allChecks[j];
          // 同父元素或共享最近祖先
          if (a.parentElement === b.parentElement ||
              a.closest('fieldset') === b.closest('fieldset') ||
              a.closest('[class*="option"]')?.parentElement === b.closest('[class*="option"]')?.parentElement) {
            cluster.push(allChecks[j]);
            used.add(j);
          }
        }
        const wrapper = this._findCommonAncestor(cluster, container);
        if (wrapper) clusters.push(wrapper);
      }
      return clusters;
    }

    _dumpPageDiagnostics(items) {
      const maxShow = Math.min(5, this.pageQuestions.length);
      this.ui.log('--- DOM诊断开始 (前' + maxShow + '题) ---');
      for (let i = 0; i < maxShow; i++) {
        const q = this.pageQuestions[i];
        const el = q.el;
        const cn = (el.className?.toString?.() || el.getAttribute?.('class') || '').substring(0, 80);
        const hasRadio = el.querySelectorAll('input[type="radio"]').length;
        const hasCheck = el.querySelectorAll('input[type="checkbox"]').length;
        const hasTextarea = el.querySelectorAll('textarea').length;
        const hasTextInput = el.querySelectorAll('input[type="text"]:not([class*="search"])').length;
        const hasCbClass = el.querySelectorAll('[class*="checkbox"]').length;
        const hasRadioClass = el.querySelectorAll('[class*="radio"]').length;
        const ulTypes = [];
        const uls = el.querySelectorAll('ul');
        for (const u of uls) {
          const uc = u.className?.toString?.() || '';
          if (uc.includes('checkbox')) ulTypes.push('ul.checkbox');
          if (uc.includes('radio')) ulTypes.push('ul.radio');
          if (uc.includes('unstyled')) ulTypes.push('ul.unstyled');
        }
        const optEls = this._getOptionElements(el);
        const optTexts = optEls.slice(0, 4).map(o => DOM.getText(o).substring(0, 40));
        const optClasses = optEls.slice(0, 4).map(o => (o.className?.toString?.() || o.getAttribute?.('class') || '').substring(0, 40));

        this.ui.log(`[题${i + 1}] 类型:${q.qtype} 题干:${q.stem.substring(0, 50)}`);
        this.ui.log(`  元素类名: ${cn || '(无)'}`);
        this.ui.log(`  inputs: radio×${hasRadio} check×${hasCheck} textarea×${hasTextarea} text×${hasTextInput}`);
        this.ui.log(`  class含: checkbox×${hasCbClass} radio×${hasRadioClass}`);
        this.ui.log(`  UL类型: ${ulTypes.join(', ') || '(无UL)'}`);
        this.ui.log(`  选项数:${optEls.length} 选项文本: [${optTexts.join(' | ')}]`);
        this.ui.log(`  选项类名: [${optClasses.join(' | ')}]`);
      }
      this.ui.log('--- DOM诊断结束 ---');
    }

    getQuestionStem(questionEl) {
      const stemSelectors = [
        // Element UI 考试系统：题干在 h4.exam-font 里
        '.item-body h4', '.item-body [class*="exam-font"]', 'h4',
        '[class*="stem"]', '[class*="title"]', '[class*="content"]',
        '.que_tit', '[class*="question-text"]', '[class*="question_title"]',
        '[class*="topic-content"]'
      ];
      for (const sel of stemSelectors) {
        const el = questionEl.querySelector(sel);
        if (el) {
          const text = DOM.getText(el);
          if (text.length > 3) return this._cleanStemText(text);
        }
      }
      const fullText = DOM.getText(questionEl);
      const optionTexts = this.getOptionLabels(questionEl);
      let stem = fullText;
      for (const opt of optionTexts) stem = stem.replace(opt, '');
      return this._cleanStemText(stem.trim()) || this._cleanStemText(fullText);
    }

    /** 清理题干中的系统提示文字（toast/弹窗等混入的文本） */
    _cleanStemText(text) {
      if (!text) return '';
      // 去掉常见的系统提示/保存成功等toast文字
      const noisePatterns = [
        /答案保存成功/g,
        /保存成功/g,
        /提交成功/g,
        /答题卡/g,
        /展开\s*\d+\s*\/\d+题/g,
        /已答/g,
        /未答/g,
        /剩余时间[：:]\s*\d+/g,
        /倒计时[：:]\s*\d+/g,
        /自动保存/g,
        /\d+\/\d+/g,
      ];
      let cleaned = text;
      for (const pat of noisePatterns) {
        cleaned = cleaned.replace(pat, '');
      }
      return cleaned.replace(/\s+/g, ' ').trim();
    }

    getOptionIndexOrValue(optionEl, container) {
      const allRadios = container.querySelectorAll('input[type="radio"]');
      const allChecks = container.querySelectorAll('input[type="checkbox"]');
      const allOptions = allRadios.length > 0 ? allRadios : allChecks;
      if (allOptions.length > 0) {
        const idx = Array.from(allOptions).indexOf(optionEl);
        if (idx >= 0) return { index: idx, value: optionEl.value || '' };
      }
      const text = DOM.getText(optionEl);
      if (text) return { text: text };
      return { value: optionEl.value || optionEl.getAttribute('data-value') || '' };
    }

    }

  // ============================================================
  //  NAVIGATION HANDLER
  // ============================================================
  class NavigationHandler {
    constructor(ui) {
      this.ui = ui;
      this.isHandling = false;
      this.lastUrl = location.href;
      this.coursePageUrl = location.href; // 课程主页URL（有单元列表的页面）
      this.chapterItems = [];
      this.currentChapterIndex = -1;
    }

    start() {
      this.isHandling = true;
      this.lastUrl = location.href;
      this.coursePageUrl = location.href;
      if (this._isExamPage()) {
        logger.info('Nav', '当前是考试页面，跳过课程导航扫描');
        return;
      }
      this.scanChapters();
    }

    stop() {
      this.isHandling = false;
    }

    scanChapters() {
      if (this._isExamPage()) return [];
      return this._scanChaptersInternal(false);
    }

    /** 考试页面：禁止课程导航，避免误点侧边栏或离开试卷 */
    _isExamPage() {
      return /(^|\.)changjiang-exam\.yuketang\.cn$/i.test(location.hostname) ||
             /^\/exam\//i.test(location.pathname);
    }

    _scanChaptersInternal(isRetry) {
      const EXCLUDE_PATTERNS = /课程班级|资源库|AI空间|消息|通知|设置|退出|帮助|关于|个人|账户|首页|搜索|全部课程|我的课程|考试|成绩|统计|管理|讨论|公告|论坛|答疑|资料|下载/i;
      // 只匹配"Unit X"或"第X单元"这种明确的课程单元标题，去掉 ^\d+[.、．)\s] 太宽泛
      const UNIT_PATTERNS = /^Unit\s*\d+|^第\d+单元|^第\d+章|^第\d+节|^Chapter\s*\d+|^Lesson\s*\d+/i;
      const MAX_ITEMS = 50; // 章节数不会超过50

      // === 第1步：找到侧边栏/目录容器 ===
      // 只在侧边栏/导航区域扫描，不扫描整个页面
      let sidebarContainer = null;
      const sidebarSelectors = [
        'aside', 'nav',
        '[class*="sidebar"]', '[class*="catalog"]', '[class*="menu"]',
        '[class*="directory"]', '[class*="tree"]', '[class*="lesson-list"]',
        '[class*="chapter-list"]', '[class*="unit-list"]', '[class*="course-list"]',
        '[class*="outline"]', '[class*="syllabus"]',
        '[class*="el-menu"]', '[class*="ant-menu"]',
        '[class*="left-panel"]', '[class*="left_panel"]',
        '[class*="panel-left"]', '[class*="panel_left"]',
      ];
      for (const sel of sidebarSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          // 检查这个容器里是否有多个类似列表项的内容
          const itemCount = el.querySelectorAll('li, [class*="item"], [class*="node"]').length;
          if (itemCount >= 2) {
            sidebarContainer = el;
            logger.info('Nav', `找到侧边栏: <${el.tagName}> class="${(el.className?.toString?.()||'').substring(0,60)}" items=${itemCount}`);
            break;
          }
        }
      }

      // 如果没找到专用侧边栏，尝试找页面左侧的固定面板
      if (!sidebarContainer) {
        const candidates = document.querySelectorAll('div, section, ul');
        for (const el of candidates) {
          if (el.offsetParent === null) continue;
          const rect = el.getBoundingClientRect();
          // 左侧面板特征：宽度100-500px，高度>300px，靠左
          if (rect.width >= 100 && rect.width <= 500 && rect.height > 300 && rect.left < 100) {
            const items = el.querySelectorAll('li, [class*="item"], [class*="node"]');
            if (items.length >= 2 && items.length <= MAX_ITEMS) {
              sidebarContainer = el;
              logger.info('Nav', `通过位置推测侧边栏: <${el.tagName}> class="${(el.className?.toString?.()||'').substring(0,60)}"`);
              break;
            }
          }
        }
      }

      // === 第2步：在侧边栏容器内扫描章节 ===
      const searchRoot = sidebarContainer || document.body;
      const isFullPage = !sidebarContainer;
      if (isFullPage) {
        logger.info('Nav', '未找到明确的侧边栏，将在有限范围内搜索');
      }

      // 容器内的物品选择器（更精确的）
      const itemSelectors = [
        '[class*="leaf-item"]', '[class*="leaf_item"]',
        '[class*="unit-item"]', '[class*="unit_item"]',
        '[class*="chapter-item"]', '[class*="lesson-item"]',
        '[class*="section-item"]', '[class*="knowledge-item"]',
        '[class*="catalog-item"]', '[class*="courseware-item"]',
        '[class*="tree-node"]', '[class*="tree_item"]',
        '[class*="el-tree-node"]',
        'li[class*="item"]', 'li[class*="node"]',
        'li', // 最后通用
      ];

      let allCandidates = [];

      for (const sel of itemSelectors) {
        const items = searchRoot.querySelectorAll(sel);
        const filtered = Array.from(items).filter(el => {
          const text = DOM.getText(el);
          if (!text || text.length < 2 || text.length > 200) return false;
          if (EXCLUDE_PATTERNS.test(text)) return false;
          if (el.tagName === 'BUTTON' && text.length < 3) return false;
          // 必须可见
          if (el.offsetParent === null && el.getClientRects().length === 0) return false;
          return true;
        });
        if (filtered.length >= 2 && filtered.length <= MAX_ITEMS) {
          allCandidates = filtered;
          logger.info('Nav', `选择器 "${sel}" 匹配到 ${filtered.length} 项`);
          break;
        }
      }

      // 如果没找到合适的直接匹配，在sidebar内找所有li
      if (allCandidates.length < 2 && sidebarContainer) {
        const allItems = sidebarContainer.querySelectorAll('li, [class*="item"], [class*="node"], [class*="row"]');
        allCandidates = Array.from(allItems).filter(el => {
          const text = DOM.getText(el);
          if (!text || text.length < 2 || text.length > 200) return false;
          if (EXCLUDE_PATTERNS.test(text)) return false;
          return true;
        });
        if (allCandidates.length > MAX_ITEMS) {
          // 太多结果说明匹配到了不该匹配的内容
          logger.info('Nav', `侧边栏li匹配过多(${allCandidates.length})，尝试用Unit模式过滤`);
          allCandidates = allCandidates.filter(el => UNIT_PATTERNS.test(DOM.getText(el)));
        }
      }

      // 找不到结果：全页搜索Unit文字
      if (allCandidates.length < 2) {
        logger.info('Nav', '容器内扫描结果不足，启动全页Unit搜索...');
        const unitEls = this._findUnitsByTextSearch();
        if (unitEls.length >= 2 && unitEls.length <= MAX_ITEMS) {
          allCandidates = unitEls;
          this.ui.log(`📖 全页搜索找到 ${unitEls.length} 个学习单元`);
        } else {
          this._dumpPageElements();
          if (!isRetry) {
            logger.info('Nav', '延迟2秒后重试扫描（等待SPA渲染）...');
            setTimeout(() => {
              logger.info('Nav', '执行延迟重试扫描...');
              this._scanChaptersInternal(true);
            }, 2000);
          }
        }
      }

      // 去重+构建chapterItems
      const unitItems = allCandidates.filter(el => UNIT_PATTERNS.test(DOM.getText(el)));
      const otherItems = allCandidates.filter(el => !UNIT_PATTERNS.test(DOM.getText(el)));

      const seen = new Set();
      this.chapterItems = [];
      for (const el of [...unitItems, ...otherItems]) {
        if (this.chapterItems.length >= MAX_ITEMS) break;
        const text = DOM.getText(el).substring(0, 100);
        if (!seen.has(text)) {
          seen.add(text);
          this.chapterItems.push(el);
        }
      }

      // Unit匹配的优先
      if (unitItems.length >= 2 && unitItems.length <= MAX_ITEMS) {
        this.chapterItems = [...new Map(unitItems.map(el => [DOM.getText(el).substring(0, 100), el])).values()];
      }

      logger.info('Nav', `扫描到 ${this.chapterItems.length} 个章节/任务 (Unit匹配:${unitItems.length}, 其他:${otherItems.length})`);

      if (this.chapterItems.length > 0) {
        this.ui.log(`📖 扫描到 ${this.chapterItems.length} 个学习任务`);
        const names = this.chapterItems.slice(0, 10).map(el => DOM.getText(el).substring(0, 40));
        logger.info('Nav', '任务列表:', names);
      } else if (isRetry) {
        logger.info('Nav', '重试扫描仍未找到课程单元');
        this._dumpPageElements();
      }

      this.identifyCurrentChapter();
      return this.chapterItems;
    }

    identifyCurrentChapter() {
      for (let i = 0; i < this.chapterItems.length; i++) {
        const item = this.chapterItems[i];
        const cls = (item.className?.toString() || '') + ' ' +
                    (item.parentElement?.className?.toString() || '');
        // 检查各种"当前/激活"标记
        if (/active|current|selected|playing|ongoing|now|open|expanded/i.test(cls)) {
          this.currentChapterIndex = i;
          return;
        }
        // 检查子元素
        const activeChild = item.querySelector('[class*="active"], [class*="current"], [class*="selected"], [class*="playing"]');
        if (activeChild) {
          this.currentChapterIndex = i;
          return;
        }
      }
      // 找第一个未完成的
      for (let i = 0; i < this.chapterItems.length; i++) {
        const item = this.chapterItems[i];
        const text = DOM.getText(item);
        if (!/已完成|已完成|100%|complete|done|finished|pass/i.test(text)) {
          this.currentChapterIndex = i;
          return;
        }
      }
      // 默认从第一个开始
      this.currentChapterIndex = 0;
    }

    async goToNext() {
      if (!this.isHandling) return false;
      if (this._isExamPage()) return false;
      const urlBefore = location.href;

      // 如果当前不在课程主页（可能在视频页面），先尝试返回课程主页
      if (!this._isOnCoursePage()) {
        this.ui.log('当前不在课程主页，尝试返回...');
        if (await this._goBackToCoursePage(urlBefore)) {
          return true;
        }
      }

      // 在课程主页上：重新扫描章节
      this.scanChapters();
      if (this.chapterItems.length === 0) {
        this.ui.log('未找到课程单元，尝试URL导航作为兜底', 'warn');
        // 兜底：尝试URL参数递增
        if (await this.tryUrlNavigationFallback(urlBefore)) {
          return true;
        }
        return false;
      }

      // 找到当前章节
      this.identifyCurrentChapter();
      const nextIdx = this.currentChapterIndex >= 0 ? this.currentChapterIndex + 1 : 0;
      if (nextIdx >= this.chapterItems.length) {
        this.ui.log('已完成所有单元');
        // 如果启用了跨课程模式，尝试进入下一门课程
        if (this.ui.isCrossCourse()) {
          this.ui.log('📚 当前课程所有单元完成，尝试进入下一门课程...');
          this.markCurrentCourseFinished();
          return await this.goToNextCourse();
        }
        return false;
      }

      // 目标单元
      const targetItem = this.chapterItems[nextIdx];
      const targetText = DOM.getText(targetItem).substring(0, 60);
      this.ui.log(`导航到: ${targetText}`);

      // 步骤1：展开目标单元（如果已收起）
      const expanded = await this._expandUnit(targetItem);
      if (!expanded) {
        this.ui.log(`无法展开单元: ${targetText}`, 'warn');
        return false;
      }

      // 步骤2：在展开的单元中找视频/学习任务并点击
      const taskClicked = await this._clickTaskInUnit(targetItem, urlBefore);
      if (taskClicked) {
        this.lastUrl = location.href;
        this.currentChapterIndex = nextIdx;
        return true;
      }

      // 步骤3：如果单元内找不到任务，尝试直接点击单元本身
      const clickable = targetItem.querySelector('a, button') || targetItem;
      this.ui.log(`直接点击单元: ${targetText}`);
      DOM.safeClick(clickable);
      await DOM.sleep(2500);
      if (location.href !== urlBefore) {
        this.lastUrl = location.href;
        this.currentChapterIndex = nextIdx;
        return true;
      }

      this.ui.log(`导航失败: ${targetText}`, 'warn');
      return false;
    }

    /** 检查是否在课程主页（有单元列表的页面） */
    _isOnCoursePage() {
      // URL匹配：课程主页通常包含 studentLog 或 classroom_id
      const currentUrl = location.href;
      if (currentUrl === this.coursePageUrl) return true;
      // 检查页面上是否有多个课程单元
      const unitCount = document.querySelectorAll('[class*="unit"], [class*="chapter"], [class*="lesson"], [class*="leaf"]').length;
      if (unitCount >= 2) {
        this.coursePageUrl = currentUrl; // 更新课程主页URL
        return true;
      }
      return false;
    }

    /** 返回课程主页 */
    async _goBackToCoursePage(urlBefore) {
      // 策略0：长江雨课堂专用返回按钮 .header-bar .f14.back
      const platformBack = document.querySelector('.header-bar .f14.back');
      if (platformBack && platformBack.offsetParent !== null) {
        this.ui.log('点击平台返回按钮 (.header-bar .f14.back)...');
        DOM.safeClick(platformBack);
        await DOM.sleep(2500);
        if (location.href !== urlBefore) {
          this.lastUrl = location.href;
          return true;
        }
      }

      // 策略1：通用"返回"按钮
      const backSelectors = [
        '[class*="back"]', '[class*="return"]', '[class*="go-back"]',
        'button', 'a', 'span', 'i[class*="arrow-left"]',
        '[class*="icon-back"]', '[class*="icon_left"]',
      ];
      const backPatterns = /返回|后退|back|return/i;
      for (const sel of backSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.offsetParent === null) continue;
          const text = DOM.getText(el);
          const cls = (el.className?.toString() || '');
          if (backPatterns.test(text) || backPatterns.test(cls)) {
            this.ui.log('点击返回按钮...');
            DOM.safeClick(el);
            await DOM.sleep(2500);
            if (location.href !== urlBefore) {
              this.lastUrl = location.href;
              return true;
            }
          }
        }
      }

      // 策略2：浏览器后退
      this.ui.log('使用浏览器后退...');
      history.back();
      await DOM.sleep(3000);
      if (location.href !== urlBefore) {
        this.lastUrl = location.href;
        return true;
      }

      // 策略3：直接跳转课程主页URL
      if (this.coursePageUrl && this.coursePageUrl !== location.href) {
        this.ui.log('跳转回课程主页...');
        location.href = this.coursePageUrl;
        await DOM.sleep(3000);
        return true;
      }

      return false;
    }

    /** 展开折叠的单元 */
    async _expandUnit(unitEl) {
      // 策略0：长江雨课堂专用 "展开" 按钮 span.blue.ml20
      const expandSpans = document.querySelectorAll('span.blue.ml20');
      for (const span of expandSpans) {
        if (span.offsetParent !== null && span.textContent.includes('展开')) {
          logger.info('Nav', '点击平台展开按钮 (span.blue.ml20)');
          DOM.safeClick(span);
          await DOM.sleep(1000);
          // 检查是否展开成功
          const newChildTasks = unitEl.querySelectorAll('a, button, [class*="task"], [class*="video"], [class*="learn"]');
          const nowVisible = Array.from(newChildTasks).some(el => el.offsetParent !== null && DOM.getText(el).length > 1);
          if (nowVisible) return true;
        }
      }

      // 检查是否已展开
      const cls = (unitEl.className?.toString?.() || unitEl.className || '');
      const isExpanded = unitEl.querySelector('[class*="expanded"], [class*="open"], [class*="active"]') ||
                         /展开|收起|collapse|expand|open|expanded/i.test(cls);
      // 如果单元内有可见的子任务或是链接，说明已展开或无需展开
      const childTasks = unitEl.querySelectorAll('a, button, [class*="task"], [class*="video"], [class*="learn"], [class*="lesson"], [class*="leaf"]');
      const hasVisibleTask = Array.from(childTasks).some(el => el.offsetParent !== null && DOM.getText(el).length > 1);
      if (hasVisibleTask) {
        logger.info('Nav', `单元已展开，有${Array.from(childTasks).filter(el => el.offsetParent !== null).length}个可见子任务`);
        return true;
      }

      // 策略1：点击单元本身（很多SPA通过点击行来展开）
      logger.info('Nav', `尝试展开单元: ${DOM.getText(unitEl).substring(0, 40)}`);
      DOM.safeClick(unitEl);
      await DOM.sleep(800);

      // 策略2：查找展开按钮/箭头图标
      const expandSelectors = [
        '[class*="expand"]', '[class*="toggle"]', '[class*="arrow"]',
        '[class*="switch"]', '[class*="chevron"]', '[class*="caret"]',
        '[class*="icon-right"]', '[class*="icon_down"]', '[class*="icon_right"]',
        'i', 'svg', 'span[class*="icon"]', 'span[class*="btn"]',
        '[class*="trigger"]', '[class*="handler"]',
      ];
      let expandBtn = null;
      for (const sel of expandSelectors) {
        const el = unitEl.querySelector(sel);
        if (el && el !== unitEl) {
          expandBtn = el;
          break;
        }
      }
      if (expandBtn && expandBtn !== unitEl.querySelector('a, button')) {
        DOM.safeClick(expandBtn);
        await DOM.sleep(800);
      }

      // 策略3：查找"展开"文字
      const allChildren = unitEl.querySelectorAll('*');
      for (const child of allChildren) {
        const childText = DOM.getText(child).trim();
        if (childText === '展开' || childText === '展开▼' || childText === '>' || childText === '▼') {
          DOM.safeClick(child);
          await DOM.sleep(800);
          break;
        }
      }

      // 策略4：点击单元内的第一个链接/按钮（可能是展开触发器）
      const innerClickable = unitEl.querySelector('a, button, [class*="btn"], [class*="click"]');
      if (innerClickable && innerClickable !== expandBtn) {
        DOM.safeClick(innerClickable);
        await DOM.sleep(800);
      }

      await DOM.sleep(1000); // 额外等待SPA渲染

      // 再次检查
      const newChildTasks = unitEl.querySelectorAll('a, button, [class*="task"], [class*="video"], [class*="learn"], [class*="lesson"], [class*="leaf"]');
      const nowHasVisible = Array.from(newChildTasks).some(el => el.offsetParent !== null && DOM.getText(el).length > 1);
      if (nowHasVisible) {
        logger.info('Nav', `展开成功，现在有可见子任务`);
        return true;
      }

      // 即使检测不到可见任务也返回true，可能是结构特殊
      logger.info('Nav', `展开操作完成但未检测到可见子任务，继续后续流程`);
      return true;
    }

    /** 在展开的单元中找视频/学习任务并点击 */
    async _clickTaskInUnit(unitEl, urlBefore) {
      // 记录点击前的DOM状态（用于SPA检测）
      const bodyBefore = document.body.innerHTML.length;
      const videoCountBefore = document.querySelectorAll('video').length;

      // 在单元内找子任务链接
      const taskSelectors = [
        'a', 'button',
        '[class*="task"]', '[class*="video"]', '[class*="learn"]',
        '[class*="study"]', '[class*="content"]', '[class*="lesson"]',
        '[class*="courseware"]', '[class*="knowledge"]',
        'li a', 'li button', 'li[class*="item"]',
        '[class*="child"] a', '[class*="child"] button',
        '[class*="sub"] a', '[class*="sub"] button',
        '[class*="leaf-item"]', '[class*="leaf_item"]',
        '[class*="cell"]', '[class*="row"]',
      ];

      for (const sel of taskSelectors) {
        const tasks = unitEl.querySelectorAll(sel);
        for (const task of tasks) {
          if (task === unitEl) continue;
          if (task.offsetParent === null) continue;
          const text = DOM.getText(task);
          if (text === '展开' || text === '收起' || text === '展开▼' || text === '收起▲') continue;
          if (text.length >= 1 && text.length <= 200) {
            this.ui.log(`点击任务: ${text.substring(0, 50)}`);
            DOM.safeClick(task);
            await DOM.sleep(3500);

            // 检测导航是否发生（URL变化或DOM大变化）
            if (location.href !== urlBefore) {
              this.ui.log('已跳转到任务页面');
              return true;
            }
            // SPA检测：body内容显著变化 或 出现了视频播放器
            const bodyAfter = document.body.innerHTML.length;
            const videoCountAfter = document.querySelectorAll('video').length;
            const bodyChanged = Math.abs(bodyAfter - bodyBefore) > 5000;
            const videoAppeared = videoCountAfter > videoCountBefore;
            if (bodyChanged || videoAppeared) {
              this.ui.log('检测到页面内容变化（SPA导航）');
              return true;
            }
          }
        }
      }

      // 如果单元内没有独立任务，尝试直接点击单元内的链接
      const unitLink = unitEl.querySelector('a') || unitEl.closest('a');
      if (unitLink && unitLink !== unitEl) {
        DOM.safeClick(unitLink);
        await DOM.sleep(3500);
        if (location.href !== urlBefore) return true;
        const bodyAfter = document.body.innerHTML.length;
        if (Math.abs(bodyAfter - bodyBefore) > 5000) return true;
      }

      // 最后尝试：点击单元本身
      DOM.safeClick(unitEl);
      await DOM.sleep(3500);
      if (location.href !== urlBefore) return true;
      const bodyAfter = document.body.innerHTML.length;
      if (Math.abs(bodyAfter - bodyBefore) > 5000) return true;

      return false;
    }

    async tryUrlNavigation() {
      const url = location.href;
      const patterns = [
        /(\d+)\/(\d+)$/,      // .../chapter/3/5
        /[?&]page=(\d+)/,     // ...?page=3
        /[?&]index=(\d+)/,    // ...?index=3
        /[?&]number=(\d+)/,   // ...?number=3
      ];

      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
          const currentNum = parseInt(match[1]);
          const newUrl = url.replace(pattern, (full, ...groups) => {
            return full.replace(match[1], String(currentNum + 1));
          });
          if (newUrl !== url) {
            this.ui.log('尝试URL导航...');
            location.href = newUrl;
            return true;
          }
        }
      }
      return false;
    }

    /** URL导航兜底：所有selector都没找到单元时使用 */
    async tryUrlNavigationFallback(urlBefore) {
      // 策略1：尝试URL参数递增
      const url = location.href;
      // 匹配各种leaf/video/lesson ID模式
      const idPatterns = [
        /[?&]leaf_id=(\d+)/,
        /[?&]lesson_id=(\d+)/,
        /[?&]video_id=(\d+)/,
        /[?&]content_id=(\d+)/,
        /[?&]id=(\d+)/,
        /\/(\d+)\/(\d+)$/,
        /leaf[_-]?(\d+)/i,
      ];
      for (const pattern of idPatterns) {
        const match = url.match(pattern);
        if (match) {
          const currentId = parseInt(match[1]);
          const newUrl = url.replace(match[0], match[0].replace(match[1], String(currentId + 1)));
          if (newUrl !== url) {
            this.ui.log(`URL ID递增: ${match[1]} → ${currentId + 1}`);
            location.href = newUrl;
            await DOM.sleep(2000);
            return location.href !== urlBefore;
          }
        }
      }

      // 策略2：遍历页面所有可见链接，找看起来像"下一个"的
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        if (link.offsetParent === null) continue;
        const text = DOM.getText(link);
        if (/下一|next|继续|forward|下一节|下一章/i.test(text)) {
          this.ui.log(`找到导航链接: ${text.substring(0, 30)}`);
          DOM.safeClick(link);
          await DOM.sleep(3000);
          return location.href !== urlBefore;
        }
      }

      // 策略3：页面内找任何看起来是未完成任务的链接
      for (const link of allLinks) {
        if (link.offsetParent === null) continue;
        const linkUrl = link.href || '';
        if (linkUrl && linkUrl !== url && !/logout|exit|login/i.test(linkUrl)) {
          const text = DOM.getText(link);
          if (text.length >= 2 && text.length <= 100) {
            this.ui.log(`尝试链接: ${text.substring(0, 30)}`);
            DOM.safeClick(link);
            await DOM.sleep(3000);
            return location.href !== urlBefore;
          }
        }
      }

      return false;
    }

    /** 全页文本搜索：找所有包含"Unit"/"第X单元"等模式的可见元素（使用TreeWalker遍历） */
    _findUnitsByTextSearch() {
      const candidates = [];
      const seen = new Set();
      const unitPattern = /(Unit\s*\d+|第\d+单元|第\d+章|第\d+节|Chapter\s*\d+|Lesson\s*\d+)/i;

      // 使用TreeWalker遍历所有可见文本节点
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: (node) => {
            // 跳过不可见元素
            if (node.offsetParent === null && node.getClientRects().length === 0) {
              return NodeFilter.FILTER_REJECT;
            }
            // 跳过脚本、样式、注释
            const tag = node.tagName?.toLowerCase();
            if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg' || tag === 'path') {
              return NodeFilter.FILTER_REJECT;
            }
            // 只接受叶子节点或接近叶子的节点（文本较短的节点）
            const text = (node.textContent || '').trim();
            if (text.length > 200) return NodeFilter.FILTER_SKIP; // 跳过包含大量文本的容器
            if (unitPattern.test(text)) return NodeFilter.FILTER_ACCEPT;
            return NodeFilter.FILTER_SKIP;
          }
        }
      );

      while (walker.nextNode()) {
        const el = walker.currentNode;
        const text = (el.textContent || '').trim();
        const match = text.match(unitPattern);
        if (!match) continue;

        // 找到合适的可交互容器
        let target = el;
        // 向上寻找：找到包含这段文本且可点击/有语义的最近祖先
        const interactiveTags = new Set(['li', 'a', 'button', 'div', 'span']);
        const containerPatterns = /item|row|unit|chapter|lesson|leaf|node|tree|menu-item|list-item|section/i;

        while (target && target !== document.body) {
          const p = target.parentElement;
          if (!p) break;
          const parentText = (p.textContent || '').trim();
          // 如果父元素文本比当前长不了多少(≤20字符)，继续向上
          if (parentText.length <= text.length + 20 && parentText.includes(text)) {
            target = p;
            continue;
          }
          break;
        }

        // 现在target是包含这个Unit文本的最小独立容器
        // 再向上找到最近的列表项/菜单项/可点击容器
        let container = target;
        while (container && container !== document.body && container !== document.documentElement) {
          const tag = container.tagName?.toLowerCase();
          const cls = (container.className?.toString?.() || container.className || '');
          if (tag === 'li' || tag === 'a' || (tag === 'div' && containerPatterns.test(cls))) {
            break;
          }
          if (container.querySelector('a, button')) break; // 包含链接或按钮的容器
          container = container.parentElement;
        }

        const finalTarget = (container && container !== document.body && container !== document.documentElement)
          ? container : target;

        const key = (finalTarget.textContent || '').trim().substring(0, 80);
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(finalTarget);
        }
      }

      // 如果TreeWalker没找到，回退到querySelector方案（兼容性更好）
      if (candidates.length < 2) {
        for (const el of document.querySelectorAll('*')) {
          if (el.offsetParent === null && el.getClientRects().length === 0) continue;
          const tag = el.tagName?.toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
          const text = (el.textContent || '').trim();
          if (text.length > 150) continue;
          if (unitPattern.test(text)) {
            const key = text.substring(0, 80);
            if (!seen.has(key)) {
              seen.add(key);
              candidates.push(el);
            }
          }
        }
      }

      return candidates;
    }

    /** 调试：dump页面关键元素信息 */
    _dumpPageElements() {
      logger.info('Nav', '=== 页面元素调试 ===');
      logger.info('Nav', `当前URL: ${location.href}`);
      logger.info('Nav', `页面标题: ${document.title}`);
      logger.info('Nav', `body子元素数: ${document.body.children.length}`);

      // 查找所有可能的侧边栏/导航容器
      const containerPatterns = ['sidebar', 'menu', 'catalog', 'tree', 'directory', 'nav', 'panel', 'layout', 'lesson', 'chapter', 'course', 'list', 'left', 'aside'];
      const allContainers = [];
      for (const pattern of containerPatterns) {
        const els = document.querySelectorAll(`[class*="${pattern}"], ${pattern}`);
        for (const el of els) {
          if (!allContainers.includes(el) && el.offsetParent !== null) {
            allContainers.push(el);
          }
        }
      }
      // 去重并按DOM层级排序
      const uniqueContainers = allContainers.filter((el, i) => allContainers.indexOf(el) === i);
      uniqueContainers.sort((a, b) => {
        // 按深度排序：先子元素多的
        return b.querySelectorAll('*').length - a.querySelectorAll('*').length;
      });

      logger.info('Nav', `找到 ${uniqueContainers.length} 个可能容器`);
      uniqueContainers.slice(0, 8).forEach((container, i) => {
        const tag = container.tagName;
        const cls = (container.className?.toString?.() || container.className || '').substring(0, 80);
        const childCount = container.children.length;
        const text = DOM.getText(container).substring(0, 80);
        logger.info('Nav', `  容器${i}: <${tag}> class="${cls}" children=${childCount} text="${text}"`);
        for (let j = 0; j < Math.min(container.children.length, 8); j++) {
          const child = container.children[j];
          const cTag = child.tagName;
          const cCls = (child.className?.toString?.() || child.className || '').substring(0, 60);
          const cText = DOM.getText(child).substring(0, 60);
          if (cText.length > 1) {
            logger.info('Nav', `    [${j}] <${cTag}> class="${cCls}" text="${cText}"`);
          }
        }
      });

      // 查找所有带"Unit"或"单元"或"Unit"文字的元素
      const allElements = document.querySelectorAll('*');
      let unitCount = 0;
      const unitEls = [];
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        if (/Unit\s*\d+|第\d+单元|第\d+章|第\d+节/i.test(text) && el.offsetParent !== null) {
          if (text.length < 200) {
            unitEls.push(el);
          }
        }
      }
      logger.info('Nav', `找到 ${unitEls.length} 个包含Unit/单元文字的可见元素`);
      unitEls.slice(0, 10).forEach(el => {
        const tag = el.tagName;
        const cls = (el.className?.toString?.() || el.className || '').substring(0, 60);
        const text = (el.textContent || '').trim().substring(0, 80);
        logger.info('Nav', `  <${tag}> class="${cls}" text="${text}"`);
        let p = el.parentElement;
        let depth = 0;
        while (p && p !== document.body && depth < 4) {
          const pCls = (p.className?.toString?.() || p.className || '').substring(0, 60);
          logger.info('Nav', `    ↑父${depth}: <${p.tagName}> class="${pCls}"`);
          p = p.parentElement;
          depth++;
        }
      });

      // 额外：查找页面内所有链接文本
      const allLinks = document.querySelectorAll('a');
      const linkTexts = [];
      for (const a of allLinks) {
        const t = DOM.getText(a);
        if (t.length >= 2 && t.length <= 100 && a.offsetParent !== null) {
          linkTexts.push(t);
        }
      }
      logger.info('Nav', `页面可见链接(${linkTexts.length}):`, linkTexts.slice(0, 20));

      logger.info('Nav', '=== 调试结束 ===');
    }

    isCurrentTaskComplete() {
      // 检查是否有完成标志
      const completeSelectors = [
        '[class*="complete"]', '[class*="finished"]',
        '[class*="done"]', '[class*="pass"]',
        '[class*="success"]', '[class*="studied"]',
        'span:contains("已完成")', 'span:contains("已通过")',
        '[class*="progress"] [style*="100%"]',
      ];
      for (const sel of completeSelectors) {
        const el = DOM.queryFirst(sel);
        if (el && el.offsetParent !== null) return true;
      }
      return false;
    }

    // ========== 跨课程导航 ==========
    // 课程完成追踪 (localStorage)
    static _getFinishedCourses() {
      try { return new Set(JSON.parse(localStorage.getItem('ykh_finished_courses_v1') || '[]')); }
      catch { return new Set(); }
    }
    static _saveFinishedCourses(set) {
      try { localStorage.setItem('ykh_finished_courses_v1', JSON.stringify([...set])); }
      catch (e) { logger.warn('Nav', '保存课程完成记录失败', e); }
    }

    /** 生成课程唯一标识 */
    _getCourseKey() {
      const titleEl = document.querySelector('.headerCard h1 .title-inner-wrapper, h1, [class*="course-name"], [class*="course-title"]');
      const classEl = document.querySelector('.headerCard .classroom-name .title-inner-wrapper, [class*="classroom-name"], [class*="class-name"]');
      const title = (titleEl?.textContent || document.title || '').trim();
      const className = (classEl?.textContent || '').trim();
      return `${title}|${className}`.replace(/\s+/g, ' ');
    }

    /** 标记当前课程为已完成 */
    markCurrentCourseFinished() {
      const key = this._getCourseKey();
      if (!key || key === '|') return;
      const finished = NavigationHandler._getFinishedCourses();
      if (!finished.has(key)) {
        finished.add(key);
        NavigationHandler._saveFinishedCourses(finished);
        this.ui.log(`📌 已记录完成课程: ${key.substring(0, 60)}`);
        logger.info('Nav', '课程标记完成:', key);
      }
    }

    /** 检查当前课程是否已完成 */
    isCourseFinished() {
      const key = this._getCourseKey();
      if (!key || key === '|') return false;
      return NavigationHandler._getFinishedCourses().has(key);
    }

    /** 返回课程列表页并进入下一门未完成课程 */
    async goToNextCourse() {
      this.ui.log('📚 当前课程已完成，查找下一门未完成课程...');
      this.markCurrentCourseFinished();

      // 先返回课程列表页
      const returned = await this._returnToCourseList();
      if (!returned) {
        this.ui.log('⚠️ 无法返回课程列表，停止', 'warn');
        return false;
      }

      // 在课程列表页等待加载
      await DOM.sleep(3000);

      // 尝试点击"我听的课"页签
      this._ensureStudentTab();

      // 等待课程卡片加载
      await DOM.sleep(2000);

      // 找下一门未完成课程
      const nextCourse = this._findNextUnfinishedCourse();
      if (nextCourse) {
        this.ui.log(`👉 进入下一门课程: ${nextCourse.title}`);
        nextCourse.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await DOM.sleep(300);
        DOM.safeClick(nextCourse.el);
        await DOM.sleep(3000);
        return true;
      }

      this.ui.log('🎉 所有课程已完成！');
      return false;
    }

    /** 返回课程列表页 */
    async _returnToCourseList() {
      // 尝试点击左侧菜单"课程班级"
      const menuLis = Array.from(document.querySelectorAll('.left__menu ul li'));
      const courseMenu = menuLis.find(li => (li.textContent || '').includes('课程班级'));
      if (courseMenu) {
        this.ui.log('点击左侧菜单"课程班级"...');
        DOM.safeClick(courseMenu);
        await DOM.sleep(2500);
        if (location.href.includes('/v2/web/index') || location.href.includes('/v2/web/') || document.querySelector('.TCardGroup')) {
          return true;
        }
      }

      // 直接跳转课程列表
      this.ui.log('跳转到课程列表页...');
      location.href = '/v2/web/index';
      await DOM.sleep(3000);
      return true;
    }

    /** 切换到"我听的课"页签 */
    _ensureStudentTab() {
      const studentTab = document.querySelector('#tab-student');
      if (studentTab && !studentTab.classList.contains('is-active')) {
        this.ui.log('切换到"我听的课"页签');
        studentTab.click();
      }
    }

    /** 在课程列表页找下一门未完成课程 */
    _findNextUnfinishedCourse() {
      const finished = NavigationHandler._getFinishedCourses();
      const cards = Array.from(document.querySelectorAll('.TCardGroup .lesson-cardS .el-card__body, .TCardGroup .el-card, [class*="course-card"], [class*="lesson-card"]'))
        .map(el => ({
          el: el.closest('.el-card') || el,
          title: (el.querySelector('.left .top h1, h1, [class*="title"]')?.textContent || '').trim(),
          className: (el.querySelector('.left .bottom .className, [class*="class-name"]')?.textContent || '').trim()
        }))
        .filter(x => x.title);

      if (!cards.length) {
        this.ui.log('未找到课程卡片', 'warn');
        return null;
      }

      for (const c of cards) {
        const key = `${c.title}|${c.className}`.replace(/\s+/g, ' ');
        if (!finished.has(key)) {
          return c;
        }
      }
      return null;
    }

    async dismissModals() {
      // 只关闭明确的信息类弹窗；试卷/提交相关弹窗一律不碰，避免干扰手动交卷
      const dialogs = DOM.queryAll('[class*="modal"], [class*="dialog"], [class*="popup"]');
      for (const modal of dialogs) {
        if (modal.style.display === 'none' || modal.offsetParent === null) continue;
        const text = DOM.getText(modal);
        if (/交卷|提交|试卷|答题卡|成绩|保存|确认/i.test(text)) continue;
        // 优先点右上角的关闭图标
        const closeBtn = DOM.queryFirst('[class*="close"], .el-dialog__headerbtn', modal);
        if (closeBtn && closeBtn.offsetParent !== null && closeBtn !== modal) {
          DOM.safeClick(closeBtn);
          continue;
        }
        // 其次只点明确的信息确认按钮（绝不点"取消/确定"以免触发业务动作）
        for (const btn of modal.querySelectorAll('button, [role="button"], span[class*="btn"]')) {
          const t = DOM.getText(btn);
          if (/^(知道了|我知道了|关闭|好的)$/.test(t)) { DOM.safeClick(btn); break; }
        }
      }
      await DOM.sleep(300);
    }
  }

  // ============================================================
  //  COURSE SCANNER
  // ============================================================
  class CourseScanner {
    constructor(ui) {
      this.ui = ui;
    }

    scan() {
      // 扫描当前页面的课程结构
      const info = {
        courseName: this.getCourseName(),
        chapters: this.getChapters(),
        currentTask: this.getCurrentTask(),
        videoCount: this.getVideoCount(),
        quizCount: this.getQuizCount(),
      };
      logger.info('Scanner', '课程信息:', info);
      return info;
    }

    getCourseName() {
      const selectors = [
        '[class*="course-name"]', '[class*="course-title"]',
        '[class*="class-name"]', 'h1', 'h2', '[class*="title"]',
        'title'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = DOM.getText(el);
          if (text && text.length > 1 && text.length < 100) return text;
        }
      }
      return document.title || '未知课程';
    }

    getChapters() {
      const chapters = [];
      const selectors = [
        '[class*="chapter-item"]', '[class*="lesson-item"]',
        '[class*="menu-item"]', 'li[class*="unit"]'
      ];
      for (const sel of selectors) {
        const items = document.querySelectorAll(sel);
        items.forEach(item => {
          chapters.push({
            title: DOM.getText(item).substring(0, 80),
            isComplete: DOM.hasClass(item, 'complete') || DOM.hasClass(item, 'done') || DOM.hasClass(item, 'finished'),
            element: item,
          });
        });
        if (chapters.length > 0) break;
      }
      return chapters;
    }

    getCurrentTask() {
      const selectors = [
        '[class*="active"]', '[class*="current"]',
        '[class*="selected"]', '[class*="playing"]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return DOM.getText(el).substring(0, 80);
      }
      return '未知';
    }

    getVideoCount() {
      return document.querySelectorAll('video').length;
    }

    getQuizCount() {
      let count = 0;
      const quizSelectors = [
        '[class*="exam"]', '[class*="quiz"]', '[class*="question"]',
        '[class*="problem"]', 'input[type="radio"]', 'input[type="checkbox"]'
      ];
      for (const sel of quizSelectors) {
        count += document.querySelectorAll(sel).length;
      }
      return count;
    }

    hasPageContent() {
      // 检查页面是否有实质内容（而不是空白或课程列表）
      const hasVideo = document.querySelectorAll('video').length > 0;
      const hasQuiz = document.querySelectorAll('input[type="radio"], [class*="quiz"], [class*="exam"]').length > 0;
      const hasText = document.body && document.body.innerText && document.body.innerText.length > 200;
      return hasVideo || hasQuiz || hasText;
    }
  }

  // ============================================================
  //  试题导出：生成 Word (.docx)，无外部依赖
  // ============================================================
  class ExamExporter {
    /** 生成 .docx Blob（答案用黄色高亮 + 红色加粗突出显示） */
    static buildDocx({ title, questions }) {
      const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      const textRuns = (text, rPr = '') => String(text).split(/\r?\n/)
        .map((ln, i) => `${i > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(ln)}</w:t>`)
        .join('');
      const run = (text, rPr = '') => `<w:r><w:rPr>${rPr}</w:rPr>${textRuns(text)}</w:r>`;
      const para = (inner, pPr = '') => `<w:p><w:pPr>${pPr}</w:pPr>${inner}</w:p>`;

      const body = [];
      body.push(para(run(title, '<w:b/><w:sz w:val="36"/><w:szCs w:val="36"/>'),
        '<w:jc w:val="center"/><w:spacing w:before="240" w:after="120"/>'));
      const meta = `导出时间：${new Date().toLocaleString()}    共 ${questions.length} 道题`;
      body.push(para(run(meta, '<w:color w:val="808080"/><w:sz w:val="18"/>'),
        '<w:jc w:val="center"/><w:spacing w:after="240"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="6" w:color="BFBFBF"/></w:pBdr>'));

      questions.forEach((q, i) => {
        const num = q.num || i + 1;
        const head = `${num}. ${q.typeLabel}${q.score ? `（${q.score}分）` : ''}`;
        body.push(para(run(head, '<w:b/><w:sz w:val="24"/><w:szCs w:val="24"/>'), '<w:spacing w:before="280" w:after="100"/>'));
        if (Array.isArray(q.stemParts) && q.stemParts.length > 0) {
          // 填空题：答案直接填回原文空位，用黄底红字加粗下划线突出
          const inner = q.stemParts.map(p => {
            if (Object.prototype.hasOwnProperty.call(p, 'a')) {
              return p.a
                ? run(p.a, '<w:b/><w:color w:val="C00000"/><w:highlight w:val="yellow"/><w:u w:val="single"/><w:sz w:val="22"/>')
                : run('＿＿＿＿', '<w:color w:val="808080"/><w:sz w:val="22"/>');
            }
            return run(p.t, '<w:sz w:val="22"/>');
          }).join('');
          body.push(para(inner, '<w:spacing w:after="80"/>'));
        } else if (q.stem) {
          body.push(para(run(q.stem, '<w:sz w:val="22"/>'), '<w:spacing w:after="80"/>'));
        }
        (q.options || []).forEach((opt, oi) => {
          const clean = String(opt || '').replace(/^\s*[（(]?\s*[A-Ha-h]\s*[)）.、．.\s:：]+\s*/, '').trim();
          const text = clean || String(opt || '');
          if (!text) return;
          body.push(para(run(`${String.fromCharCode(65 + oi)}. ${text}`, '<w:sz w:val="21"/>'),
            '<w:ind w:left="320"/><w:spacing w:after="20"/>'));
        });
        if (q.inlineFull) {
          // 答案已填写在空位中，不再单独列出
        } else if (q.answerText) {
          body.push(para(
            run('【答案】', '<w:b/><w:color w:val="C00000"/><w:highlight w:val="yellow"/><w:sz w:val="22"/>') +
            run(q.answerText, '<w:b/><w:color w:val="C00000"/><w:highlight w:val="yellow"/><w:sz w:val="22"/>'),
            '<w:spacing w:before="100" w:after="180"/>'));
        } else {
          body.push(para(run('【答案】未作答', '<w:i/><w:color w:val="808080"/><w:sz w:val="21"/>'),
            '<w:spacing w:before="100" w:after="180"/>'));
        }
      });

      const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;
      const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`;
      const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
      const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
      const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

      const enc = new TextEncoder();
      const blob = this._zip([
        { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
        { name: '_rels/.rels', data: enc.encode(rootRels) },
        { name: 'word/document.xml', data: enc.encode(docXml) },
        { name: 'word/styles.xml', data: enc.encode(stylesXml) },
        { name: 'word/_rels/document.xml.rels', data: enc.encode(docRels) },
      ]);
      return new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    }

    /** 最小 ZIP 打包（store 模式，足够 Word 打开） */
    static _zip(files) {
      const enc = new TextEncoder();
      const now = new Date();
      const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
      const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
      const chunks = [];
      const central = [];
      let offset = 0;

      for (const f of files) {
        const nameBytes = enc.encode(f.name);
        const data = f.data;
        const crc = ExamExporter._crc32(data);
        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true);
        lv.setUint16(8, 0, true);
        lv.setUint16(10, dosTime, true);
        lv.setUint16(12, dosDate, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);
        local.set(nameBytes, 30);
        chunks.push(local, data);
        central.push({ nameBytes, crc, size: data.length, offset });
        offset += local.length + data.length;
      }

      let centralSize = 0;
      for (const c of central) {
        const cd = new Uint8Array(46 + c.nameBytes.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, dosTime, true);
        cv.setUint16(14, dosDate, true);
        cv.setUint32(16, c.crc, true);
        cv.setUint32(20, c.size, true);
        cv.setUint32(24, c.size, true);
        cv.setUint16(28, c.nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, c.offset, true);
        cd.set(c.nameBytes, 46);
        chunks.push(cd);
        centralSize += cd.length;
      }

      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, central.length, true);
      ev.setUint16(10, central.length, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, offset, true);
      chunks.push(eocd);

      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let pos = 0;
      for (const c of chunks) { out.set(c, pos); pos += c.length; }
      return out;
    }

    static _crc32(bytes) {
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
      }
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    /** 保存：优先弹出"另存为"让用户选择地址；不支持时退回浏览器下载 */
    static async save(blob, filename) {
      const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
      const picker = (win && typeof win.showSaveFilePicker === 'function') ? win.showSaveFilePicker.bind(win) : null;
      if (picker) {
        try {
          const handle = await picker({
            suggestedName: filename,
            types: [{
              description: 'Word 文档',
              accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] },
            }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return handle.name || filename;
        } catch (e) {
          if (e && e.name === 'AbortError') return null;
          logger.warn('Main', '无法打开保存对话框，改用浏览器下载:', e && e.message);
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return `浏览器下载目录/${filename}`;
    }
  }

  // ============================================================
  //  MAIN AUTOMATOR
  // ============================================================
  class Automator {
    constructor() {
      this.aiAnswerer = new AIAnswerer();
      this.ui = new UIPanel();
      this.videoHandler = new VideoHandler(this.ui);
      this.quizHandler = new QuizHandler(this.ui, this.aiAnswerer);
      this.navHandler = new NavigationHandler(this.ui);
      this.scanner = new CourseScanner(this.ui);
      this.isRunning = false;
      this.completedTasks = 0;
      this.totalTasks = 0;
      this.pageCheckInterval = null;
      this.lastPageUrl = '';
      this.noProgressCount = 0;
      this.maxNoProgress = 10;
      this._videoJustEnded = false;
      this._navCooldownEnd = 0; // 导航后冷却时间戳
      this._pageEnterTime = Date.now(); // 进入当前页面的时间
      this._courseCompleted = false; // 防止重复触发完成
    }

    /** 导出诊断文件：题目结构 + 当前作答状态 + 最近AI请求/返回 + 日志 */
    diagnose() {
      const qh = this.quizHandler;
      const questions = qh.pageQuestions.map((q, i) => {
        let options = [], selected = null, fillValues = [];
        try { options = qh._getAllOptionTexts(q.el); } catch (e) { /* ignore */ }
        try { selected = qh.readUserSelection(q); } catch (e) { /* ignore */ }
        try { fillValues = qh._getFillInputs(q.el).map(inp => inp.value); } catch (e) { /* ignore */ }
        return {
          index: i,
          stem: q.stem,
          qtype: q.qtype,
          answered: q.answered,
          answerSource: q.answerSource,
          answer: q.answer,
          options,
          selected,
          fillValues,
          html: (q.el?.outerHTML || '').substring(0, 8000),
        };
      });
      const data = {
        exportedAt: new Date().toISOString(),
        url: location.href,
        pageQuestionCount: questions.length,
        unanswered: questions.filter(x => !x.answered).map(x => x.index),
        aiSettings: {
          enabled: this.aiAnswerer.settings.enabled,
          endpoint: this.aiAnswerer.settings.endpoint,
          model: this.aiAnswerer.settings.model,
          timeout: this.aiAnswerer.settings.timeout,
        },
        questions,
        aiLog: this.aiAnswerer._apiLog || [],
        logs: LOG_BUFFER.slice(-400),
      };
      const json = JSON.stringify(data, null, 2);
      try {
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `yuketang-diagnose-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      } catch (e) {
        logger.warn('Diag', '诊断文件下载失败，请使用控制台输出:', e.message);
      }
      logger.info('Diag', `诊断已导出: 共${questions.length}题, 未答${data.unanswered.length}道`);
      return data;
    }

    init() {
      this.ui.create();
      this._bindEvents();
      this.ui.log('✅ 雨课堂助手已就绪');
      this.ui.log('💡 请打开课程页面，点击"开始运行"');
      this.ui.setStatus('就绪 - 请打开课程页面并点击开始');
      try {
        if (typeof unsafeWindow !== 'undefined') {
          unsafeWindow.__ytDiagnose = () => this.diagnose();
        }
      } catch (e) { /* ignore */ }
      if (this.navHandler._isExamPage()) {
        this.ui.log('🩺 排查问题时：按 F12 在控制台输入 __ytDiagnose()，会下载诊断文件');
      }

      // 自动检测页面内容
      const info = this.scanner.scan();
      if (info.chapters.length > 0) {
        this.ui.log(`📚 检测到课程: ${info.courseName}`);
        this.ui.log(`📖 共 ${info.chapters.length} 个学习任务`);
        this.totalTasks = info.chapters.length;
        this.ui.setProgress(0, this.totalTasks);
      }
      if (info.videoCount > 0) {
        this.ui.log(`🎬 页面中有 ${info.videoCount} 个视频`);
      }
      if (info.quizCount > 0) {
        this.ui.log(`📝 页面中有试题`);
      }
    }

    _bindEvents() {
      this.ui.on('start', () => {
        if (this.quizHandler.isWaitingForManual()) {
          this._onManualContinue();
        } else {
          this.start();
        }
      });
      this.ui.on('stop', () => this.stop());
      this.ui.on('rescan', () => this.rescan());
      this.ui.on('speedChange', (speed) => this.videoHandler.updateSpeed(speed));
      this.ui.on('mutedChange', (muted) => this.videoHandler.updateMuted(muted));
      this.ui.on('aiSettingsChange', (settings) => {
        this.aiAnswerer.updateSettings(settings);
        this.ui.log('🤖 AI设置已更新' + (settings.enabled && settings.apiKey ? '，已启用' : '，未启用（需要API Key）'));
      });
      this.ui.on('crossCourseChange', (enabled) => {
        this.ui.log(enabled ? '📚 跨课程模式已开启' : '📚 跨课程模式已关闭');
      });
      this.ui.on('clearPageAnswers', () => {
        this._onClearPageAnswers();
      });
      this.ui.on('reanswerQuestion', (stemKey) => {
        this._onReanswerQuestion(stemKey);
      });
      this.ui.on('extractExam', () => {
        this._onExtractExam();
      });
    }

    async _onClearPageAnswers() {
      this.ui.log('🔍 扫描页面上的已作答题目...');
      const n = await this.quizHandler.scanAndClearPageAnswers();
      this.ui.setStatus(n > 0 ? `🧹 已清除 ${n} 道题的界面答案` : '页面上没有已作答的题目', 'info');
    }

    _onReanswerQuestion(stemKey) {
      const q = this.quizHandler.pageQuestions.find(x => x.stemKey === stemKey);
      if (!q) {
        this.ui.log('⚠️ 找不到该题目，请等页面扫描完成后再试', 'warn');
        return;
      }
      this.quizHandler.reanswerQuestion(q);
    }

    async _onExtractExam() {
      let data;
      try {
        data = this.quizHandler.collectExamData();
      } catch (e) {
        this.ui.log(`❌ 提取失败：${e.message || e}`, 'error');
        return;
      }
      if (!data.questions.length) {
        this.ui.log('⚠️ 当前页面没有检测到题目，无法提取', 'warn');
        return;
      }
      this.ui.log(`📄 正在提取 ${data.questions.length} 道题并生成 Word 文档...`);
      let blob;
      try {
        blob = ExamExporter.buildDocx(data);
      } catch (e) {
        this.ui.log(`❌ 生成文档失败：${e.message || e}`, 'error');
        return;
      }
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      const filename = `雨课堂试题_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.docx`;
      try {
        const saved = await ExamExporter.save(blob, filename);
        if (!saved) {
          this.ui.log('已取消保存', 'warn');
          return;
        }
        this.ui.log(`✅ 试题已保存：${saved}`);
        this.ui.setStatus('📄 试题已提取', 'info');
      } catch (e) {
        this.ui.log(`❌ 保存失败：${e.message || e}`, 'error');
      }
    }

    _onManualContinue() {
      this.ui.log('📝 用户确认手动答题完成，继续运行...');
      this.ui.setManualWaitMode(false);
      this.quizHandler.onManualContinue();
      // 恢复主循环的按钮状态
      this.ui.setRunning(true);
      setTimeout(() => {
        if (this.isRunning && !this.quizHandler.isWaitingForManual()) {
          this.ui.setStatus('运行中...', 'info');
        }
      }, 3000);
    }

    async start() {
      this.isRunning = true;
      this.noProgressCount = 0;
      this._videoJustEnded = false;
      this._courseCompleted = false;
      this.ui.setRunning(true);
      this.ui.setStatus('运行中...', 'info');
      this.ui.log('🚀 开始自动学习');

      const info = this.scanner.scan();
      if (info.chapters.length > 0) {
        this.totalTasks = info.chapters.length;
      } else {
        this.totalTasks = 1;
      }
      this.completedTasks = 0;
      this.ui.setProgress(0, this.totalTasks);
      this.lastPageUrl = location.href;

      // 启动各模块
      this.videoHandler._onVideoEndedCallback = () => {
        // 视频结束后立即标记，让主循环快速响应
        this._videoJustEnded = true;
      };
      this.videoHandler.start();
      this.quizHandler.start();
      this.navHandler.start();

      // 主循环
      this.pageCheckInterval = setInterval(() => this._mainLoop(), CONFIG.checkInterval);

      // 立即执行一次
      await this._mainLoop();
    }

    async stop() {
      this.isRunning = false;
      this.ui.setRunning(false);
      this.videoHandler.stop();
      this.quizHandler.stop();
      this.navHandler.stop();
      if (this.pageCheckInterval) {
        clearInterval(this.pageCheckInterval);
        this.pageCheckInterval = null;
      }
      this.ui.setStatus('已停止', '');
      this.ui.log('⏹ 已停止运行');
    }

    async rescan() {
      this.ui.log('🔄 重新扫描课程...');
      const info = this.scanner.scan();
      if (info.chapters.length > 0) {
        this.totalTasks = info.chapters.length;
        this.completedTasks = 0;
        this.ui.setProgress(0, this.totalTasks);
        this.ui.log(`📖 扫描到 ${info.chapters.length} 个学习任务`);
      }
      this.navHandler.scanChapters();
      this.ui.setStatus('扫描完成', 'info');
    }

    async _mainLoop() {
      if (!this.isRunning || this._courseCompleted) return;

      // 如果正在等待手动答题，暂停主循环，不自动导航
      if (this.quizHandler.isWaitingForManual()) {
        this.ui.setManualWaitMode(true);
        return;
      } else {
        this.ui.setManualWaitMode(false);
      }

      // 关闭弹窗
      await this.navHandler.dismissModals();

      // 更新课程页面URL（用于返回导航）
      if (this.navHandler._isOnCoursePage()) {
        this.navHandler.coursePageUrl = location.href;
      }

      // 检测页面是否有视频，处理视频
      const hasVideo = this.videoHandler.hasActiveVideo();
      if (hasVideo) {
        this.noProgressCount = 0;
        this._navCooldownEnd = 0; // 找到视频，解除冷却
        this.ui.setStatus('正在播放视频...', 'info');
        // 更新视频进度显示
        const progressInfo = this.videoHandler.getProgressInfo();
        this.ui.updateVideoProgress(progressInfo);
        return; // 视频播放中，等待视频结束
      }

      // 检测试题
      const hasQuiz = this.quizHandler.scanQuizzes();
      if (hasQuiz) {
        this.noProgressCount = 0;
        this._navCooldownEnd = 0; // 找到试题，解除冷却
        this.ui.setStatus('正在处理试题...', 'info');
        this.ui.updateVideoProgress(null); // 隐藏视频进度
        await DOM.sleep(3000);
        return;
      }

      // 没有视频也没有试题
      // 视频刚结束 → 加速跳转，不等3秒
      if (this._videoJustEnded) {
        this._videoJustEnded = false;
        this.noProgressCount = 100; // 立即触发跳转
      } else {
        this.noProgressCount++;
      }

      // 导航冷却期：刚跳转到新页面，给视频/试题足够时间加载
      // 但视频刚结束或noProgressCount很高时，跳过冷却
      if (Date.now() < this._navCooldownEnd && !this._videoJustEnded && this.noProgressCount < 100) {
        if (this.noProgressCount >= 12) {
          this.ui.log('冷却期超时，允许跳转', 'warn');
        } else {
          this.ui.setStatus('等待页面内容加载...', 'info');
          return;
        }
      }

      // 检查当前页面内容
      if (!this.scanner.hasPageContent()) {
        this.ui.setStatus('页面加载中...', 'info');
        await DOM.sleep(2000);
        return;
      }

      // 非课程页面（如视频页/试题页）：给更多时间，提高跳转阈值
      const isOnCourse = this.navHandler._isOnCoursePage();
      const progressThreshold = isOnCourse ? 3 : 8;

      // 检查任务是否完成
      if (this.navHandler.isCurrentTaskComplete() || this.noProgressCount >= progressThreshold) {
        this.completedTasks++;
        this.ui.setProgress(this.completedTasks, this.totalTasks);
        this.ui.log(`✅ 当前任务完成 (${this.completedTasks}/${this.totalTasks})`);

        if (this.ui.isAutoNext()) {
          this.noProgressCount = 0;
          const hasNext = await this.navHandler.goToNext();

          if (hasNext) {
            this.ui.setStatus('跳转下一任务...', 'info');
            this._navCooldownEnd = Date.now() + 12000; // 12秒冷却期
            this._pageEnterTime = Date.now();
            // 等待新页面加载
            await DOM.sleep(3000);
            this.videoHandler.scanAndHandle();
            this.quizHandler.scanQuizzes();
          } else {
            // 没有更多任务了
            this.ui.setProgress(this.totalTasks, this.totalTasks);
            this._onCourseComplete();
          }
        } else {
          this.ui.setStatus('当前任务完成，等待手动切换', 'warning');
        }
      } else if (this.noProgressCount >= this.maxNoProgress) {
        // 长时间无进展，可能课程已完成
        this.ui.log('⏰ 长时间未检测到新任务，可能课程已完成', 'warn');
        this._onCourseComplete();
      }
    }

    async _onCourseComplete() {
      if (this._courseCompleted) return; // 防止重复触发
      this._courseCompleted = true;

      // 检查是否开启跨课程模式
      if (this.ui.isCrossCourse()) {
        this.ui.log('📚 当前课程完成，查找下一门课程...');
        this.ui.setStatus('正在查找下一门课程...', 'info');
        this.navHandler.markCurrentCourseFinished();

        // 短暂停止视频/试题处理
        this.videoHandler.stop();
        this.quizHandler.stop();

        const hasNext = await this.navHandler.goToNextCourse();
        if (hasNext) {
          // 进入新课程 → 重新启动
          this._courseCompleted = false;
          this.completedTasks = 0;
          this.totalTasks = 1;
          this.noProgressCount = 0;
          this._navCooldownEnd = Date.now() + 15000;
          this.lastPageUrl = location.href;
          this._pageEnterTime = Date.now();
          this.ui.setProgress(0, 0);
          this.ui.updateVideoProgress(null);

          // 重新扫描课程
          setTimeout(() => {
            const info = this.scanner.scan();
            if (info.chapters.length > 0) {
              this.totalTasks = info.chapters.length;
              this.ui.log(`📖 新课程: ${info.courseName}, ${info.chapters.length} 个任务`);
              this.ui.setProgress(0, this.totalTasks);
            }
            this.navHandler.start();
            this.videoHandler.start();
            this.quizHandler.start();
            this.ui.setStatus('运行中...', 'info');
          }, 3000);
          return;
        }

        // 没有更多课程了
        this.ui.log('🎉 所有课程已完成！');
      }

      this.isRunning = false;
      this.ui.setRunning(false);
      this.videoHandler.stop();
      this.quizHandler.stop();
      this.navHandler.stop();
      if (this.pageCheckInterval) {
        clearInterval(this.pageCheckInterval);
        this.pageCheckInterval = null;
      }
      this.ui.setStatus('🎉 本课程已完成!', '');
      this.ui.log('🎉 本课程所有任务已完成，脚本已停止');
      this.ui.setProgress(this.totalTasks, this.totalTasks);
      this.ui.updateVideoProgress(null);

      // 桌面通知
      if (CONFIG.notifyOnComplete) {
        try {
          GM_notification({
            title: '长江雨课堂助手',
            text: '所有课程任务已完成！',
            timeout: 5000,
          });
        } catch (e) {}
      }
    }
  }

  // ============================================================
  //  INITIALIZATION
  // ============================================================
  function init() {
    // 防止重复加载（例如脚本被安装多次、或在 iframe 中重复注入）
    if (unsafeWindow.__yuketangAutomatorInstance || document.getElementById('yuketang-helper-panel')) {
      logger.warn('Main', '检测到重复实例，跳过初始化');
      return;
    }

    // 等待页面基本加载完成
    const doInit = () => {
      // 不在非课程页面显示面板（登录页、首页等）
      const isCoursePage = isOnCoursePage();
      if (!isCoursePage) {
        logger.info('Main', '非课程页面，延迟初始化（等待导航到课程页）');
        // 监听URL变化，在进入课程页时初始化
        startUrlObserver();
        return;
      }

      const automator = new Automator();
      automator.init();
      // 挂载到 window 方便调试
      unsafeWindow.__yuketangAutomator = automator;
      unsafeWindow.__yuketangAutomatorInstance = true;
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(doInit, 1000);
      });
    } else {
      setTimeout(doInit, 1000);
    }
  }

  /** 判断当前是否在课程内容页面（有视频/试题/单元列表） */
  function isOnCoursePage() {
    const url = location.href;
    // 登录页面
    if (/login|signin|auth|passport/i.test(url)) return false;
    // 纯课程列表页（不含具体课程内容）
    if (/\/course\s*$/i.test(url) || /\/courses\s*$/i.test(url) || /\/classroom\s*$/i.test(url)) return false;
    // 课程内容页面特征：URL包含studentLog, lesson, leaf, video, study, learn等
    if (/studentLog|lesson|leaf|video|study|learn|courseware|knowledge|unit/i.test(url)) return true;
    // 如果页面已经有视频或试题元素，也算课程页
    if (document.querySelector('video, [class*="exam"], [class*="quiz"], [class*="question"], [class*="leaf"]')) return true;
    // 默认允许（可能是其他课程页面格式）
    return true;
  }

  /** SPA页面URL变化监听，在进入课程页时初始化 */
  function startUrlObserver() {
    let lastUrl = location.href;
    const checkUrl = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        if (isOnCoursePage() && !unsafeWindow.__yuketangAutomatorInstance && !document.getElementById('yuketang-helper-panel')) {
          logger.info('Main', '检测到进入课程页面，开始初始化...');
          const automator = new Automator();
          automator.init();
          unsafeWindow.__yuketangAutomator = automator;
          unsafeWindow.__yuketangAutomatorInstance = true;
        }
      }
    };
    // 监听popstate和hashchange
    window.addEventListener('popstate', checkUrl);
    window.addEventListener('hashchange', checkUrl);
    // SPA路由变化（MutationObserver监听body变化）
    const urlObserver = new MutationObserver(() => {
      setTimeout(checkUrl, 500);
    });
    urlObserver.observe(document.body, { childList: true, subtree: true });
    // 定期检查
    setInterval(checkUrl, 3000);
  }

  init();

  logger.info('Main', '长江雨课堂自动刷课助手 v3.4.1 已加载');
})();