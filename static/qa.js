// static/qa.js
// 🧠 问答接管配置页：人设提示词 + OpenAI 兼容大模型
(function () {
  'use strict';

  const { apiGet, apiPost } = window.SongloftPlugin || {};
  const CFG_KEY = 'xiaoai_qa_config';

  // 供应商预设：换供应商只改 baseUrl + model + extra 三项
  const PRESETS = {
    siliconflow: {
      url: 'https://api.siliconflow.cn/v1/chat/completions',
      model: 'Qwen/Qwen3-8B',
      extra: '{"enable_thinking": false}'
    },
    deepseek: {
      url: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
      extra: ''
    },
    openai: {
      url: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      extra: ''
    },
    moonshot: {
      url: 'https://api.moonshot.cn/v1/chat/completions',
      model: 'moonshot-v1-8k',
      extra: ''
    },
    zhipu: {
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      model: 'glm-4-flash',
      extra: ''
    },
    custom: { url: '', model: '', extra: '' }
  };

  const DEFAULT_PERSONA = '你的名字叫小爱，性格温和、耐心，偶尔有点幽默。用轻松自然的口吻说话，像一位熟悉的朋友。';

  // 后端默认词表（/qa/defaults 拉取），只用于预填和「恢复默认」。留空则后端按默认表判。
  let DEFAULT_PATTERNS = [];

  let saveTimer = null;

  function $(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ==========================================
  // 表单 <-> 配置
  // ==========================================
  function collectConfig() {
    const cmds = String($('qa-cmds').value || '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);

    const maxChars = parseInt($('qa-maxchars').value, 10);
    const maxTokens = parseInt($('qa-maxtokens').value, 10);
    const timeoutSec = parseFloat($('qa-timeout').value);
    const interruptIntervalMs = parseInt($('qa-interrupt-interval').value, 10);

    return {
      enabled: $('qa-enabled').checked,
      cmds: cmds.length ? cmds : ['问问', '问一下'],
      apiUrl: $('qa-url').value.trim(),
      apiKey: $('qa-key').value.trim(),
      model: $('qa-model').value.trim(),
      persona: $('qa-persona').value.trim(),
      maxChars: isNaN(maxChars) || maxChars <= 0 ? 150 : maxChars,
      maxTokens: isNaN(maxTokens) || maxTokens <= 0 ? 256 : maxTokens,
      timeoutMs: isNaN(timeoutSec) || timeoutSec <= 0 ? 12000 : Math.round(timeoutSec * 1000),
      extra: $('qa-extra').value.trim(),
      interruptMode: $('qa-interrupt-mode') && $('qa-interrupt-mode').value === 'once' ? 'once' : 'burst',
      interruptIntervalMs: isNaN(interruptIntervalMs) || interruptIntervalMs <= 0 ? 350 : interruptIntervalMs,
      qaMode: $('qa-mode') && $('qa-mode').value === 'takeover' ? 'takeover' : 'fallback',
      freeFallback: !!($('qa-free-fallback') && $('qa-free-fallback').checked),
      aiHint: (function () {
        const v = $('qa-ai-hint') ? $('qa-ai-hint').value : 'off';
        return (v === 'tts' || v === 'sound') ? v : 'off';
      }()),
      aiHintText: $('qa-ai-hint-text') ? $('qa-ai-hint-text').value.trim() : '',
      aiHintHoldMs: (function () {
        const v = parseInt($('qa-ai-hint-hold') ? $('qa-ai-hint-hold').value : '', 10);
        return isNaN(v) || v <= 0 ? 1600 : v;
      }()),
      fallbackPatterns: String($('qa-fail-patterns') ? $('qa-fail-patterns').value : '')
        .split(/[\n\r]/).map(function (s) { return s.trim(); }).filter(Boolean),
      waitNativeMs: (function () {
        const v = parseInt($('qa-wait-native') ? $('qa-wait-native').value : '', 10);
        return isNaN(v) || v < 0 ? 800 : v;
      }())
    };
  }

  function applyConfig(cfg) {
    cfg = cfg || {};
    $('qa-enabled').checked = cfg.enabled !== false;
    $('qa-cmds').value = Array.isArray(cfg.cmds) && cfg.cmds.length ? cfg.cmds.join(', ') : '问问, 问一下';
    $('qa-url').value = cfg.apiUrl || PRESETS.siliconflow.url;
    $('qa-key').value = cfg.apiKey || '';
    $('qa-model').value = cfg.model || PRESETS.siliconflow.model;
    ensureModelOption(cfg.model || PRESETS.siliconflow.model);
    $('qa-persona').value = cfg.persona !== undefined ? cfg.persona : DEFAULT_PERSONA;
    $('qa-maxchars').value = cfg.maxChars || 150;
    $('qa-maxtokens').value = cfg.maxTokens || 256;
    $('qa-timeout').value = ((cfg.timeoutMs || 12000) / 1000).toFixed(0);
    $('qa-extra').value = cfg.extra !== undefined ? cfg.extra : PRESETS.siliconflow.extra;
    if ($('qa-interrupt-mode')) $('qa-interrupt-mode').value = cfg.interruptMode === 'once' ? 'once' : 'burst';
    if ($('qa-interrupt-interval')) $('qa-interrupt-interval').value = cfg.interruptIntervalMs || 350;
    if ($('qa-mode')) $('qa-mode').value = cfg.qaMode === 'takeover' ? 'takeover' : 'fallback';
    if ($('qa-free-fallback')) $('qa-free-fallback').checked = cfg.freeFallback === true;
    if ($('qa-ai-hint')) {
      const h = cfg.aiHint;
      $('qa-ai-hint').value = (h === 'tts' || h === 'sound') ? h : 'off';
    }
    if ($('qa-ai-hint-text')) $('qa-ai-hint-text').value = cfg.aiHintText || '稍等，我查一下';
    if ($('qa-ai-hint-hold')) $('qa-ai-hint-hold').value = cfg.aiHintHoldMs || 1600;

    // 词表：用户存过就原样回填；没存过（老配置 / 首次安装）用后端默认表预填，方便直接改
    if ($('qa-fail-patterns')) {
      if (Array.isArray(cfg.fallbackPatterns) && cfg.fallbackPatterns.length) {
        $('qa-fail-patterns').value = cfg.fallbackPatterns.join('\n');
      } else {
        $('qa-fail-patterns').value = DEFAULT_PATTERNS.join('\n');
      }
    }
    if ($('qa-wait-native')) $('qa-wait-native').value = cfg.waitNativeMs === undefined ? 800 : cfg.waitNativeMs;

    syncModeVisibility();

    // 恢复上次拉取的模型列表（同一接口地址），免得每次开页面都要重新点一次
    const cachedModels = readModelCache($('qa-url').value);
    if (cachedModels) {
      const n = setModelOptions(cachedModels);
      ensureModelOption($('qa-model').value);
      const tip = $('qa-model-tip');
      if (tip && n) tip.innerHTML = '已载入上次拉取的 <b>' + n + '</b> 个模型，点输入框即可下拉选择。';
    }
  }

  // ==========================================
  // 接管时机：补位 / 全接管
  // ==========================================
  /** 补位专属的三项（词表 / 等待时长 / 自由补位）只在补位模式下有意义 */
  function syncModeVisibility() {
    const mode = $('qa-mode') ? $('qa-mode').value : 'fallback';
    const show = mode !== 'takeover';
    ['qa-field-patterns', 'qa-field-wait', 'qa-field-freeroute'].forEach(function (id) {
      const el = $(id);
      if (el) el.style.display = show ? '' : 'none';
    });
    syncHintVisibility();
  }

  /** 文案与占位时长只在「语音提示」模式下才有意义 */
  function syncHintVisibility() {
    const on = $('qa-ai-hint') && $('qa-ai-hint').value === 'tts';
    ['qa-field-hint-text', 'qa-field-hint-hold'].forEach(function (id) {
      const el = $(id);
      if (el) el.style.display = on ? '' : 'none';
    });
  }

  async function resetPatterns() {
    if (!DEFAULT_PATTERNS.length) {
      try {
        const res = await apiGet('/qa/defaults');
        if (res && Array.isArray(res.patterns)) DEFAULT_PATTERNS = res.patterns;
      } catch (e) { /* 拉不到就只能是空的 */ }
    }
    if ($('qa-fail-patterns')) $('qa-fail-patterns').value = DEFAULT_PATTERNS.join('\n');
    scheduleSave();
  }

  /** 用当前词表试判一句原生回答 —— 真机上听到什么直接粘进来试，不用对着音箱喊 */
  async function judgeAnswer(btn) {
    const out = $('qa-judge-result');
    const text = String($('qa-judge-input').value || '').trim();
    if (!text) { if (out) out.innerHTML = '<span style="color: var(--md-error);">先粘一句小爱的回答</span>'; return; }

    const oldText = btn.innerText;
    btn.disabled = true;
    btn.innerText = '判定中…';
    if (out) out.innerHTML = '';
    try {
      const res = await apiPost('/qa/judge', {
        answer: text,
        patterns: String($('qa-fail-patterns').value || '').split(/[\n\r]/).map(function (s) { return s.trim(); }).filter(Boolean)
      });
      if (!res || !res.ok) {
        if (out) out.innerHTML = '<span style="color: var(--md-error);">❌ ' + escapeHtml((res && res.error) || '判定失败') + '</span>';
        return;
      }
      if (res.usable) {
        if (out) out.innerHTML = '<span style="color: var(--md-on-surface-variant);">🙊 判定为<b>答上来了</b> → 不接管，只听小爱的。</span>';
      } else {
        const why = res.reason === 'matched' ? '命中特征词「' + res.matched + '」'
          : res.reason === 'empty' ? '没抓到回答' : '回答太短';
        if (out) out.innerHTML = '<span style="color: var(--md-primary, #4caf50);">🧠 判定为<b>没答上来</b>（' + escapeHtml(why) + '）→ 交给大模型。</span>';
      }
    } catch (e) {
      if (out) out.innerHTML = '<span style="color: var(--md-error);">❌ ' + escapeHtml(String(e)) + '</span>';
    } finally {
      btn.disabled = false;
      btn.innerText = oldText;
    }
  }

  // ==========================================
  // 加载 / 保存
  // ==========================================
  async function loadConfig() {
    try {
      // 先把后端默认词表拉下来，后面 applyConfig 要用它预填
      try {
        const d = await apiGet('/qa/defaults');
        if (d && Array.isArray(d.patterns)) DEFAULT_PATTERNS = d.patterns;
      } catch (e) { /* 拉不到就不预填，后端仍会按默认表判定 */ }

      const res = await apiGet('/store?key=' + CFG_KEY);
      let cfg = null;
      if (res && res.data && res.data !== 'null' && res.data !== '[]') {
        try { cfg = typeof res.data === 'string' ? JSON.parse(res.data) : res.data; } catch (e) { cfg = null; }
      }
      if (cfg && typeof cfg === 'object') {
        applyConfig(cfg);
      } else {
        // 首次安装：写入一份默认配置（默认关闭，避免用户没填 Key 就误触发）
        applyConfig({ enabled: false });
        await saveConfig(true);
      }
      renderStatus();
    } catch (e) {
      console.warn('⚠️ 加载问答配置失败', e);
    }
  }

  async function saveConfig(silent) {
    const cfg = collectConfig();
    try {
      await apiPost('/store', { key: CFG_KEY, value: JSON.stringify(cfg) });
      if (!silent) console.log('✅ 问答配置已保存:', cfg);
      renderStatus();
    } catch (e) {
      console.warn('❌ 保存问答配置失败', e);
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveConfig(true); }, 400);
  }

  // 状态提示条：直接告诉用户“现在能不能用”
  function renderStatus() {
    const box = $('qa-status');
    if (!box) return;
    const cfg = collectConfig();
    const problems = [];
    if (!cfg.apiUrl) problems.push('未填 API 地址');
    if (!cfg.apiKey) problems.push('未填 API Key');
    if (!cfg.model) problems.push('未填模型名');

    if (!cfg.enabled) {
      box.innerHTML = '<span style="color: var(--md-on-surface-variant);">⏸️ 问答接管当前为【关闭】状态，口令不会生效。</span>';
      return;
    }
    if (problems.length) {
      box.innerHTML = '<span style="color: var(--md-error);">⚠️ 已启用，但配置不完整：' + escapeHtml(problems.join('、')) + '，触发时会直接播失败提示音。</span>';
      return;
    }
    box.innerHTML = '<span style="color: var(--md-primary, #4caf50);">✅ 已启用。说出「' +
      escapeHtml(cfg.cmds[0]) + ' + 你的问题」即可触发（如「' + escapeHtml(cfg.cmds[0]) + '今天天气怎么样」）。</span>';
  }

  // ==========================================
  // 预设切换
  // ==========================================
  function applyPreset() {
    const key = $('qa-preset').value;
    const p = PRESETS[key];
    if (!p || key === 'custom') return;
    $('qa-url').value = p.url;
    $('qa-model').value = p.model;
    $('qa-extra').value = p.extra;

    // 换供应商必须清掉旧列表，否则下拉里会出现别的家的模型
    const cached = readModelCache(p.url);
    setModelOptions(cached || []);
    ensureModelOption(p.model);
    const tip = $('qa-model-tip');
    if (tip) {
      tip.innerHTML = cached
        ? '已载入上次拉取的 <b>' + cached.length + '</b> 个模型，点输入框即可下拉选择。'
        : '点「获取模型」会从接口拉取可用模型列表，之后点输入框即可下拉选择。也可以直接手动输入。';
    }
  }

  // ==========================================
  // 模型列表：手动获取 → 下拉选择
  // ==========================================
  // 用 <input list=datalist>：点输入框就是下拉候选（等同下拉选择），
  // 但接口拉不到时仍能手动输入，不会把用户卡死。
  // 拉取结果缓存在浏览器本地（按接口地址区分），重开页面不用再点一次。
  const MODEL_CACHE_KEY = 'xiaoai_qa_models_cache_v1';

  function readModelCache(apiUrl) {
    try {
      const c = JSON.parse(localStorage.getItem(MODEL_CACHE_KEY) || 'null');
      if (c && c.apiUrl === apiUrl && Array.isArray(c.models) && c.models.length) return c.models;
    } catch (e) { /* 缓存坏了就当没有 */ }
    return null;
  }

  function writeModelCache(apiUrl, models) {
    try {
      localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({ apiUrl: apiUrl, models: models }));
    } catch (e) { /* 存不下就算了，不影响主流程 */ }
  }

  function setModelOptions(list) {
    const dl = $('qa-model-list');
    if (!dl) return 0;
    const uniq = [];
    (list || []).forEach(function (m) {
      m = String(m || '').trim();
      if (m && uniq.indexOf(m) === -1) uniq.push(m);
    });
    dl.innerHTML = uniq.map(function (m) {
      return '<option value="' + escapeHtml(m) + '"></option>';
    }).join('');
    return uniq.length;
  }

  /** 保证当前模型名一定在候选里，否则下拉框会显示成“空” */
  function ensureModelOption(model) {
    const dl = $('qa-model-list');
    const m = String(model || '').trim();
    if (!dl || !m) return;
    const opts = dl.querySelectorAll('option');
    for (let i = 0; i < opts.length; i++) {
      if (opts[i].value === m) return;
    }
    const o = document.createElement('option');
    o.value = m;
    dl.insertBefore(o, dl.firstChild);
  }

  async function fetchModels(btn) {
    const tip = $('qa-model-tip');
    const oldText = btn.innerText;
    const cfg = collectConfig();

    if (!cfg.apiUrl) { alert('请先填「接口地址」'); return; }
    if (!cfg.apiKey) { alert('请先填「API Key」'); return; }

    btn.disabled = true;
    btn.innerText = '获取中…';
    if (tip) tip.innerHTML = '正在请求接口…';

    try {
      const res = await apiPost('/qa/models', { apiUrl: cfg.apiUrl, apiKey: cfg.apiKey });
      if (!res || !res.ok) {
        const err = (res && res.error) || '未知错误';
        if (tip) tip.innerHTML = '<span style="color: var(--md-error);">❌ 获取失败：' + escapeHtml(err) + '（仍可手动输入模型名）</span>';
        return;
      }
      const models = res.models || [];
      const n = setModelOptions(models);
      ensureModelOption(cfg.model);
      writeModelCache(cfg.apiUrl, models);
      if (tip) {
        tip.innerHTML = '✅ 已拉取 <b>' + n + '</b> 个模型，点输入框即可下拉选择。' +
          '<span style="opacity:.7;">（来源：' + escapeHtml(res.source || '') + '）</span>';
      }
      // 重新渲染状态（模型名可能仍是空）
      renderStatus();
    } catch (e) {
      if (tip) tip.innerHTML = '<span style="color: var(--md-error);">❌ 获取异常：' + escapeHtml(String(e)) + '</span>';
    } finally {
      btn.disabled = false;
      btn.innerText = oldText;
    }
  }

  // ==========================================
  // 测试连接
  // ==========================================
  async function testConnection(btn) {
    const box = $('qa-test-result');
    const oldText = btn.innerText;
    btn.disabled = true;
    btn.innerText = '测试中…';
    box.style.display = 'block';
    box.innerHTML = '<div style="font-size: 12px; color: var(--md-on-surface-variant);">正在请求大模型，请稍候…</div>';

    try {
      const cfg = collectConfig();
      const res = await apiPost('/qa/test', cfg);

      const logsHtml = (res.logs || []).map(function (l) {
        return '<div style="font-size: 11px; color: var(--md-on-surface-variant); line-height: 1.6;">' + escapeHtml(l) + '</div>';
      }).join('');

      if (res.ok) {
        box.innerHTML = logsHtml +
          '<div style="font-size: 13px; color: var(--md-primary, #4caf50); margin-top: 8px;">✅ 调用成功，模型回答如下（这就是音箱会念的内容）：</div>' +
          '<div style="background: var(--md-surface-variant, rgba(0,0,0,0.04)); border-radius: 6px; padding: 10px 12px; margin-top: 8px; font-size: 14px; line-height: 1.7; color: var(--md-on-surface);">' +
          escapeHtml(res.answer) + '</div>' +
          '<div style="font-size: 11px; color: var(--md-on-surface-variant); margin-top: 6px;">共 ' + (res.answer || '').length + ' 字</div>';
      } else {
        box.innerHTML = logsHtml +
          '<div style="font-size: 13px; color: var(--md-error); margin-top: 8px;">❌ 调用失败：' + escapeHtml(res.error || '未取得回答，请检查上面的日志') + '</div>';
      }
    } catch (e) {
      box.innerHTML = '<div style="font-size: 13px; color: var(--md-error);">❌ 测试异常：' + escapeHtml(String(e)) + '</div>';
    } finally {
      btn.disabled = false;
      btn.innerText = oldText;
    }
  }

  // ==========================================
  // 初始化
  // ==========================================
  document.addEventListener('DOMContentLoaded', function () {
    if (!$('qa-url')) return;

    // 所有输入 → 防抖自动保存
    ['qa-enabled', 'qa-cmds', 'qa-url', 'qa-key', 'qa-model', 'qa-persona',
      'qa-maxchars', 'qa-maxtokens', 'qa-timeout', 'qa-extra',
      'qa-mode', 'qa-fail-patterns', 'qa-wait-native', 'qa-free-fallback',
      'qa-ai-hint', 'qa-ai-hint-text', 'qa-ai-hint-hold',
      'qa-interrupt-mode', 'qa-interrupt-interval'].forEach(function (id) {
        const el = $(id);
        if (!el) return;
        el.addEventListener('change', scheduleSave);
        el.addEventListener('input', scheduleSave);
      });

    // 预设切换：自动填 URL / 模型 / 扩展字段，并立即保存
    $('qa-preset').addEventListener('change', function () {
      applyPreset();
      saveConfig(true);
    });

    // 手改接口地址 → 清掉旧供应商的模型列表（缓存按地址区分，会自动恢复匹配的那份）
    $('qa-url').addEventListener('change', function () {
      const cached = readModelCache($('qa-url').value);
      setModelOptions(cached || []);
      ensureModelOption($('qa-model').value);
    });

    // 获取模型列表 → 下拉选择
    $('qa-btn-models').addEventListener('click', function () { fetchModels(this); });

    // 测试连接
    $('qa-btn-test').addEventListener('click', function () { testConnection(this); });

    // 接管模式切换 → 显示/隐藏补位专属项
    $('qa-mode').addEventListener('change', function () {
      syncModeVisibility();
      saveConfig(true);
    });

    // 恢复默认词表 / 试判一句原生回答
    $('qa-btn-reset-patterns').addEventListener('click', function () { resetPatterns(); });
    $('qa-btn-judge').addEventListener('click', function () { judgeAnswer(this); });

    // 提示方式切换 → 显示/隐藏文案与占位时长
    $('qa-ai-hint').addEventListener('change', function () {
      syncHintVisibility();
      saveConfig(true);
    });

    loadConfig();
  });
})();
