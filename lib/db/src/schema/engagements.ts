import { pgTable, text, serial, timestamp, integer, boolean, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const engagementsTable = pgTable("engagements", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull(),
  title: text("title").notNull(),
  taxType: text("tax_type").notNull(),
  period: text("period").notNull(),
  fiscalYear: text("fiscal_year"),
  status: text("status").notNull().default("pending"),
  assignedTo: integer("assigned_to"),
  approvedBy: integer("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvalNotes: text("approval_notes"),
  dueDate: text("due_date"),
  notes: text("notes"),
  workflowStage: text("workflow_stage"), // kept for compat / document stage tagging
  // Per-stage independent statuses: not_started | in_progress | for_review | approved
  sourceCollectionStatus: text("source_collection_status").notNull().default("not_started"),
  draftReturnStatus: text("draft_return_status").notNull().default("not_started"),
  confirmationStatus: text("confirmation_status").notNull().default("not_started"),
  paymentStatus: text("payment_status").notNull().default("not_started"),
  // Tax payable amount entered at Stage 2 (draft return). null = not yet entered (treat as unknown, Stage 4 required).
  // 0 = no tax due (Stage 4 becomes "not_applicable"). > 0 = Stage 4 required.
  taxPayable: numeric("tax_payable", { precision: 15, scale: 2 }),
  isAmendment: boolean("is_amendment").notNull().default(false),
  amendedEngagementId: integer("amended_engagement_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertEngagementSchema = createInsertSchema(engagementsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertEngagement = z.infer<typeof insertEngagementSchema>;
export type Engagement = typeof engagementsTable.$inferSelect;
