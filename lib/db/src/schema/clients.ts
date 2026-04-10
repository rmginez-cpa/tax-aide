import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const clientsTable = pgTable("clients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  tin: text("tin").notNull().unique(),
  businessType: text("business_type").notNull(),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  address: text("address"),
  fiscalYearEnd: text("fiscal_year_end"),
  status: text("status").notNull().default("active"),

  // BIR 2303 Certificate of Registration fields
  tradeName: text("trade_name"),
  rdoCode: text("rdo_code"),
  registrationDate: text("registration_date"),
  lineOfBusiness: text("line_of_business"),

  // Registered tax types (determines auto-generated deadlines)
  incomeTaxType: text("income_tax_type"),        // 'individual' (1701) | 'corporate' (1702)
  vatRegistered: boolean("vat_registered").notNull().default(false),             // 2550M/2550Q
  percentageTaxRegistered: boolean("percentage_tax_registered").notNull().default(false), // 2551Q (non-VAT)
  withholdsCompensation: boolean("withholds_compensation").notNull().default(false), // 1601C monthly
  withholdsEwt: boolean("withholds_ewt").notNull().default(false),               // 1601EQ quarterly
  subjectToDst: boolean("subject_to_dst").notNull().default(false),              // 2000 monthly
  fiscalYearStart: text("fiscal_year_start"),    // Starting month of fiscal year (e.g. "January")

  // Additional compliance requirements
  hasInventory: boolean("has_inventory").notNull().default(false),               // Annual Inventory List (Jan 30)
  isLessor: boolean("is_lessor").notNull().default(false),                       // Lessee Info Statement (Jan 31)
  isEsalesRequired: boolean("is_esales_required").notNull().default(false),      // eSales Report (monthly)

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertClientSchema = createInsertSchema(clientsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clientsTable.$inferSelect;
