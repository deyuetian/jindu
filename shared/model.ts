import { z } from 'zod';

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00Z`); return !isNaN(+d) && d.toISOString().slice(0,10) === v;
}, '日期不存在');
const optionalDate = z.union([dateSchema, z.literal('')]);
const urlSchema = z.string().max(2000).refine(v => { if (!v) return true; try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } }, '链接需以 http:// 或 https:// 开头');
export const stageSchema = z.object({ id: z.string().min(1).max(100), label: z.string().trim().min(1).max(60), date: dateSchema, time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).or(z.literal('')), evidence: z.string().max(500).default(''), inferredYear: z.boolean().default(false) });
export const taskSchema = z.object({ title: z.string().trim().min(1).max(160), category: z.enum(['日常','学习','考试']), due: optionalDate, time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).or(z.literal('')), priority: z.enum(['普通','重要','紧急']), done: z.boolean(), notes: z.string().max(8000), goalId: z.string().max(100).default(''), archived: z.boolean().default(false) });
export const goalSchema = z.object({ title: z.string().trim().min(1).max(160), total: z.number().finite().positive('目标总量须大于 0').max(10000000), completed: z.number().finite().min(0).max(10000000), unit: z.string().trim().min(1).max(12), due: optionalDate, notes: z.string().max(8000), archived: z.boolean().default(false) }).refine(x => x.completed <= x.total, '已完成量不能大于目标量');
export const examSchema = z.object({ title: z.string().trim().min(1).max(200), province: z.string().max(30), type: z.enum(['公务员','选调','其他']), url: urlSchema, notes: z.string().max(8000), stages: z.array(stageSchema).max(40), archived: z.boolean().default(false), announcementId: z.string().max(120).default('') });
export const announcementSchema = z.object({ title: z.string().trim().min(1).max(300), body: z.string().max(100000), url: urlSchema, published: optionalDate, province: z.string().max(30), type: z.enum(['公务员','选调','其他']), candidates: z.array(stageSchema).max(40), status: z.enum(['pending','accepted','ignored']), source: z.string().max(100), contentHash: z.string().max(100).default(''), needsReview: z.boolean().default(false) });
export type Stage = z.infer<typeof stageSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type Exam = z.infer<typeof examSchema>;
export type Announcement = z.infer<typeof announcementSchema>;
export type Kind = 'task'|'goal'|'exam'|'announcement';
export type RecordData = Task|Goal|Exam|Announcement;
export type Row<T> = T & { id: string; version: number; updatedAt: string };
export interface Snapshot { tasks: Row<Task>[]; goals: Row<Goal>[]; exams: Row<Exam>[]; announcements: Row<Announcement>[]; source: SourceStatus; preview: boolean; }
export interface SourceStatus { lastAttempt?: string; lastSuccess?: string; error?: string; collected?: number; running?: boolean; partial?: boolean; cursor?: number; scanned?: number; }
export const schemas = { task: taskSchema, goal: goalSchema, exam: examSchema, announcement: announcementSchema };
// Reuse the ICU formatter: constructing it on every worker tick retains native memory.
const dateCNFormatter = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
export function todayCN(now = new Date()): string { return dateCNFormatter.format(now); }
export function daysUntil(date: string, now = todayCN()): number { return Math.round((Date.parse(date+'T00:00:00Z')-Date.parse(now+'T00:00:00Z'))/86400000); }
export function deadlineText(date:string):string { const n=daysUntil(date);return n<0?`已过 ${-n} 天`:n===0?'今天':n===1?'明天':`${n} 天后`; }
export function isOverdue(date:string,time=''):boolean { if(!date)return false;return Date.now()>Date.parse(`${date}T${time||'23:59'}:59+08:00`); }
