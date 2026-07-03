/*══════════════════════════════════════════════════════════════
  Puffs Timer — Obsidian 计时器插件
  ──────────────────────────────────────────────────────────────
  功能概览：
    · 倒计时 / 正计时（侧边栏面板 + 状态栏同步显示）
    · 每日定时提醒（支持按星期循环、弹窗编辑）
    · 正计时累计提醒（每隔 N 分钟提示音）
    · 定时关机（提前 15 分钟预警）
══════════════════════════════════════════════════════════════*/

const { Plugin, ItemView, setIcon, PluginSettingTab, Setting, Notice, Modal } = require('obsidian');
const { exec } = require('child_process');

/* ═══════════════════════════════════════════
   常量 & 默认配置
   ═══════════════════════════════════════════ */

/** 侧边栏视图的唯一标识符 */
const VIEW_TYPE = 'puffs-timer-view';

/** 星期显示顺序：周一 → 周日（符合中文习惯） */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** 星期简称（索引 0=日, 1=一, ..., 6=六） */
const DAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

/** 星期全称（用于设置面板列表展示） */
const DAY_FULL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 代表"每天"的完整星期数组 */
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** 插件默认设置（首次加载或字段缺失时的回退值） */
const DEFAULT_SETTINGS = {
    countdownAutoOutline: false,   // 倒计时开始/继续时自动跳转大纲
    countupAutoOutline:   false,   // 正计时开始/继续时自动跳转大纲
    statusBarCountdown:   true,    // 状态栏显示倒计时
    statusBarCountup:     true,    // 状态栏显示正计时
    enableShutdown:       true,    // 启用定时关机
    shutdownTime:         '',      // 关机时间，格式 "HH:MM"
    dailyReminders:       [],      // 每日定时提醒列表 [{time, label, enabled, days}]
    onetimeAlarms:        [],      // 一次性闹钟列表 [{time, label, targetDate}]
    countupNotifyMinutes: 0,      // 正计时累计提醒间隔（分钟），0 = 关闭
    countupDailyTotal:    0,       // 今日累计正计时（秒），每日自动清零
    countupDailyDate:     '',      // 累计正计时的日期标记，用于跨日清零
};

/* ═══════════════════════════════════════════
   工具函数
   ═══════════════════════════════════════════ */

/**
 * 将数字补零为两位字符串
 * @example pad2(5) → "05", pad2(12) → "12"
 */
function pad2(n) {
    return String(n).padStart(2, '0');
}

/**
 * 将秒数分解为 时/分/秒 对象
 * @param   {number} sec - 总秒数（非负整数）
 * @returns {{h: number, m: number, s: number}}
 */
function splitSeconds(sec) {
    return {
        h: Math.floor(sec / 3600),
        m: Math.floor((sec % 3600) / 60),
        s: sec % 60,
    };
}

/**
 * 将秒数格式化为 "HH : MM : SS" 用于显示面板
 * @param {number} sec - 总秒数
 * @returns {{h: string, m: string, s: string}} 各段已补零的字符串
 */
function formatHMS(sec) {
    const { h, m, s } = splitSeconds(sec);
    return { h: pad2(h), m: pad2(m), s: pad2(s) };
}

/**
 * 将数值限制在 [min, max] 范围内
 */
function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

/**
 * 获取今天的日期字符串（格式 "YYYY-MM-DD"）
 * 用于跨日清零判断
 */
function getTodayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 将秒数格式化为人类友好的时长描述
 * @example 3661 → "1小时1分钟", 45 → "不到1分钟"
 */
function formatDuration(seconds) {
    const { h, m } = splitSeconds(seconds);
    if (h > 0 && m > 0) return `${h}小时${m}分钟`;
    if (h > 0) return `${h}小时`;
    if (m > 0) return `${m}分钟`;
    if (seconds > 0) return '不到1分钟';
    return '0分钟';
}

/**
 * 将秒数格式化为状态栏的紧凑时长
 * @example 3700 → "1h 1m", 120 → "2m", 30 → "<1m"
 */
function formatCompactTime(seconds) {
    if (seconds >= 3600) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return m === 0 ? `${h}h` : `${h}h ${m}m`;
    }
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
    return '<1m';
}

/**
 * 校验时间字符串是否为合法的 "HH:MM" 格式
 * @param   {string} str - 待校验的字符串
 * @returns {{h: number, m: number}|null} 合法则返回时/分对象，否则返回 null
 */
function parseTimeStr(str) {
    const match = str.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (h > 23 || m > 59) return null;
    return { h, m };
}

/**
 * 将提醒数组按时间升序排列（原地排序）
 */
