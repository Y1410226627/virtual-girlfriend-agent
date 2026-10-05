'use client';

import { useEffect, useRef, useState } from 'react';
import { useApi, PageHeader, Loading, ErrorBox, Toast } from '@/components/ui';
import { errMsg } from '@/lib/utils';
import type { SettingsResponse, EffectiveInfo, ProfileForm, ProfileTestResult, CustomValues, PingResult } from '@/components/settings/shared';
import { AppearanceCard } from '@/components/settings/AppearanceCard';
import { ModelProfileCard } from '@/components/settings/ModelProfileCard';
import { AdvancedApiCard } from '@/components/settings/AdvancedApiCard';
import { SceneCard } from '@/components/settings/SceneCard';
import { LifeIntimacyCard } from '@/components/settings/LifeIntimacyCard';
import { CustomModeCard } from '@/components/settings/CustomModeCard';
import { IdentityCard } from '@/components/settings/IdentityCard';
import { ProactiveCard } from '@/components/settings/ProactiveCard';
import { NotificationCard } from '@/components/settings/NotificationCard';
import { VoiceCard } from '@/components/settings/VoiceCard';
import { PhotoCard } from '@/components/settings/PhotoCard';
import { PacingCard } from '@/components/settings/PacingCard';
import { PrivacyCard } from '@/components/settings/PrivacyCard';
import { AboutCard } from '@/components/settings/AboutCard';

