import { z } from 'zod';
import { dateSchema } from './model.ts';

export const applicationItemSchema = z.object({
  kind: z.enum(['material', 'experience', 'certificate', 'procedure', 'other']),
  label: z.string().min(1).max(250), detail: z.string().max(1200).default(''),
  required: z.boolean().default(true), phase: z.string().max(100).default('未说明'),
  method: z.string().max(300).default(''), deadline: dateSchema.or(z.literal('')).default(''),
  evidence: z.string().min(4).max(2000),
  scope: z.enum(['notice', 'campus', 'unknown']).default('unknown'),
});
export const applicationItemsSchema = z.array(applicationItemSchema).max(60).default([]);
export const degreePolicySchema = z.object({policy:z.enum(['highest','any','unknown']).default('unknown'),evidence:z.string().max(1200).default('')}).prefault({});
export const catalogChecksSchema=z.array(z.object({level:z.enum(['专科','本科','硕士','博士']),major:z.string().max(150),decision:z.enum(['matched','excluded','unknown']),requirementEvidence:z.string().max(6000),catalogEvidence:z.string().max(6000),reason:z.string().max(1200)})).max(10).default([]);
export const sourceRowSchema=z.object({fileId:z.string().max(100),fileName:z.string().max(300),sheet:z.string().max(1200),row:z.number().int().min(1),rowId:z.string().max(200),positionCode:z.string().max(100).default('')});
export const sourcePositionSchema=z.object({education:z.string().max(1000),major:z.string().max(5000),count:z.string().max(100),location:z.string().max(1000),description:z.string().max(100000)});
export const applicationFields={catalogChecks:catalogChecksSchema,catalogContext:z.boolean().default(false),applicationItems:applicationItemsSchema,applicationCoverage:z.enum(['complete','partial','unknown']).default('unknown'),degreePolicy:degreePolicySchema,positionCode:z.string().max(100).default(''),sourceRowId:z.string().max(200).default(''),sourceRow:sourceRowSchema.optional(),sourcePosition:sourcePositionSchema.optional()};
export const applicationKindLabels={material:'提交材料',experience:'经历要求',certificate:'资格证书',procedure:'报名步骤',other:'其他要求'};