function sortReminders(arr) {
    arr.sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * 将一次性闹钟数组按日期+时间升序排列（原地排序）
 */
function sortOneTimeAlarms(arr) {
    arr.sort((a, b) => {
        const dc = a.targetDate.localeCompare(b.targetDate);
        if (dc !== 0) return dc;
        return a.time.localeCompare(b.time);
    });
}

/**
 * 校验日期字符串是否为合法的 "YYYY-MM-DD" 格式
 * @param   {string} str - 待校验的字符串
 * @returns {boolean}
 */
function isValidDateStr(str) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    const [y, m, d] = str.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/**
 * 将星期数组格式化为可读文本
 * @example [1,2,3,4,5] → "工作日", [0,6] → "周末", [1,3,5] → "周一 周三 周五"
 */
function formatDays(days) {
    if (!days || days.length === 7) return '每天';
    if (days.length === 0) return '未选择';
    const s = new Set(days);
    if (s.size === 5 && [1, 2, 3, 4, 5].every(d => s.has(d))) return '工作日';
    if (s.size === 2 && s.has(0) && s.has(6)) return '周末';
    return DAY_ORDER.filter(d => s.has(d)).map(d => DAY_FULL[d]).join(' ');
}

/* ═══════════════════════════════════════════
   主插件类
   ═══════════════════════════════════════════ */
class PuffsTimerPlugin extends Plugin {

    async onload() {
        await this.loadSettings();
        this.checkDailyReset();

        /** 当前活跃的视图实例引用（面板关闭时为 null） */
        this.timerView = null;

        /** 记录当日已触发的提醒，防止同一分钟内重复触发 */
        this.firedReminders = new Set();

        /* ── 注册侧边栏视图类型 ── */
        this.registerView(VIEW_TYPE, leaf => {
            this.timerView = new PuffsTimerView(leaf, this);
            return this.timerView;
        });

        /* ── 左侧 Ribbon 图标 ── */
        this.addRibbonIcon('timer', 'Puffs Timer', () => this.activateView());

        /* ── 命令面板命令 ── */
        this.addCommand({
            id: 'open-puffs-timer',
            name: '打开计时器面板',
            callback: () => this.activateView(),
        });
        this.addCommand({
            id: 'start-countup',
            name: '开始正计时',
            callback: async () => {
                await this.ensureView();
                if (this.timerView?.state === 'idle') {
                    this.timerView.totalSeconds = 0;
                    this.timerView.remainingSeconds = 0;
                    this.timerView.renderDisplay(0);
                    this.timerView.handlePlayPause();
                } else if (this.timerView?.state === 'paused' && this.timerView.mode === 'countup') {
                    this.timerView.handlePlayPause();
                }
            },
        });

        /* ── 状态栏：显示计时信息 ── */
        this.initStatusBar();

        /* ── 设置页 ── */
        this.addSettingTab(new PuffsTimerSettingTab(this.app, this));

        /* ── 定时关机 & 每日提醒 ── */
        this.scheduleShutdown();
        this.startReminderCheck();
    }

    onunload() {
        this.clearShutdownTimer();
        this.clearReminderCheck();
    }

    /* ────────── 视图管理 ────────── */

    /** 打开并聚焦计时器侧边栏面板 */
    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            leaf = workspace.getRightLeaf(false);
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    /** 静默确保视图实例已创建（不聚焦面板，用于命令调用前的前置准备） */
    async ensureView() {
        if (this.timerView) return;
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            leaf = workspace.getRightLeaf(false);
        }
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }

    /* ────────── 设置持久化 ────────── */

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /* ────────── 状态栏 ────────── */

    /** 初始化状态栏元素，并绑定鼠标交互事件 */
    initStatusBar() {
        this.statusBarEl = this.addStatusBarItem();
        this.statusBarEl.addClass('puffs-status-bar');
        this.statusBarIconEl = this.statusBarEl.createSpan({ cls: 'puffs-status-bar-icon' });
        this.statusBarTextEl = this.statusBarEl.createSpan({ cls: 'puffs-status-bar-text' });
        this.statusBarEl.hide();

        /*
         * 交互规则：
         *   短按（< 300ms）→ 暂停 / 继续计时
         *   长按（≥ 300ms）→ 打开计时器面板
         */
        let pressTimer = null;
        let isLongPress = false;

        this.statusBarEl.addEventListener('mousedown', () => {
            isLongPress = false;
            pressTimer = setTimeout(() => { isLongPress = true; this.activateView(); }, 300);
        });
        this.statusBarEl.addEventListener('mouseup', () => {
            clearTimeout(pressTimer);
            if (!isLongPress && this.timerView?.state !== 'idle') {
                this.timerView.handlePlayPause();
            }
        });
        this.statusBarEl.addEventListener('mouseleave', () => clearTimeout(pressTimer));
    }

    /**
     * 根据计时器当前状态刷新状态栏的 显示/隐藏、图标、文本
     * @param {'idle'|'running'|'paused'} state - 计时器状态
     * @param {'countdown'|'countup'}      mode  - 计时模式
     * @param {number}                     sec   - 当前显示秒数
     */
    updateStatusBar(state, mode, sec) {
        /* 判断当前模式是否允许在状态栏展示 */
        const visible =
            (state === 'running' || state === 'paused') &&
            ((mode === 'countdown' && this.settings.statusBarCountdown) ||
             (mode === 'countup'   && this.settings.statusBarCountup));

        if (!visible) { this.statusBarEl.hide(); return; }

        this.statusBarEl.show();
        this.statusBarIconEl.empty();
        if (state === 'paused') setIcon(this.statusBarIconEl, 'pause');
        this.statusBarTextEl.setText(formatCompactTime(sec));
    }

    /* ────────── 定时关机 ────────── */

    /** 清除关机检查定时器 */
    clearShutdownTimer() {
        if (this.shutdownCheckInterval != null) {
            window.clearInterval(this.shutdownCheckInterval);
            this.shutdownCheckInterval = null;
        }
    }

    /**
     * 根据设置中的关机时间，启动每分钟轮询：
     *   - 距关机 ≤15 分钟时弹窗预警并播放提示音
     *   - 到达关机时间后执行系统关机命令
     */
    scheduleShutdown() {
        this.clearShutdownTimer();
        if (!this.settings.enableShutdown || !this.settings.shutdownTime) return;

        const parsed = parseTimeStr(this.settings.shutdownTime);
        if (!parsed) return;

        /* 计算下一个关机目标时刻（若今天已过则推到明天） */
        const calcTarget = () => {
            const now = new Date();
            const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsed.h, parsed.m);
            if (target <= now) target.setDate(target.getDate() + 1);
            return target;
        };

        this.shutdownTarget = calcTarget();
        this.shutdownWarned = false;

        /* 每分钟检查一次距关机的剩余时间 */
        this.shutdownCheckInterval = window.setInterval(() => {
            const remaining = this.shutdownTarget.getTime() - Date.now();

            /* 提前 15 分钟预警（仅触发一次） */
            if (remaining <= 900_000 && remaining > 0 && !this.shutdownWarned) {
                this.shutdownWarned = true;
                // new Notice('⚠️ 电脑将在 15 分钟后关机！', 900_000);
                // this.playDing();
                // setTimeout(() => this.playDing(), 2000);
                // setTimeout(() => this.playDing(), 4000);
            }

            /* 时间到达：执行关机，并将目标推到次日 */
            if (remaining <= 0) {
                exec('shutdown /s /t 0', err => {
                    if (err) console.error('Puffs Timer: 关机命令执行失败', err);
                });
                this.shutdownTarget.setDate(this.shutdownTarget.getDate() + 1);
                this.shutdownWarned = false;
            }
        }, 60_000);
    }

    /* ────────── 每日定时提醒 ────────── */

    /** 启动提醒检查轮询（每 30 秒检查一次，首次延迟 3 秒以避免启动瞬间误触发） */
    startReminderCheck() {
        this.clearReminderCheck();
        this.reminderCheckInterval = window.setInterval(() => {
            this.checkReminders();
            this.checkOneTimeAlarms();
        }, 30_000);
        setTimeout(() => {
            this.checkReminders();
            this.checkOneTimeAlarms();
        }, 3000);
    }

    /** 清除提醒检查定时器 */
    clearReminderCheck() {
        if (this.reminderCheckInterval != null) {
            window.clearInterval(this.reminderCheckInterval);
            this.reminderCheckInterval = null;
        }
    }

    /** 逐条检查所有已启用的提醒，若当前时间匹配则弹窗并播放提示音 */
    checkReminders() {
        const now = new Date();
        const today = getTodayStr();
        const currentHM = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
        const currentDay = now.getDay(); // 0=周日, 1=周一, ..., 6=周六

        /* 清除前一天的已触发记录（跨日后旧记录已无效） */
        for (const key of this.firedReminders) {
            if (!key.startsWith(today)) this.firedReminders.delete(key);
        }

        for (const r of this.settings.dailyReminders) {
            if (!r.enabled) continue;

            /* 兼容旧数据：无 days 字段视为每天 */
            const days = r.days || ALL_DAYS;
            if (!days.includes(currentDay)) continue;

            const key = `${today}|${r.time}`;
            if (this.firedReminders.has(key)) continue;

            if (r.time === currentHM) {
                this.firedReminders.add(key);
                this.playDing();
                setTimeout(() => this.playDing(), 2000);
                new Notice(r.label, 10_000);
            }
        }
    }

    /* ────────── 一次性闹钟 ────────── */

    /** 检查并触发/清理一次性闹钟 */
    checkOneTimeAlarms() {
        const now = new Date();
        const today = getTodayStr();
        const currentHM = pad2(now.getHours()) + ':' + pad2(now.getMinutes());

        let changed = false;
        const remaining = [];

        for (const alarm of this.settings.onetimeAlarms) {
            /* 日期已过 → 过期删除 */
            if (alarm.targetDate < today) { changed = true; continue; }

            if (alarm.targetDate === today) {
                if (alarm.time === currentHM) {
                    /* 时间匹配 → 触发提醒并删除 */
                    const key = `onetime|${alarm.targetDate}|${alarm.time}`;
                    if (!this.firedReminders.has(key)) {
                        this.firedReminders.add(key);
                        this.playDing();
                        setTimeout(() => this.playDing(), 2000);
                        new Notice(alarm.label, 10_000);
                    }
                    changed = true;
                    continue;
                }
                if (alarm.time < currentHM) {
                    /* 今天的时间已过 → 过期删除 */
                    changed = true;
                    continue;
                }
            }
            remaining.push(alarm);
        }

        if (changed) {
            this.settings.onetimeAlarms = remaining;
            this.saveSettings();
        }
    }

    /* ────────── 正计时累计管理 ────────── */

    /** 跨日时将今日累计清零 */
    checkDailyReset() {
        const today = getTodayStr();
        if (this.settings.countupDailyDate !== today) {
            this.settings.countupDailyTotal = 0;
            this.settings.countupDailyDate = today;
            this.saveSettings();
        }
    }

    /**
     * 获取今日累计正计时的总秒数
     * 包含已持久化部分 + 当前会话中尚未刷盘的部分
     */
    getDailyTotal() {
        this.checkDailyReset();
        let total = this.settings.countupDailyTotal;
        /* 若当前正在正计时运行/暂停，追加未刷盘的秒数 */
        if (this.timerView?.mode === 'countup' && this.timerView.state !== 'idle') {
            total += this.timerView.elapsedSeconds - this.timerView.countupSessionFlushed;
        }
        return total;
    }

    /* ────────── 提示音 ────────── */

    /** 使用 Web Audio API 播放一声 700Hz 正弦波提示音（时长 1.5 秒，渐弱） */
    playDing() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            const ctx  = new AudioCtx();
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.type = 'sine';
            osc.frequency.setValueAtTime(700, ctx.currentTime);
            gain.gain.setValueAtTime(0.5, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);

            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 1.5);
        } catch (e) {
            console.error('Puffs Timer: 播放提示音失败', e);
        }
    }
}

