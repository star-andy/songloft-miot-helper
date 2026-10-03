// src/qa.ts
/// <reference types="@songloft/plugin-sdk" />

// ==========================================
// 🧠 问答接管引擎：人设提示词 + OpenAI 兼容大模型
// ------------------------------------------
// 设计要点（依据真机实测约束，见 docs/qa-takeover-design.md）：
//   1. 提示词三层拼装：硬约束(代码锁死) + 人设(用户可改) + 场景(自动注入)
//      —— 用户改人设不会连带丢掉长度约束，这是 mi-song-gpt 的坑。
//   2. 双闸控长：max_tokens 是"强制"，提示词只是"请求"，两者都要。
//   3. 沙箱无 AbortController → 超时用 Promise.race + setTimeout 兜底。
//   4. 沙箱 fetch 不支持流式 → 整段生成完再播（实测结论，不做流式）。
// ==========================================

/** 问答接管的全部可配置项（前端设置页可改） */
export interface QaConfig {
    /** 总开关 */
    enabled?: boolean;
    /** 触发口令词，如 ["问问", "问一下"] */
    cmds?: string[];
    /** OpenAI 兼容的 chat/completions 完整地址 */
    apiUrl?: string;
    apiKey?: string;
    model?: string;
    /** 人设：唯一由用户编辑的提示词层 */
    persona?: string;
    /** 回答字数上限（代码侧硬截断，兜底模型不听话） */
    maxChars?: number;
    /** 模型侧 max_tokens 上限（真正的强制闸） */
    maxTokens?: number;
    /** 请求超时（毫秒） */
    timeoutMs?: number;
    temperature?: number;
    /** 扩展字段（JSON 字符串），如 {"enable_thinking": false} */
    extra?: string;
    /**
     * 打断小爱原生应答的方式：
     *   'burst'（默认）—— 在等待大模型期间按固定间隔反复下发 stop，直到答案就绪；
     *   'once'         —— 只下发一次 stop（旧行为）。
     * 为什么要 burst：小爱原生回答与 query 同帧到达，但设备**何时起播**我们看不到，
     * 单发 stop 可能正好落在"还没起播"的空档上而空转，导致原生回答照念一遍。
     */
    interruptMode?: 'burst' | 'once';
    /** 连续打断的间隔（毫秒），仅 interruptMode='burst' 时生效 */
    interruptIntervalMs?: number;
    /**
     * 接管时机：
     *   'fallback'（默认）—— 只补位：小爱答得上来就闭嘴，只有它答不上来时才让大模型上；
     *   'takeover'        —— 全接管：每次都掐掉小爱的原生回答、改念大模型的。
     * 为什么默认从 takeover 改成 fallback：真机实测连续下发 4 次停止指令仍压不住小爱的语音播报
     * （设备侧起播时机不可控，抢不过它）→ 与其抢，不如只在它答不上来时补位。
     */
    qaMode?: 'fallback' | 'takeover';
    /** 「小爱答不上来」的特征词；字符串按换行分隔，或字符串数组。留空 = 永不接管 */
    fallbackPatterns?: string[] | string;
    /** 命中口令后，若原生回答还没到，最多再等多少毫秒再判定（0 = 不等） */
    waitNativeMs?: number;
    /**
     * 自由补位（默认 false）：**没喊口令词**时，若小爱这一轮答不上来，也让大模型补位。
     * 只在 qaMode='fallback' 下生效；开启后普通对话也可能被抢，故默认关闭。
     */
    freeFallback?: boolean;
    /**
     * 确定要调大模型时，先给用户一句前置提示（别让人以为没听见）：
     *   'off'    —— 不提示（默认关）
     *   'tts'    —— 用 TTS 说一句短话（推荐，如「稍等，我查一下」）
     *   'sound'  —— 复用全局设置里的前置提示音
     * ⚠️ 开启时会**自动改用单发打断**：连续打断窗口每 350ms 补一发 stop，
     *    会把插件自己刚播的提示语掐掉。
     */
    aiHint?: 'off' | 'tts' | 'sound';
    /** 前置语音提示的文案（仅 aiHint='tts' 时用），别太长，1~2 秒最佳 */
    aiHintText?: string;
    /** 提示语最短占位时间（毫秒）：大模型比它还快时要等它播完再送答案 */
    aiHintHoldMs?: number;
}

