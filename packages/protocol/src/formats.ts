import { z } from "zod";

export const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const TimeOfDaySchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "Expected HH:MM");