/* ═══════════════════════════════════════════
   计时器视图（右侧边栏面板）
   ═══════════════════════════════════════════ */
class PuffsTimerView extends ItemView {

    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;

        /* ── 计时器核心状态 ── */
        this.totalSeconds     = 0;         // 倒计时总秒数（由用户设定）
        this.remainingSeconds = 0;         // 倒计时剩余秒数
        this.elapsedSeconds   = 0;         // 正计时已过秒数
        this.intervalId       = null;      // setInterval 返回的 ID
        this.state            = 'idle';    // 状态机：idle → running ⇄ paused → idle
        this.mode             = 'countdown'; // 模式：countdown（倒计时）| countup（正计时）

        /*
         * 墙上时钟基准——用于防止后台标签页被浏览器节流（throttle）
         * 导致 setInterval 回调延迟，从而计时出现漂移。
         * 每次 startTick 时记录当前 Date.now() 和对应秒数，
         * 后续回调中用 (Date.now() - referenceTime) 计算真实流逝时间。
         */
        this.referenceTime    = 0;
        this.referenceSeconds = 0;

        /* ── 正计时累计提醒：上次触发提示音时的已计秒数 ── */
        this.lastNotifyElapsed = 0;

        /* ── 正计时日累计：已刷盘到 settings 的秒数（避免重复计入） ── */
        this.countupSessionFlushed = 0;
    }

    getViewType()    { return VIEW_TYPE; }
    getDisplayText() { return 'Puffs Timer'; }
    getIcon()        { return 'timer'; }

    async onOpen()   { this.build(); }

    async onClose()  {
        this.flushCountupSession();  // 面板关闭前将未保存的正计时秒数落盘
        this.stopInterval();
        this.state = 'idle';
        this.plugin.timerView = null;
        this.plugin.updateStatusBar('idle', this.mode, 0);
    }

    /* ────────── 定时器引擎 ────────── */

    /** 清除当前的 setInterval */
    stopInterval() {
        if (this.intervalId != null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * 启动计时引擎
     * 基于墙上时钟（Date.now）而非依赖 setInterval 的回调频率，
     * 确保即使浏览器将后台标签页的定时器节流至每秒 1 次也能精确计时。
     */
    startTick() {
        this.stopInterval();
        this.referenceTime = Date.now();

        if (this.mode === 'countdown') {
            this.referenceSeconds = this.remainingSeconds;
            this.intervalId = window.setInterval(() => {
                const wallElapsed = Math.floor((Date.now() - this.referenceTime) / 1000);
                this.remainingSeconds = Math.max(0, this.referenceSeconds - wallElapsed);
                this.renderDisplay(this.remainingSeconds);
                this.syncStatusBar();

                /* 倒计时归零：播放提示音 → 恢复初始值 → 回到空闲态 */
                if (this.remainingSeconds <= 0) {
                    this.stopInterval();
                    this.plugin.playDing();
                    this.state = 'idle';
                    this.remainingSeconds = this.totalSeconds;
                    this.renderDisplay(this.totalSeconds);
                    this.refreshUI();
                    this.syncStatusBar();
                }
            }, 1000);
        } else {
            /* 正计时：递增 */
            this.referenceSeconds = this.elapsedSeconds;
            this.intervalId = window.setInterval(() => {
                const wallElapsed = Math.floor((Date.now() - this.referenceTime) / 1000);
                this.elapsedSeconds = this.referenceSeconds + wallElapsed;
                this.renderDisplay(this.elapsedSeconds);
                this.syncStatusBar();

                /* 累计提醒：每隔 N 分钟播放一次提示音 */
                const interval = this.plugin.settings.countupNotifyMinutes * 60;
                if (interval > 0 && this.elapsedSeconds >= this.lastNotifyElapsed + interval) {
                    this.lastNotifyElapsed = Math.floor(this.elapsedSeconds / interval) * interval;
                    this.plugin.playDing();
                }
            }, 1000);
        }
    }

    /**
     * 精确快照当前秒数
     * 在暂停瞬间调用，用墙上时钟纠正最后一个 interval 周期内的漂移
     */
    snapshotSeconds() {
        const wallElapsed = Math.floor((Date.now() - this.referenceTime) / 1000);
        if (this.mode === 'countdown') {
            this.remainingSeconds = Math.max(0, this.referenceSeconds - wallElapsed);
        } else {
            this.elapsedSeconds = this.referenceSeconds + wallElapsed;
        }
    }

    /** 获取当前应显示的秒数（倒计时取剩余，正计时取已过） */
    get displaySeconds() {
        return this.mode === 'countdown' ? this.remainingSeconds : this.elapsedSeconds;
    }

    /* ────────── 正计时累计刷盘 ────────── */

    /** 将当前会话中尚未持久化的正计时秒数写入 settings 并保存 */
    flushCountupSession() {
        if (this.mode !== 'countup' || this.state === 'idle') return;
        const delta = this.elapsedSeconds - this.countupSessionFlushed;
        if (delta > 0) {
            this.plugin.checkDailyReset();
            this.plugin.settings.countupDailyTotal += delta;
            this.countupSessionFlushed = this.elapsedSeconds;
            this.plugin.saveSettings();
        }
    }

    /* ────────── 构建 UI ────────── */

    build() {
        const root = this.contentEl;
        root.empty();
        root.addClass('puffs-timer-root');

        this.wrapper = root.createDiv({ cls: 'puffs-timer-wrapper' });

        /* ── 时间显示区域（空闲态可点击编辑各段数字） ── */
        this.displayEl = this.wrapper.createDiv({ cls: 'puffs-timer-display' });

        this.hSpan = this.displayEl.createEl('span', { cls: 'puffs-digit', text: '00' });
        this.displayEl.createEl('span', { cls: 'puffs-display-sep', text: ' : ' });
        this.mSpan = this.displayEl.createEl('span', { cls: 'puffs-digit', text: '30' });
        this.displayEl.createEl('span', { cls: 'puffs-display-sep', text: ' : ' });
        this.sSpan = this.displayEl.createEl('span', { cls: 'puffs-digit', text: '00' });

        /* 点击数字 span → 进入内联编辑模式 */
        this.hSpan.addEventListener('click', e => { e.stopPropagation(); this.editDigit(this.hSpan, 'h'); });
        this.mSpan.addEventListener('click', e => { e.stopPropagation(); this.editDigit(this.mSpan, 'm'); });
        this.sSpan.addEventListener('click', e => { e.stopPropagation(); this.editDigit(this.sSpan, 's'); });

        /* ── 操作按钮区域 ── */
        const controls = this.wrapper.createDiv({ cls: 'puffs-timer-controls' });

        this.playBtn = controls.createEl('button', { cls: 'puffs-timer-btn puffs-btn-play' });
        setIcon(this.playBtn, 'play');
        this.playBtn.addEventListener('click', () => this.handlePlayPause());

        this.resetBtn = controls.createEl('button', { cls: 'puffs-timer-btn puffs-btn-reset' });
        setIcon(this.resetBtn, 'rotate-ccw');
        this.resetBtn.addEventListener('click', () => this.handleReset());

        /* 初始渲染 */
        this.renderDisplay(this.totalSeconds);
        this.refreshUI();
    }

    /* ────────── 点击编辑数字 ────────── */

    /**
     * 将某个数字 span 替换为内联输入框，用户可直接键入新数值
     * @param {HTMLElement} span - 目标 span 元素（时/分/秒之一）
     * @param {'h'|'m'|'s'}  unit - 该 span 代表的单位
     */
    editDigit(span, unit) {
        /* 仅空闲态允许编辑，且防止在同一 span 上重复创建输入框 */
        if (this.state !== 'idle' || span.querySelector('input')) return;

        const { h, m, s } = splitSeconds(this.totalSeconds);
        const curVal = unit === 'h' ? h : unit === 'm' ? m : s;
        const maxVal = unit === 'h' ? 99 : 59;

        /* 创建内联 number 输入框 */
        const input = document.createElement('input');
        input.type      = 'number';
        input.className = 'puffs-digit-input';
        input.value     = String(curVal);
        input.min       = '0';
        input.max       = String(maxVal);

        span.setText('');
        span.appendChild(input);
        input.focus();
        input.select();

        /** 提交编辑：将输入值写回 totalSeconds */
        const commit = () => {
            const val = clamp(parseInt(input.value) || 0, 0, maxVal);
            const parts = splitSeconds(this.totalSeconds);
            parts[unit] = val;
            this.totalSeconds = parts.h * 3600 + parts.m * 60 + parts.s;
            this.remainingSeconds = this.totalSeconds;
            this.renderDisplay(this.totalSeconds);
        };

        let committed = false;
        input.addEventListener('blur', () => {
            if (!committed) { committed = true; commit(); }
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') input.blur();
            if (e.key === 'Escape') {
                committed = true;
                this.renderDisplay(this.totalSeconds); // 取消编辑，恢复原值
            }
        });
    }

    /* ────────── 数据渲染 ────────── */

    /** 更新时间显示面板的 时/分/秒 文本 */
    renderDisplay(sec) {
        const { h, m, s: sVal } = formatHMS(sec);
        this.hSpan.setText(h);
        this.mSpan.setText(m);
        this.sSpan.setText(sVal);
    }

    /* ────────── 操作逻辑 ────────── */

    /**
     * 播放/暂停 按钮的核心处理逻辑（状态机驱动）
     *
     * 状态流转：
     *   idle    → running  （开始计时）
     *   running → paused   （暂停）
     *   paused  → running  （继续）
     */
    handlePlayPause() {
        switch (this.state) {
            case 'idle': {
                /* 判断模式：设定值为 0 则进入正计时，否则倒计时 */
                if (this.totalSeconds === 0) {
                    this.mode = 'countup';
                    this.elapsedSeconds = 0;
                    this.lastNotifyElapsed = 0;
                    this.countupSessionFlushed = 0;
                } else {
                    this.mode = 'countdown';
                    this.remainingSeconds = this.totalSeconds;
                }
                this.state = 'running';
                this.startTick();
                this.tryAutoOutline();
                break;
            }
            case 'running': {
                this.state = 'paused';
                this.stopInterval();
                /* 暂停瞬间用墙上时钟做精确快照 */
                this.snapshotSeconds();
                this.renderDisplay(this.displaySeconds);
                if (this.mode === 'countup') this.flushCountupSession();
                break;
            }
            case 'paused': {
                this.state = 'running';
                this.startTick();
                this.tryAutoOutline();
                break;
            }
        }
        this.refreshUI();
        this.syncStatusBar();
    }

    /** 重置：停止计时，恢复初始状态 */
    handleReset() {
        this.stopInterval();

        if (this.mode === 'countup') {
            this.flushCountupSession();
            this.elapsedSeconds = 0;
            this.totalSeconds = 0;
            this.countupSessionFlushed = 0;
            this.lastNotifyElapsed = 0;
            this.renderDisplay(0);
        } else {
            this.remainingSeconds = this.totalSeconds;
            this.renderDisplay(this.totalSeconds);
        }

        this.state = 'idle';
        this.mode = 'countdown';
        this.refreshUI();
        this.syncStatusBar();
    }

    /** 同步状态栏显示 */
    syncStatusBar() {
        this.plugin.updateStatusBar(this.state, this.mode, this.displaySeconds);
    }

    /**
     * 根据设置决定是否自动跳转到大纲面板
     * 仅在计时开始或继续时调用
     */
    tryAutoOutline() {
        const shouldSwitch =
            (this.mode === 'countdown' && this.plugin.settings.countdownAutoOutline) ||
            (this.mode === 'countup'   && this.plugin.settings.countupAutoOutline);
        if (shouldSwitch) {
            try { this.app.commands.executeCommandById('outline:open'); }
            catch (e) { console.warn('Puffs Timer: 无法打开大纲面板', e); }
        }
    }

    /* ────────── UI 刷新 ────────── */

    /** 根据当前状态同步 CSS 类和按钮图标 */
    refreshUI() {
        const idle = this.state === 'idle';
        this.displayEl.toggleClass('is-editable', idle);
        this.displayEl.toggleClass('is-running',  this.state === 'running');
        this.displayEl.toggleClass('is-paused',   this.state === 'paused');

        this.playBtn.empty();
        setIcon(this.playBtn, this.state === 'running' ? 'pause' : 'play');
    }
}

/* ═══════════════════════════════════════════
   设置页
   ═══════════════════════════════════════════ */
class PuffsTimerSettingTab extends PluginSettingTab {

    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        this.renderReminderSection(containerEl);
        this.renderOneTimeAlarmSection(containerEl);
        this.renderShutdownSection(containerEl);
        this.renderCountupSection(containerEl);
        this.renderStatusBarSection(containerEl);
        this.renderOutlineSection(containerEl);
    }

    /* ── 自动跳转大纲 ── */

    renderOutlineSection(el) {
        el.createEl('h2', { text: '自动跳转大纲' });

        this.addToggle(el, '倒计时自动跳转大纲',
            '开启后，倒计时开始或继续时自动跳转到大纲面板',
            'countdownAutoOutline');

        this.addToggle(el, '正计时自动跳转大纲',
            '开启后，正计时开始或继续时自动跳转到大纲面板',
            'countupAutoOutline');
    }

    /* ── 状态栏 ── */

    renderStatusBarSection(el) {
        el.createEl('h2', { text: '状态栏' });

        this.addToggle(el, '状态栏显示倒计时',
            '开启后，倒计时运行或暂停时在右下角状态栏显示剩余时间',
            'statusBarCountdown',
            () => this.plugin.timerView?.syncStatusBar());

        this.addToggle(el, '状态栏显示正计时',
            '开启后，正计时运行或暂停时在右下角状态栏显示累计时间',
            'statusBarCountup',
            () => this.plugin.timerView?.syncStatusBar());
    }

    /* ── 正计时 ── */

    renderCountupSection(el) {
        el.createEl('h2', { text: '正计时' });

        /* 累计提醒间隔 */
        new Setting(el)
            .setName('累计提醒间隔（分钟）')
            .setDesc('正计时每累计多少分钟发出一次提示音，0 = 关闭')
            .addText(t => t
                .setPlaceholder('30')
                .setValue(String(this.plugin.settings.countupNotifyMinutes))
                .onChange(async v => {
                    this.plugin.settings.countupNotifyMinutes = Math.max(0, parseInt(v) || 0);
                    await this.plugin.saveSettings();
                }));

        /* 今日累计统计 + 清零按钮 */
        new Setting(el)
            .setName('今日累计正计时')
            .setDesc('已累计 ' + formatDuration(this.plugin.getDailyTotal()))
            .addExtraButton(btn => btn
                .setIcon('rotate-ccw')
                .setTooltip('清零今日累计')
                .onClick(async () => {
                    this.plugin.settings.countupDailyTotal = 0;
                    await this.plugin.saveSettings();
                    this.display(); // 刷新设置面板以更新显示
                }));
    }

    /* ── 每日定时提醒 ── */

    renderReminderSection(el) {
        el.createEl('h2', { text: '每日定时提醒' });

        /* 确保列表按时间升序排列 */
        sortReminders(this.plugin.settings.dailyReminders);

        /* 逐条渲染已有的提醒 */
        for (let i = 0; i < this.plugin.settings.dailyReminders.length; i++) {
            this.renderReminderItem(el, i);
        }

        /* 末尾：添加新提醒的表单 */
        this.renderAddReminder(el);
    }

    /** 渲染单条提醒的设置行（含 启用开关、编辑按钮、删除按钮） */
    renderReminderItem(el, index) {
        const reminder = this.plugin.settings.dailyReminders[index];
        const days = reminder.days || ALL_DAYS;

        new Setting(el)
            .setName(reminder.label || '未命名提醒')
            .setDesc(`${formatDays(days)}  ${reminder.time}`)
            .addToggle(t => t
                .setValue(reminder.enabled)
                .onChange(async v => {
                    reminder.enabled = v;
                    await this.plugin.saveSettings();
                }))
            .addExtraButton(btn => btn
                .setIcon('pencil')
                .setTooltip('编辑')
                .onClick(() => {
                    new ReminderEditModal(this.app, reminder, async updated => {
                        Object.assign(reminder, updated);
                        sortReminders(this.plugin.settings.dailyReminders);
                        await this.plugin.saveSettings();
                        this.display();
                    }).open();
                }))
            .addExtraButton(btn => btn
                .setIcon('trash')
                .setTooltip('删除')
                .onClick(async () => {
                    this.plugin.settings.dailyReminders.splice(index, 1);
                    await this.plugin.saveSettings();
                    this.display();
                }));
    }

    /** 渲染"添加新提醒"表单行 */
    renderAddReminder(el) {
        let timeInput, labelInput;

        new Setting(el)
            .setName('添加新提醒')
            .addText(t => {
                timeInput = t;
                t.setPlaceholder('HH:MM');
                t.inputEl.style.width = '80px';
            })
            .addText(t => {
                labelInput = t;
                t.setPlaceholder('提醒内容');
            })
            .addExtraButton(btn => btn
                .setIcon('plus')
                .setTooltip('添加（默认每天）')
                .onClick(async () => {
                    const timeStr = timeInput.getValue().trim();
                    const label   = labelInput.getValue().trim();

                    const parsed = parseTimeStr(timeStr);
                    if (!parsed)  { new Notice('⚠️ 时间格式不正确，请使用 HH:MM 格式'); return; }
                    if (!label)   { new Notice('⚠️ 请输入提醒内容'); return; }

                    this.plugin.settings.dailyReminders.push({
                        time: pad2(parsed.h) + ':' + pad2(parsed.m),
                        label,
                        enabled: true,
                        days: [...ALL_DAYS],
                    });
                    sortReminders(this.plugin.settings.dailyReminders);
                    await this.plugin.saveSettings();
                    this.display();
                }));
    }

    /* ── 一次性闹钟 ── */

    renderOneTimeAlarmSection(el) {
        el.createEl('h2', { text: '一次性闹钟' });

        sortOneTimeAlarms(this.plugin.settings.onetimeAlarms);

        for (let i = 0; i < this.plugin.settings.onetimeAlarms.length; i++) {
            this.renderOneTimeAlarmItem(el, i);
        }

        this.renderAddOneTimeAlarm(el);
    }

    /** 渲染单条一次性闹钟的设置行（仅 编辑、删除 按钮，无启用开关） */
    renderOneTimeAlarmItem(el, index) {
        const alarm = this.plugin.settings.onetimeAlarms[index];

        new Setting(el)
            .setName(alarm.label || '未命名闹钟')
            .setDesc(`${alarm.targetDate}  ${alarm.time}`)
            .addExtraButton(btn => btn
                .setIcon('pencil')
                .setTooltip('编辑')
                .onClick(() => {
                    new OneTimeAlarmEditModal(this.app, alarm, async updated => {
                        Object.assign(alarm, updated);
                        sortOneTimeAlarms(this.plugin.settings.onetimeAlarms);
                        await this.plugin.saveSettings();
                        this.display();
                    }).open();
                }))
            .addExtraButton(btn => btn
                .setIcon('trash')
                .setTooltip('删除')
                .onClick(async () => {
                    this.plugin.settings.onetimeAlarms.splice(index, 1);
                    await this.plugin.saveSettings();
                    this.display();
                }));
    }

    /** 渲染"添加新闹钟"表单行 */
    renderAddOneTimeAlarm(el) {
        let dateInput, timeInput, labelInput;

        new Setting(el)
            .setName('添加新闹钟')
            .addText(t => {
                dateInput = t;
                t.setPlaceholder('YYYY-MM-DD');
                t.setValue(getTodayStr());
                t.inputEl.style.width = '110px';
            })
            .addText(t => {
                timeInput = t;
                t.setPlaceholder('HH:MM');
                t.inputEl.style.width = '80px';
            })
            .addText(t => {
                labelInput = t;
                t.setPlaceholder('提醒内容');
            })
            .addExtraButton(btn => btn
                .setIcon('plus')
                .setTooltip('添加')
                .onClick(async () => {
                    const dateStr = dateInput.getValue().trim();
                    const timeStr = timeInput.getValue().trim();
                    const label   = labelInput.getValue().trim();

                    if (!isValidDateStr(dateStr)) { new Notice('⚠️ 日期格式不正确，请使用 YYYY-MM-DD 格式'); return; }

                    const parsed = parseTimeStr(timeStr);
                    if (!parsed) { new Notice('⚠️ 时间格式不正确，请使用 HH:MM 格式'); return; }
                    if (!label)  { new Notice('⚠️ 请输入提醒内容'); return; }

                    const today = getTodayStr();
                    const now = new Date();
                    const currentHM = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
                    const normalizedTime = pad2(parsed.h) + ':' + pad2(parsed.m);

                    if (dateStr < today || (dateStr === today && normalizedTime <= currentHM)) {
                        new Notice('⚠️ 闹钟时间必须在当前时间之后');
                        return;
                    }

                    this.plugin.settings.onetimeAlarms.push({
                        time: normalizedTime,
                        label,
                        targetDate: dateStr,
                    });
                    sortOneTimeAlarms(this.plugin.settings.onetimeAlarms);
                    await this.plugin.saveSettings();
                    this.display();
                }));
    }

    /* ── 定时关机 ── */

    renderShutdownSection(el) {
        el.createEl('h2', { text: '定时关机' });

        new Setting(el)
            .setName('启用定时关机')
            .setDesc('开启后，每天到达设定时间时自动关机（关机前 15 分钟会弹窗提醒）')
            .addToggle(t => t
                .setValue(this.plugin.settings.enableShutdown)
                .onChange(async v => {
                    this.plugin.settings.enableShutdown = v;
                    await this.plugin.saveSettings();
                    this.plugin.scheduleShutdown();
                }));

        new Setting(el)
            .setName('关机时间')
            .setDesc('24 小时制，格式 HH:MM，例如 23:30')
            .addText(t => t
                .setPlaceholder('23:30')
                .setValue(this.plugin.settings.shutdownTime)
                .onChange(async v => {
                    this.plugin.settings.shutdownTime = v;
                    await this.plugin.saveSettings();
                    this.plugin.scheduleShutdown();
                }));
    }

    /* ── 设置页通用辅助方法 ── */

    /**
     * 快速创建一个 Toggle 开关设置项
     * @param {HTMLElement} el          - 父容器
     * @param {string}      name        - 设置项名称
     * @param {string}      desc        - 设置项描述
     * @param {string}      settingKey  - settings 中对应的字段名
     * @param {Function}    [onAfter]   - 值变化后的额外回调
     */
    addToggle(el, name, desc, settingKey, onAfter) {
        new Setting(el)
            .setName(name)
            .setDesc(desc)
            .addToggle(t => t
                .setValue(this.plugin.settings[settingKey])
                .onChange(async v => {
                    this.plugin.settings[settingKey] = v;
                    await this.plugin.saveSettings();
                    onAfter?.();
                }));
    }
}

