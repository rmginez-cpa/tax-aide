import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";

// Conversations with the in-app Claude assistant. `messages` holds the exact
// Messages API history (user turns, assistant content blocks incl. thinking and
// tool_use, tool_result turns) so every request replays it unchanged.
export const assistantConversationsTable = pgTable("assistant_conversations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  title: text("title").notNull(),
  messages: jsonb("messages").$type<unknown[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type AssistantConversation = typeof assistantConversationsTable.$inferSelect;