export const QA_DEFAULTS = {
    maxChars: 150,
    maxTokens: 256,
    timeoutMs: 12000,
    cmds: ['问问', '问一下'],
    interruptMode: 'burst' as 'burst' | 'once',
    interruptIntervalMs: 350,
    qaMode: 'fallback' as 'fallback' | 'takeover',
    waitNativeMs: 800,
    aiHint: 'off' as 'off' | 'tts' | 'sound',
    aiHintText: '稍等，我查一下',
    aiHintHoldMs: 1600
};

// ------------------------------------------
// ⑤ 「小爱答不上来」的默认特征词表
// ------------------------------------------
// 命中任一即判定为「原生没答上来」→ 交给大模型。
// 覆盖的几类：明确拒答 / 能力缺失 / 没听清 / 答不上来 / 检索失败 / 服务异常。
export const NATIVE_FAIL_PATTERNS: string[] = [
    '抱歉', '对不起', '不好意思',
    '暂不支持', '暂未支持', '不支持', '未支持',
    '还没学会', '没学会', '不会这个',
    '没听懂', '没听清', '没听明白', '没有听清', '没有听懂', '没太听清', '没太听懂', '我还在学习',
    '再说一遍', '请再说', '重新说一遍', '换个问题',
    '不知道', '答不上来', '回答不了', '没法回答', '无法回答', '无法为你', '暂时无法',
    '没有找到', '没找到', '找不到', '没查到', '查不到', '搜索不到',
    '出错了', '网络不太好', '网络异常', '网络不给力', '稍后再试', '请稍后', '连接失败', '服务异常'
];

// ------------------------------------------
// ① 硬约束层（代码常量，不可被用户配置覆盖）
// ------------------------------------------
function buildHardRules(maxChars: number): string {
    return [
        '你是一个智能音箱的语音助手，你的回答会被直接转成语音念出来。',
        '必须用口语化的短句回答，像跟人聊天一样，不要书面语。',
        `严格控制字数：全文不超过 ${maxChars} 个字。`,
        '禁止使用任何格式符号：不要 markdown、不要列表、不要标题、不要代码块、不要加粗、不要 emoji。',
        '不要复述用户的问题，直接给答案。',
        '不确定或不知道的事就直说不知道，绝对不要编造。',
        '不要在回答里提到"AI""模型""助手""根据我的知识"这类身份词。'
    ].join('\n');
}

// ------------------------------------------
// ③ 末尾重申层（LLM 对末尾指令更敏感，且长上下文会稀释开头约束）
// ------------------------------------------
function buildTailRule(maxChars: number): string {
    return `（再次强调：用口语直接回答，不超过 ${maxChars} 个字，不要任何格式符号。）`;
}

// ------------------------------------------
// ④ 参考层：音箱刚才自己的回答
// ------------------------------------------
// 为什么需要它：小爱常常已经答对了（尤其是天气、时间、新闻这类实时信息），
// 而大模型没有实时数据、只能编。若不带上它，就会出现「掐掉正确的、播出错误的」。
// 判断权交给模型而不是代码穷举兜底话术 —— 提示词明确要求它自己识别“没答上”的情况。
function buildReferenceRule(reference: string): string {
    return [
        '【音箱刚才的回答】',
        '下面是音箱在你提问后给出的回答，它可能包含实时信息（天气、时间、新闻等），你的知识库里没有。',
        '请先判断它有没有真正回答用户的问题：',
        '· 若它答上了 —— 就以它的事实为准，用更简洁自然的口语重述，不要改动其中的事实、数字与结论；',
        '· 若它只是在说不会、没听清、答非所问或语焉不详 —— 忽略它，用你自己的知识回答。',
        '音箱的回答：' + reference
    ].join('\n');
}

/** 小爱原生回答的粗筛（只做长度过滤，是否可用由模型判断） */
export function normalizeNativeAnswer(raw: any): string {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length < 4) return ''; // 太短，无参考价值
    return s.length > 500 ? s.slice(0, 500) : s;
}