/* ═══════════════════════════════════════════
   提醒编辑弹窗
   ═══════════════════════════════════════════ */
class ReminderEditModal extends Modal {

    /**
     * @param {App}      app      - Obsidian App 实例
     * @param {object}   reminder - 要编辑的提醒对象 {time, label, days}
     * @param {Function} onSave   - 保存回调，接收更新后的数据
     */
    constructor(app, reminder, onSave) {
        super(app);
        /* 拷贝一份副本，避免取消操作时污染原数据 */
        this.data = {
            time:  reminder.time,
            label: reminder.label,
            days:  [...(reminder.days || ALL_DAYS)],
        };
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('puffs-reminder-modal');
        contentEl.createEl('h3', { text: '编辑提醒' });

        /* ── 时间输入 ── */
        new Setting(contentEl)
            .setName('时间')
            .addText(t => {
                this.timeInput = t;
                t.setValue(this.data.time);
                t.setPlaceholder('HH:MM');
                t.inputEl.style.width = '80px';
            });

        /* ── 提醒内容输入 ── */
        new Setting(contentEl)
            .setName('提醒内容')
            .addText(t => {
                this.labelInput = t;
                t.setValue(this.data.label);
                t.setPlaceholder('如：吃午饭');
            });

        /* ── 循环天数选择 ── */
        const daySetting = new Setting(contentEl).setName('循环天数');
        this.buildDayPicker(daySetting.controlEl);

        /* ── 底部操作按钮 ── */
        const footer = contentEl.createDiv({ cls: 'puffs-modal-footer' });

        const saveBtn = footer.createEl('button', { text: '保存', cls: 'mod-cta' });
        saveBtn.addEventListener('click', () => this.handleSave());

        const cancelBtn = footer.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }

