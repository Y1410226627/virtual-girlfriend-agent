// 心动指数（dokidoki）：由现有关系数值推导的一个安静小指标
// 设计要点：纯函数、无副作用；数值升高指数不降（单调），未解张力扣分；阶段决定能到达的上限。
import { clamp, round1 } from './utils';

export interface DokiInput {
  /** 亲密度 0..100 */
  intimacy?: number;
  /** 信任 0..100 */
  trust?: number;
  /** 情感余额 -100..100 */
  emotional_balance?: number;
  /** 修复信用 0..100 */
  repair_credit?: number;
  /** 未解决张力 0..100（扣分项） */
  unresolved_tension?: number;
  /** 关系阶段 0..4 */
  stage?: number;
}

export interface DokiBreakdownItem {
  key: string;
  label: string;
  /** 0..1，分项进度条的填充比例（张力项也按 0..1 展示） */
  value: number;
  /** 该分项在总分里的权重（张力为负） */
  weight: number;
  /** 对总分的实际贡献（分；张力为负） */
  points: number;
}

export interface DokiBreakdown {
  intimacy: DokiBreakdownItem;
  trust: DokiBreakdownItem;
  balance: DokiBreakdownItem;
  repair: DokiBreakdownItem;
  tension: DokiBreakdownItem;
}

export interface Doki {
  /** 1..8 */
  level: number;
  title: string;
  /** 当前等级内的进度 0..100 */
  progress: number;
  /** 综合分 0..100 */
  score: number;
  /** 一句话状态 */
  note: string;
  /** 是否被关系阶段限制在更低的等级（心里很心动，但关系还没走到那一步） */
  stageCapped: boolean;
  breakdown: DokiBreakdown;
}

export interface DokiLevelDef {
  title: string;
  note: string;
}

/** 8 档，命名温柔、有层次 */
export const DOKI_LEVELS: DokiLevelDef[] = [
  { title: '初识', note: '还在互相打量，慢慢来。' },
  { title: '有点在意', note: '会留意你在不在。' },
  { title: '心动萌芽', note: '心里悄悄种下一点。' },
  { title: '心动', note: '见到你会有一点雀跃。' },
  { title: '很喜欢', note: '喜欢得有点藏不住。' },
  { title: '眷恋', note: '开始把你放进了以后。' },
  { title: '深情', note: '你已经是她日常的一部分。' },
  { title: '心安', note: '你在，就好。' },
];

/** 每档的分数带宽 */
const BAND = 100 / DOKI_LEVELS.length;

/** 各阶段能到达的最高档（初识期再心动也到不了"心动"） */
const STAGE_CAP = [2, 4, 6, 8, 8];

const W_INTIMACY = 0.45;
const W_TRUST = 0.25;
const W_BALANCE = 0.2;
const W_REPAIR = 0.1;
const W_TENSION = 0.22;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function levelDef(level: number): DokiLevelDef {
  return DOKI_LEVELS[level - 1] ?? DOKI_LEVELS[0] ?? { title: '初识', note: '' };
}

function stageCapOf(stage: unknown): number {
  const s = clamp(Math.round(num(stage)), 0, STAGE_CAP.length - 1);
  return STAGE_CAP[s] ?? DOKI_LEVELS.length;
}

/** 由现有数值计算心动指数（纯函数） */
export function computeDoki(input: DokiInput): Doki {
  const intimacy = clamp(num(input.intimacy), 0, 100);
  const trust = clamp(num(input.trust), 0, 100);
  const balance01 = (clamp(num(input.emotional_balance), -100, 100) + 100) / 2; // 0..100
  const repair = clamp(num(input.repair_credit), 0, 100);
  const tension = clamp(num(input.unresolved_tension), 0, 100);

  const intimacyPt = intimacy * W_INTIMACY;
  const trustPt = trust * W_TRUST;
  const balancePt = balance01 * W_BALANCE;
  const repairPt = repair * W_REPAIR;
  const tensionPenalty = tension * W_TENSION;

  const raw = intimacyPt + trustPt + balancePt + repairPt - tensionPenalty;
  const score = clamp(raw, 0, 100);

  const naturalLevel = clamp(1 + Math.floor(score / BAND), 1, DOKI_LEVELS.length);
  const cap = stageCapOf(input.stage);
  const level = Math.min(naturalLevel, cap);
  const stageCapped = naturalLevel > level;

  const bandMin = (level - 1) * BAND;
  const progress = clamp(((score - bandMin) / BAND) * 100, 0, 100);

  const def = levelDef(level);
  let note = def.note;
  if (tension >= 60) note = '心里有点悬着的事，还没说开。';
  else if (stageCapped) note = '她很心动，只是关系还没走到那一步。';

  const breakdown: DokiBreakdown = {
    intimacy: { key: 'intimacy', label: '亲密度', value: intimacy / 100, weight: W_INTIMACY, points: round1(intimacyPt) },
    trust: { key: 'trust', label: '信任', value: trust / 100, weight: W_TRUST, points: round1(trustPt) },
    balance: { key: 'balance', label: '情感余额', value: balance01 / 100, weight: W_BALANCE, points: round1(balancePt) },
    repair: { key: 'repair', label: '修复信用', value: repair / 100, weight: W_REPAIR, points: round1(repairPt) },
    tension: { key: 'tension', label: '未解张力', value: tension / 100, weight: -W_TENSION, points: -round1(tensionPenalty) },
  };

  return { level, title: def.title, progress, score: round1(score), note, stageCapped, breakdown };
}