/** 判定用的归一化：抹掉空白与常见标点，避免「抱歉，目前暂不支持该功能」因标点而漏匹配 */
function normalizeForMatch(s: any): string {
    return String(s == null ? '' : s)
        .replace(/[\s\u3000]/g, '')
        .replace(/[，。！？、；：""''（）《》〈〉【】·…—\-~,.!?;:'"()<>[\]]/g, '')
        .toLowerCase();
}

/** 把用户填的特征词（字符串按换行/逗号分隔，或数组）解析成数组；空 = 未配置 */
export function parsePatternList(input: any): string[] {
    if (Array.isArray(input)) {
        return input.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
    }
    const s = String(input == null ? '' : input);
    if (!s.trim()) return [];
    return s.split(/[\n\r,，;；]/).map((x) => x.trim()).filter(Boolean);
}

export interface NativeVerdict {
    /** 小爱是否算「答上来了」 */
    usable: boolean;
    /** ok=答上来了；empty=没抓到回答；too-short=太短不像回答；matched=命中失败特征词；takeover=全接管模式不做判定 */
    reason: 'ok' | 'empty' | 'too-short' | 'matched' | 'takeover';
    /** 命中的特征词（reason==='matched' 时有值） */
    matched: string;
}

/**
 * 判断小爱的原生回答算不算「答上来了」。
 * 未配置特征词（undefined / 空数组）时使用内置默认表 NATIVE_FAIL_PATTERNS。
 * 注意：用户**显式清空**特征词会得到一个空数组，此时什么都不匹配 → 永不接管。
 */
export function judgeNativeAnswer(raw: any, patterns?: string[] | string): NativeVerdict {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return { usable: false, reason: 'empty', matched: '' };

    const norm = normalizeForMatch(text);
    if (norm.length < 2) return { usable: false, reason: 'too-short', matched: '' };

    // ⚠️ 区分「没配过」和「配了空的」：
    //    undefined/null   → 用内置默认表（老配置升级上来就是这个情况）
    //    显式空数组/空串  → 一个都不匹配，等于"永不接管"（用户可以这么关掉补位）
    const list = patterns == null ? NATIVE_FAIL_PATTERNS : parsePatternList(patterns);

    for (const p of list) {
        const np = normalizeForMatch(p);
        if (!np) continue;
        if (norm.indexOf(np) >= 0) return { usable: false, reason: 'matched', matched: String(p) };
    }
    return { usable: true, reason: 'ok', matched: '' };
}

export function formatNow(): string {
    try {
        const d = new Date();
        const p = (n: number) => (n < 10 ? '0' : '') + n;
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch (e) {
        return '';
    }
}

/** 拼装 system 提示词：硬约束 + 人设 + 场景 + 参考回答 + 末尾重申 */
export function buildSystemPrompt(cfg: QaConfig, scene?: { now?: string; deviceName?: string; reference?: string }): string {
    const maxChars = clampNumber(cfg.maxChars, 20, 1000, QA_DEFAULTS.maxChars);
    const parts: string[] = [buildHardRules(maxChars)];

    const persona = String(cfg.persona || '').trim();
    if (persona) parts.push('【人设】\n' + persona);

    const sceneLines: string[] = [];
    if (scene && scene.now) sceneLines.push(`当前时间：${scene.now}`);
    if (scene && scene.deviceName) sceneLines.push(`当前设备：${scene.deviceName}`);
    if (sceneLines.length) parts.push('【场景】\n' + sceneLines.join('\n'));

    const reference = String((scene && scene.reference) || '').trim();
    if (reference) parts.push(buildReferenceRule(reference));

    parts.push(buildTailRule(maxChars));
    return parts.join('\n\n');
}

function clampNumber(v: any, min: number, max: number, def: number): number {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return def;
    return Math.max(min, Math.min(max, n));
}

// ------------------------------------------
// 清洗：把模型输出变成适合 TTS 念的纯文本
// ------------------------------------------
export function sanitizeForTTS(raw: string): string {
    let s = String(raw || '');

    // 思维链标签（Qwen3 / DeepSeek-R1 等）
    s = s.replace(/<think[\s\S]*?<\/think>/gi, '');
    s = s.replace(/<thinking[\s\S]*?<\/thinking>/gi, '');
    s = s.replace(/<\|[\s\S]*?\|>/g, '');
    s = s.replace(/^(?:思考过程|思维链)[:：][\s\S]*?(?=\n\n|$)/, '');

    // 代码块与行内代码
    s = s.replace(/```[\s\S]*?```/g, ' ');
    s = s.replace(/`([^`]*)`/g, '$1');

    // 图片 / 链接
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

    // 裸 URL
    s = s.replace(/https?:\/\/[^\s，。；！？、）)】"']+/gi, ' ');

    // 脚注角标 [1] [12]
    s = s.replace(/\[\d+\]/g, '');

    // markdown 行前缀：标题 / 引用 / 无序列表 / 有序列表
    s = s.replace(/^[ \t]*#{1,6}[ \t]*/gm, '');
    s = s.replace(/^[ \t]*>[ \t]*/gm, '');
    s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '');
    s = s.replace(/^[ \t]*\d+[.、)][ \t]+/gm, '');

    // 强调与表格符号
    s = s.replace(/[*_~|]/g, '');
    s = s.replace(/-{3,}/g, ' ');

    // 空白归一
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

/** 按字数上限硬截断，尽量截在完整句子上 */
export function clampLength(text: string, maxChars: number): { text: string; truncated: boolean } {
    const s = String(text || '').trim();
    if (!maxChars || maxChars <= 0 || s.length <= maxChars) return { text: s, truncated: false };

    const head = s.slice(0, maxChars);
    const stops = ['。', '！', '？', '；', '!', '?', ';', '，', ','];
    let cut = -1;
    for (const p of stops) {
        const i = head.lastIndexOf(p);
        if (i > cut) cut = i;
    }
    // 句末标点要落在后半段才值得保留，否则意群太碎
    if (cut >= Math.floor(maxChars * 0.5)) {
        return { text: head.slice(0, cut + 1), truncated: true };
    }
    return { text: head.replace(/[，,、；;：:]+$/, '') + '。', truncated: true };
}

// ------------------------------------------
// 错误规范化：三种形态（OpenAI 对象 / 硅基流动 401 裸字符串 / 纯文本）
// ------------------------------------------
export function normalizeError(status: number, bodyText: string | null | undefined): string {
    const t = String(bodyText || '').trim();
    if (t) {
        try {
            const j = JSON.parse(t);
            if (typeof j === 'string') return `${status} ${j}`; // 硅基流动 401 → "Invalid token"
            const m = (j && j.error && j.error.message) || (j && j.message) || (j && j.error) || (j && j.msg);
            if (m) return `${status} ${String(m)}`;
        } catch (e) {
            return `${status} ${t.slice(0, 200)}`;
        }
    }
    if (status === 401) return '401 认证失败（请检查 API Key）';
    if (status === 403) return '403 无权访问（Key 可能无该模型权限）';
    if (status === 404) return '404 接口地址或模型名不存在';
    if (status === 429) return '429 请求过于频繁或余额不足';
    if (status >= 500) return `${status} 服务端错误`;
    return `${status} 请求失败`;
}

function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------
// 模型列表：由 chat/completions 地址推导 GET /models，供前端下拉选择
// ------------------------------------------
/** `/v1/chat/completions` → `/v1/models`；兼容智谱 `/api/paas/v4/...` 这类带多级前缀的地址 */
export function deriveModelsUrl(apiUrl: string): string {
    const u = String(apiUrl || '').trim().split('?')[0].replace(/\/+$/, '');
    if (!u) return '';
    if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '/models');
    if (/\/models$/i.test(u)) return u;
    if (/\/completions$/i.test(u)) return u.replace(/\/completions$/i, '/models');
    const m = u.match(/^(.*\/v\d+[a-z0-9]*)(?:\/.*)?$/i);
    if (m) return m[1] + '/models';
    return u + '/models';
}

/** 非对话类模型（嵌入 / 重排 / 语音 / 绘图）排序时沉到后面 */
function isChatModel(id: string): boolean {
    return !/embed|rerank|bge|m3e|gte-|tts|voice|speech|whisper|audio|image|stable|flux|kolors|cogview|wan-|upscale|moderation|asr/i.test(id);
}

export interface ModelListResult {
    ok: boolean;
    models: string[];
    error?: string;
    /** 实际请求的地址，便于排障 */
    source?: string;
}

/**
 * 拉取供应商的可用模型（OpenAI 兼容 GET /models）。
 * 结构与 askLlm 保持一致：无 AbortController，超时用 Promise.race 兜底。
 */
export async function fetchModelList(
    apiUrl: string,
    apiKey: string,
    logFn: (msg: string) => void
): Promise<ModelListResult> {
    const u = String(apiUrl || '').trim();
    const k = String(apiKey || '').trim();
    if (!u) return { ok: false, models: [], error: '未填接口地址' };
    if (!k) return { ok: false, models: [], error: '未填 API Key' };

    const modelsUrl = deriveModelsUrl(u);
    logFn(`📋 [问答] 拉取模型列表: ${modelsUrl}`);

    let res: any;
    let timer: any = null;
    const timeoutPromise = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('__MODELS_TIMEOUT__')), 15000);
    });
    try {
        res = await Promise.race([
            fetch(modelsUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${k}` } }),
            timeoutPromise
        ]);
    } catch (e: any) {
        const m = String((e && e.message) || e);
        const msg = m === '__MODELS_TIMEOUT__' ? '请求超时（15s）' : m;
        logFn(`⚠️ [问答] 拉取模型列表失败: ${msg}`);
        return { ok: false, models: [], error: msg, source: modelsUrl };
    } finally {
        if (timer) clearTimeout(timer);
    }

    if (!res || typeof res.text !== 'function') {
        logFn('⚠️ [问答] 模型列表响应对象异常');
        return { ok: false, models: [], error: '响应对象异常', source: modelsUrl };
    }

    let text = '';
    try {
        text = await res.text();
    } catch (e) {
        logFn('⚠️ [问答] 读取模型列表响应体失败');
        return { ok: false, models: [], error: '读取响应体失败', source: modelsUrl };
    }

    if (!res.ok) {
        const msg = normalizeError(res.status, text);
        logFn(`⚠️ [问答] 拉取模型列表失败: ${msg}`);
        return { ok: false, models: [], error: msg, source: modelsUrl };
    }

    // 兼容三种结构：{data:[{id}]} / {models:[...]} / 裸数组
    let j: any = null;
    try { j = JSON.parse(text); } catch (e) { /* 取不到数组时下面会返回空 */ }
    const raw: any[] = j
        ? (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : Array.isArray(j) ? j : [])
        : [];

    const seen: Record<string, boolean> = {};
    const ids: string[] = [];
    for (const item of raw) {
        const id = typeof item === 'string' ? item : (item && (item.id || item.name || item.model));
        if (typeof id !== 'string') continue;
        const v = id.trim();
        if (!v || seen[v]) continue;
        seen[v] = true;
        ids.push(v);
    }

    if (!ids.length) {
        logFn('⚠️ [问答] 接口返回的模型列表为空（可能不是 OpenAI 兼容的 /models 结构）');
        return { ok: false, models: [], error: '接口未返回模型列表（可能不是 OpenAI 兼容的 /models 格式）', source: modelsUrl };
    }

    // 对话类优先，同类按字母序
    ids.sort((a, b) => {
        const ca = isChatModel(a) ? 0 : 1;
        const cb = isChatModel(b) ? 0 : 1;
        if (ca !== cb) return ca - cb;
        return a < b ? -1 : a > b ? 1 : 0;
    });

    logFn(`✅ [问答] 拉到 ${ids.length} 个模型`);
    return { ok: true, models: ids, source: modelsUrl };
}