export default function SettingsPage() {
  const { data, loading, error, reload } = useApi<SettingsResponse>('/api/settings');
  const [form, setForm] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [ping, setPing] = useState<PingResult | null>(null);
  const [pinging, setPinging] = useState(false);
  const [saving, setSaving] = useState(false);
  // 用户改过的字段（未保存前，后台 reload 只跳过这些字段，其余照常回填）
  const dirtyRef = useRef<Set<string>>(new Set());
  const [pf, setPf] = useState<ProfileForm>({ label: '', base_url: '', api_key: '', chat_model: '', analysis_model: '', note: '' });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, ProfileTestResult>>({});
  // 自定义模式（数值直控）
  const [cv, setCv] = useState<CustomValues | null>(null);
  // 外观主题：'light' | 'dark'（默认跟随系统，由 layout 的初始化脚本决定）
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  // 桌面通知开关：null = 尚未在客户端读取（SSR 占位）
  const [notifySupported, setNotifySupported] = useState<boolean | null>(null);
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermission>('default');
  const [notifyOn, setNotifyOn] = useState(false);
  // 语音试听是否进行中
  const [ttsTesting, setTtsTesting] = useState(false);

  // 客户端读取通知能力 / 权限 / 开关（SSR 安全）
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotifySupported(false);
      return;
    }
    setNotifySupported(true);
    setNotifyPerm(Notification.permission);
    try {
      setNotifyOn(window.localStorage.getItem('notify_enabled') === '1' && Notification.permission === 'granted');
    } catch {
      setNotifyOn(false);
    }
  }, []);

  // 读取当前实际生效的主题（<html> 上的 dark class 才是真相）
  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  // 立即切换并持久化；下次打开由 layout 的初始化脚本读取
  const applyTheme = (t: 'light' | 'dark') => {
    setTheme(t);
    try {
      window.localStorage.setItem('theme', t);
    } catch {
      /* ignore */
    }
    document.documentElement.classList.toggle('dark', t === 'dark');
  };

  // 通知开关：开启时申请权限；关闭时只写本地开关
  const toggleNotify = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setToast('当前浏览器不支持通知');
      return;
    }
    if (notifyOn) {
      try {
        window.localStorage.setItem('notify_enabled', '0');
      } catch {
        /* ignore */
      }
      setNotifyOn(false);
      setToast('已关闭桌面通知');
      return;
    }
    let perm: NotificationPermission = Notification.permission;
    try {
      perm = await Notification.requestPermission();
    } catch {
      /* ignore */
    }
    setNotifyPerm(perm);
    if (perm === 'granted') {
      try {
        window.localStorage.setItem('notify_enabled', '1');
      } catch {
        /* ignore */
      }
      setNotifyOn(true);
      setToast('已开启：她不看页面时发消息会在后台提醒你');
    } else if (perm === 'denied') {
      setToast('浏览器里拒绝了通知权限，需要在浏览器设置里允许');
    } else {
      setToast('还没有授予通知权限');
    }
  };

  const loadCv = async () => {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const j = await r.json();
      setCv({
        intimacy: j?.relationship?.intimacy ?? 0,
        trust: j?.relationship?.trust ?? 0,
        emotional_balance: j?.relationship?.emotional_balance ?? 0,
        unresolved_tension: j?.relationship?.unresolved_tension ?? 0,
        repair_credit: j?.relationship?.repair_credit ?? 0,
        mood: j?.relationship?.mood ?? '',
        stage: Number(j?.relationship?.stage ?? 0),
        personality: { ...(j?.personality?.values || {}) },
        anxiety: j?.attachment?.anxiety ?? 30,
        avoidance: j?.attachment?.avoidance ?? 30,
        libido: j?.intimacy?.libido ?? 0,
        intimacy_need: j?.intimacy?.need ?? 0,
        sexual_satisfaction: j?.intimacy?.satisfaction ?? 0,
        sexual_stress: j?.intimacy?.stress ?? 0,
      });
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (data?.settings) {
      const f: Record<string, string> = { ...data.settings };
      // 名字/共同故事以 personas 为准（settings 里那份是历史镜像，可能恒为空 → 否则"保存"会把名字抹掉）
      if (data.persona?.agent_name) f.agent_name = data.persona.agent_name;
      if (data.persona?.self_story) f.agent_story = data.persona.self_story;
      // 已改过但还没保存的字段保留用户当前输入，其余回填服务端值
      setForm((prev) => {
        const next: Record<string, string> = { ...f };
        for (const k of dirtyRef.current) {
          if (prev[k] !== undefined) next[k] = prev[k];
        }
        return next;
      });
    }
  }, [data]);

  useEffect(() => {
    void loadCv();
  }, []);

  const set = (k: string, v: string) => {
    dirtyRef.current.add(k);
    setForm((s) => ({ ...s, [k]: v }));
  };

  // 保存：永远只提交该卡片自己负责的字段（keys 由调用方显式给出），
  // overrides 用于提交"目标值"（避开 setState 异步导致的旧值回写）。
  // 返回是否成功，便于调用方决定后续动作。
  const save = async (
    keys: string[],
    msg = '已保存',
    overrides?: Record<string, string>
  ): Promise<boolean> => {
    setSaving(true);
    const payload: Record<string, string> = {};
    for (const k of keys) {
      const v = overrides && Object.prototype.hasOwnProperty.call(overrides, k) ? overrides[k] : form[k];
      if (v === undefined || v === null) continue;
      payload[k] = v;
    }
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: payload }),
      });
      if (!r.ok) throw new Error(`保存失败 ${r.status}`);
      const j = await r.json().catch(() => ({}));
      // 服务端对非法值（URL / 时间格式 / 非数字等）会静默跳过，不进 changed。
      // 这里如实提示被跳过的字段，避免"部分保存"被谎报成"已保存"。
      // *_api_key 为空/掩码时按"不修改"处理属预期行为，不视为失败。
      const changed: string[] = Array.isArray(j?.changed) ? j.changed : [];
      const skipped = Object.keys(payload).filter((k) => !changed.includes(k) && !k.endsWith('_api_key'));
      setToast(j?.error ? j.error : skipped.length ? `部分设置未保存（格式不正确）：${skipped.join('、')}` : msg);
      // 只清除本次保存的字段；其它卡片未保存的草稿继续保留
      for (const k of keys) dirtyRef.current.delete(k);
      reload();
      return true;
    } catch (e) {
      setToast(`保存失败：${errMsg(e)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  // 语音试听：调 /api/tts 拿 mp3 直接播（读取的是已保存的配置，所以要先保存再试听）
  const testTts = async () => {
    setTtsTesting(true);
    try {
      const r = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '嗨，能听到我说话吗？我是你的她呀。' }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setToast(j?.error || '试听失败');
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      a.onerror = () => URL.revokeObjectURL(url);
      await a.play();
      setToast('正在试听…（试听用的是已保存的配置）');
    } catch (e) {
      setToast(`试听失败：${errMsg(e)}`);
    } finally {
      setTtsTesting(false);
    }
  };

  const runPing = async () => {
    setPinging(true);
    setPing(null);
    try {
      const r = await fetch('/api/ping');
      setPing(await r.json());
    } catch (e) {
      setToast(`自检失败：${errMsg(e)}`);
    } finally {
      setPinging(false);
    }
  };

  const profilePost = async (body: Record<string, unknown>, reloadAfter = true) => {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    // 只读操作（如测试连接）不 reload：避免无谓地覆盖表单
    if (reloadAfter) reload();
    return j;
  };

  const testProfile = async (id: number) => {
    setTesting(id);
    setTestResults((s) => ({ ...s, [id]: { pending: true } }));
    const j = await profilePost({ action: 'test_profile', id, timeoutMs: 15000 }, false);
    setTestResults((s) => ({ ...s, [id]: j.result }));
    setTesting(null);
  };

  const download = async () => {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'export' }),
    });
    const j = await r.json();
    const blob = new Blob([JSON.stringify(j.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `虚拟女友-数据导出-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setToast('已导出为 JSON 文件');
  };

  const reset = async (keepSettings: boolean) => {
    const tip = keepSettings
      ? '确定清空所有聊天记录、记忆、性格、依恋与关系数据吗？（设置会保留）'
      : '确定恢复到出厂状态吗？设置也会被清空。';
    if (!confirm(tip)) return;
    // 恢复出厂（连设置一起清）不可逆：二次确认，必须输入 RESET 才继续
    if (!keepSettings) {
      const typed = prompt('此操作不可逆。请输入 RESET 以确认恢复出厂状态（直接取消或输入其他内容将中止）：');
      if (typed === null || typed.trim() !== 'RESET') {
        setToast('已取消恢复出厂状态');
        return;
      }
    }
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset', keepSettings, confirm: 'RESET' }),
    });
    const j = await r.json();
    setToast(j?.message || '已重置');
    reload();
  };

  if (loading && !data) return <Loading text="正在读设置…" />;
  // 仅初次加载就失败才整页替换；已有数据时用顶部横幅提示，保留已加载内容可继续查看/操作
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;

  const eff: Partial<EffectiveInfo> = data?.effective || {};
  // 自定义模式开关：'1' 和 'true' 都算开启（历史数据可能存成 true）
  const customOn = form.custom_mode === '1' || form.custom_mode === 'true';
  // 通知状态文案（notifySupported 为 null 表示还在客户端读取中）
  const notifyStatusText =
    notifySupported === null
      ? '读取中…'
      : !notifySupported
        ? '浏览器不支持'
        : notifyOn
          ? '已开启'
          : notifyPerm === 'denied'
            ? '已被浏览器拒绝'
            : '未开启';

  return (
    <div className="pb-10">
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}
      <PageHeader title="设置" desc="模型、身份、主动消息、隐私。所有数据都存在你自己电脑上。" />

      <div className="space-y-4 px-5 md:px-8">
        <AppearanceCard theme={theme} onApplyTheme={applyTheme} />

        <ModelProfileCard
          data={data}
          pinging={pinging}
          onRunPing={runPing}
          testResults={testResults}
          testing={testing}
          profilePost={profilePost}
          testProfile={testProfile}
          editingId={editingId}
          setEditingId={setEditingId}
          pf={pf}
          setPf={setPf}
          setToast={setToast}
        />

        <AdvancedApiCard form={form} set={set} save={save} saving={saving} eff={eff} profilePost={profilePost} ping={ping} setToast={setToast} />

        <SceneCard form={form} save={save} />

        <LifeIntimacyCard form={form} set={set} save={save} saving={saving} />

        <CustomModeCard customOn={customOn} setForm={setForm} setToast={setToast} cv={cv} setCv={setCv} loadCv={loadCv} save={save} profilePost={profilePost} />

        <IdentityCard form={form} set={set} save={save} saving={saving} />

        <ProactiveCard form={form} set={set} save={save} saving={saving} setToast={setToast} reload={reload} />

        <NotificationCard notifyStatusText={notifyStatusText} notifyOn={notifyOn} toggleNotify={toggleNotify} notifyPerm={notifyPerm} notifySupported={notifySupported} />

        <VoiceCard form={form} set={set} save={save} saving={saving} testTts={testTts} ttsTesting={ttsTesting} />

        <PhotoCard form={form} set={set} save={save} saving={saving} />

        <PacingCard form={form} set={set} save={save} saving={saving} />

        <PrivacyCard download={download} reset={reset} setToast={setToast} reload={reload} />

        <AboutCard />
      </div>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}