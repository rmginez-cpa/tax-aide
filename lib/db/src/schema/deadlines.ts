import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const deadlinesTable = pgTable("deadlines", {
  id: serial("id").primaryKey(),
  engagementId: integer("engagement_id"),
  clientId: integer("client_id"),
  title: text("title").notNull(),
  description: text("description"),
  dueDate: text("due_date").notNull(),
  status: text("status").notNull().default("pending"),
  priority: text("priority").notNull().default("medium"),
  // Tax year a BIR deadline was generated for (from /clients/:id/generate-deadlines).
  // Null for deadlines entered by hand and for rows created before this column existed.
  taxYear: integer("tax_year"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertDeadlineSchema = createInsertSchema(deadlinesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDeadline = z.infer<typeof insertDeadlineSchema>;
export type Deadline = typeof deadlinesTable.$inferSelect;