// ------------------------------------------
// 主调用：整段生成（沙箱不支持流式，这是唯一可行路径）
// ------------------------------------------
export async function askLlm(
    cfg: QaConfig,
    question: string,
    logFn: (msg: string) => void,
    scene?: { now?: string; deviceName?: string },
    reference?: string
): Promise<string | null> {
    const url = String(cfg.apiUrl || '').trim();
    if (!url) { logFn('❌ [问答] 未配置 API 地址，已熔断'); return null; }

    const apiKey = String(cfg.apiKey || '').trim();
    if (!apiKey) { logFn('❌ [问答] 未配置 API Key，已熔断'); return null; }

    const model = String(cfg.model || '').trim();
    if (!model) { logFn('❌ [问答] 未配置模型名，已熔断'); return null; }

    const q = String(question || '').trim();
    if (!q) { logFn('❌ [问答] 问题为空，已熔断'); return null; }

    const maxChars = clampNumber(cfg.maxChars, 20, 1000, QA_DEFAULTS.maxChars);
    const maxTokens = clampNumber(cfg.maxTokens, 32, 4096, QA_DEFAULTS.maxTokens);
    const timeoutMs = clampNumber(cfg.timeoutMs, 3000, 60000, QA_DEFAULTS.timeoutMs);

    // 扩展字段（各家私有参数透传）
    let extra: Record<string, any> = {};
    if (cfg.extra) {
        try {
            const parsed = typeof cfg.extra === 'string' ? JSON.parse(cfg.extra) : cfg.extra;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed;
        } catch (e) {
            logFn('⚠️ [问答] 扩展字段不是合法 JSON，已忽略');
        }
    }

    const refText = String(reference || '').trim();
    const promptScene = Object.assign({}, scene || {}, refText ? { reference: refText } : {});

    const payload: any = {
        model,
        messages: [
            { role: 'system', content: buildSystemPrompt(cfg, promptScene) },
            { role: 'user', content: q }
        ],
        stream: false,
        max_tokens: maxTokens
    };
    const temp = Number(cfg.temperature);
    if (isFinite(temp) && temp >= 0) payload.temperature = temp;
    for (const k of Object.keys(extra)) payload[k] = extra[k];

    logFn(`🧠 [问答] 请求大模型: ${model} | 问题: "${q.length > 60 ? q.slice(0, 60) + '…' : q}" | 上限 ${maxChars} 字${refText ? ` | 参考 ${refText.length} 字` : ''}`);

    const started = Date.now();

    // ⚠️ 沙箱无 AbortController：只能放弃等待，无法真正断开连接
    let res: any;
    let timer: any = null;
    const timeoutPromise = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('__QA_TIMEOUT__')), timeoutMs);
    });

    try {
        res = await Promise.race([
            fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload)
            }),
            timeoutPromise
        ]);
    } catch (e: any) {
        const m = String((e && e.message) || e);
        if (m === '__QA_TIMEOUT__') logFn(`⚠️ [问答] 大模型请求超时（${timeoutMs}ms）`);
        else logFn(`⚠️ [问答] 大模型请求异常: ${m}`);
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }

    if (!res || typeof res.text !== 'function') {
        logFn('⚠️ [问答] 响应对象异常，无法读取内容');
        return null;
    }

    let bodyText = '';
    try {
        bodyText = await res.text();
    } catch (e) {
        logFn(`⚠️ [问答] 读取响应体失败: ${e}`);
        return null;
    }

    if (!res.ok) {
        logFn(`⚠️ [问答] 大模型返回错误 —— ${normalizeError(res.status, bodyText)}`);
        return null;
    }

    let data: any = null;
    try {
        data = JSON.parse(bodyText);
    } catch (e) {
        logFn('⚠️ [问答] 响应不是合法 JSON');
        return null;
    }

    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    const content = msg && msg.content;
    const reasoning = msg && (msg.reasoning_content || msg.reasoning);

    if (!content || typeof content !== 'string' || !content.trim()) {
        if (reasoning) logFn('⚠️ [问答] 模型只返回了思维链、没有正文（建议在扩展字段设置 enable_thinking=false）');
        else logFn('⚠️ [问答] 模型返回内容为空');
        return null;
    }

    const cleaned = sanitizeForTTS(content);
    const clamped = clampLength(cleaned, maxChars);
    const cost = Date.now() - started;

    if (!clamped.text) { logFn('⚠️ [问答] 清洗后无有效内容'); return null; }

    logFn(`✅ [问答] 生成完成 ${cost}ms | 原始 ${content.length} 字 → 清洗 ${cleaned.length} 字${clamped.truncated ? ` → 截断 ${clamped.text.length} 字` : ''}`);
    return clamped.text;
}