    /**
     * 构建星期选择器（7 个日按钮 + "每天/工作日/周末"快捷选项）
     * @param {HTMLElement} parentEl - 挂载到的父容器
     */
    buildDayPicker(parentEl) {
        const wrap = parentEl.createDiv({ cls: 'puffs-days-wrap' });

        /* 逐日渲染切换按钮 */
        for (const d of DAY_ORDER) {
            const isActive = this.data.days.includes(d);
            const btn = wrap.createEl('button', {
                text: DAY_SHORT[d],
                cls: 'puffs-day-btn' + (isActive ? ' is-active' : ''),
            });
            btn.addEventListener('click', e => {
                e.preventDefault();
                const pos = this.data.days.indexOf(d);
                if (pos >= 0) { this.data.days.splice(pos, 1); btn.removeClass('is-active'); }
                else           { this.data.days.push(d);        btn.addClass('is-active'); }
            });
        }

        /* 快捷选项：一键设置"每天""工作日""周末" */
        const shortcuts = parentEl.createDiv({ cls: 'puffs-days-shortcuts' });
        const presets = [
            { text: '每天',   days: [...ALL_DAYS] },
            { text: '工作日', days: [1, 2, 3, 4, 5] },
            { text: '周末',   days: [0, 6] },
        ];
        for (const preset of presets) {
            const a = shortcuts.createEl('a', { text: preset.text, cls: 'puffs-days-shortcut' });
            a.addEventListener('click', e => {
                e.preventDefault();
                this.data.days = [...preset.days];
                /* 同步刷新所有日按钮的激活状态 */
                wrap.querySelectorAll('.puffs-day-btn').forEach((b, i) => {
                    b.toggleClass('is-active', preset.days.includes(DAY_ORDER[i]));
                });
            });
        }
    }

