import { PrismaClient, type Prisma } from "@prisma/client";
const g = globalThis as unknown as { prisma?: PrismaClient };
export const db = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.prisma = db;

/** Escape hatch for Json columns: validates at runtime boundary (zod), stores as JSON. */
export const J = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;