    /** 保存按钮的点击处理：校验输入 → 回调通知外部 → 关闭弹窗 */
    handleSave() {
        const timeStr = this.timeInput.getValue().trim();
        const label   = this.labelInput.getValue().trim();

        /* 逐项校验 */
        const parsed = parseTimeStr(timeStr);
        if (!parsed)                   { new Notice('⚠️ 时间格式不正确'); return; }
        if (!label)                    { new Notice('⚠️ 请输入提醒内容'); return; }
        if (this.data.days.length === 0) { new Notice('⚠️ 请至少选择一天'); return; }

        this.data.time  = pad2(parsed.h) + ':' + pad2(parsed.m);
        this.data.label = label;
        this.onSave(this.data);
        this.close();
    }
}

/* ═══════════════════════════════════════════
   一次性闹钟编辑弹窗
   ═══════════════════════════════════════════ */
class OneTimeAlarmEditModal extends Modal {

    /**
     * @param {App}      app     - Obsidian App 实例
     * @param {object}   alarm   - 要编辑的闹钟对象 {time, label, targetDate}
     * @param {Function} onSave  - 保存回调，接收更新后的数据
     */
    constructor(app, alarm, onSave) {
        super(app);
        this.data = {
            time:       alarm.time,
            label:      alarm.label,
            targetDate: alarm.targetDate,
        };
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('puffs-reminder-modal');
        contentEl.createEl('h3', { text: '编辑一次性闹钟' });

        /* ── 日期输入 ── */
        new Setting(contentEl)
            .setName('日期')
            .addText(t => {
                this.dateInput = t;
                t.setValue(this.data.targetDate);
                t.setPlaceholder('YYYY-MM-DD');
                t.inputEl.style.width = '110px';
            });

        /* ── 时间输入 ── */
        new Setting(contentEl)
            .setName('时间')
            .addText(t => {
                this.timeInput = t;
                t.setValue(this.data.time);
                t.setPlaceholder('HH:MM');
                t.inputEl.style.width = '80px';
            });

        /* ── 提醒内容输入 ── */
        new Setting(contentEl)
            .setName('提醒内容')
            .addText(t => {
                this.labelInput = t;
                t.setValue(this.data.label);
                t.setPlaceholder('如：开会');
            });

        /* ── 底部操作按钮 ── */
        const footer = contentEl.createDiv({ cls: 'puffs-modal-footer' });

        const saveBtn = footer.createEl('button', { text: '保存', cls: 'mod-cta' });
        saveBtn.addEventListener('click', () => this.handleSave());

        const cancelBtn = footer.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }

    /** 保存按钮的点击处理：校验输入 → 回调通知外部 → 关闭弹窗 */
    handleSave() {
        const dateStr = this.dateInput.getValue().trim();
        const timeStr = this.timeInput.getValue().trim();
        const label   = this.labelInput.getValue().trim();

        if (!isValidDateStr(dateStr))    { new Notice('⚠️ 日期格式不正确'); return; }
        const parsed = parseTimeStr(timeStr);
        if (!parsed)                     { new Notice('⚠️ 时间格式不正确'); return; }
        if (!label)                      { new Notice('⚠️ 请输入提醒内容'); return; }

        const today = getTodayStr();
        const now = new Date();
        const currentHM = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
        const normalizedTime = pad2(parsed.h) + ':' + pad2(parsed.m);

        if (dateStr < today || (dateStr === today && normalizedTime <= currentHM)) {
            new Notice('⚠️ 闹钟时间必须在当前时间之后');
            return;
        }

        this.data.targetDate = dateStr;
        this.data.time       = normalizedTime;
        this.data.label      = label;
        this.onSave(this.data);
        this.close();
    }
}

/* ═══════════════════════════════════════════
   模块导出
   ═══════════════════════════════════════════ */
module.exports = PuffsTimerPlugin;
